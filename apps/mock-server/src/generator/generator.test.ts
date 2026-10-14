import { type JsonValue, LOG_LEVELS, type LogEvent, parseServerMessage } from '@lsv/protocol';
import { describe, expect, it } from 'vitest';

import { createGenerator, LEVEL_MIX } from './generator.ts';
import { ERROR_BURST, TRAFFIC_SPIKE } from './scenarios.ts';
import { SERVICES } from './services.ts';

const T0 = 1_791_979_200_000;

/** `count` events in batches of `perTick`, one tick every 50 ms from T0. */
function generate(seed: number, count: number, perTick = 500): LogEvent[] {
  const generator = createGenerator({ seed, scenario: 'steady', startedAt: T0 });
  const events: LogEvent[] = [];
  for (let tick = 1; events.length < count; tick++) {
    events.push(...generator.next(Math.min(perTick, count - events.length), T0 + tick * 50));
  }
  return events;
}

function share(events: readonly LogEvent[], predicate: (event: LogEvent) => boolean): number {
  return events.filter(predicate).length / events.length;
}

function isJsonObject(value: JsonValue | undefined): value is Readonly<Record<string, JsonValue>> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** A field of a JSON object, or `undefined` when `value` is not an object. */
function member(value: JsonValue | undefined, key: string): JsonValue | undefined {
  return isJsonObject(value) ? value[key] : undefined;
}

describe('level mix on 100K events', () => {
  const events = generate(42, 100_000);

  it.each(LOG_LEVELS)('keeps %s within one percentage point of LEVEL_MIX', (level) => {
    const actual = share(events, (event) => event.level === level);
    expect(Math.abs(actual - LEVEL_MIX[level])).toBeLessThan(0.01);
  });
});

describe('service mix', () => {
  const events = generate(7, 50_000);
  const totalWeight = SERVICES.reduce((sum, service) => sum + service.weight, 0);

  it.each(SERVICES)('gives $name its share of the traffic', (service) => {
    const actual = share(events, (event) => event.service === service.name);
    expect(Math.abs(actual - service.weight / totalWeight)).toBeLessThan(0.015);
  });
});

describe('createGenerator', () => {
  it('reproduces the same events for the same seed and calls', () => {
    expect(generate(42, 2000)).toEqual(generate(42, 2000));
  });

  it('produces the same content for a seed however the calls are chunked (only ts differ)', () => {
    const content = (events: readonly LogEvent[]) =>
      events.map((event) => [
        event.seq,
        event.level,
        event.service,
        event.host,
        event.message,
        event.traceId,
        event.payload,
      ]);
    expect(content(generate(42, 3000, 97))).toEqual(content(generate(42, 3000, 500)));
  });

  it('produces a different stream for another seed', () => {
    const a = generate(42, 200).map((event) => event.message);
    const b = generate(43, 200).map((event) => event.message);
    expect(a).not.toEqual(b);
  });

  it('numbers events consecutively from 1 across calls', () => {
    const events = generate(1, 1234, 97);
    expect(events.map((event) => event.seq)).toEqual(
      Array.from({ length: 1234 }, (_, index) => index + 1),
    );
  });

  it('assigns sequence numbers to skipped events, leaving a gap', () => {
    const generator = createGenerator({ seed: 1, scenario: 'steady', startedAt: T0 });
    expect(generator.lastSeq).toBe(0);
    generator.next(3, T0 + 50);
    generator.skip(10, T0 + 100);
    expect(generator.lastSeq).toBe(13);
    expect(generator.next(2, T0 + 150).map((event) => event.seq)).toEqual([14, 15]);
    generator.skip(0, T0 + 200);
    expect(generator.lastSeq).toBe(15);
  });

  it('spreads timestamps evenly up to the time of the call', () => {
    const generator = createGenerator({ seed: 1, scenario: 'steady', startedAt: T0 });
    const first = generator.next(5, T0 + 50).map((event) => event.ts);
    expect(first).toEqual([T0 + 10, T0 + 20, T0 + 30, T0 + 40, T0 + 50]);
    const second = generator.next(2, T0 + 100).map((event) => event.ts);
    expect(second).toEqual([T0 + 75, T0 + 100]);
    // A clock that goes backwards does not move timestamps back.
    expect(generator.next(2, T0 + 90).map((event) => event.ts)).toEqual([T0 + 100, T0 + 100]);
  });

  it('starts the clock at the first call when no start time is given', () => {
    const generator = createGenerator({ seed: 1, scenario: 'traffic-spike' });
    expect(generator.next(2, T0).map((event) => event.ts)).toEqual([T0, T0]);
    expect(generator.rateMultiplier(T0 + TRAFFIC_SPIKE.startMs)).toBe(TRAFFIC_SPIKE.rateMultiplier);
  });

  it('emits events that pass the protocol parser and survive a JSON round trip', () => {
    const events = generate(3, 5000);
    const raw = JSON.stringify({ type: 'batch', sentAt: T0, events });
    const parsed = parseServerMessage(raw);
    expect(parsed.ok).toBe(true);
    expect(JSON.parse(raw)).toEqual({ type: 'batch', sentAt: T0, events });
  });

  it('names hosts after their service and instance', () => {
    for (const event of generate(5, 2000)) {
      expect(event.host).toMatch(new RegExp(`^${event.service}-[0-9a-f]{4}-\\d$`));
    }
  });

  it('attaches stack traces to errors and fatals', () => {
    const failures = generate(9, 20_000).filter(
      (event) => event.level === 'error' || event.level === 'fatal',
    );
    expect(failures.length).toBeGreaterThan(0);
    for (const event of failures) {
      const error = member(event.payload, 'error');
      const name = member(error, 'name');
      const stack = member(error, 'stack');
      expect(name).toMatch(/^\w+Error$/);
      expect(stack).toMatch(/^\w+Error: .+\n {4}at /);
      expect(typeof stack === 'string' && typeof name === 'string' && stack.startsWith(name)).toBe(
        true,
      );
    }
  });

  it('describes gateway requests with HTTP details and a latency', () => {
    const requests = generate(11, 5000).filter(
      (event) => event.service === 'api-gateway' && event.level === 'info',
    );
    expect(requests.length).toBeGreaterThan(100);
    for (const event of requests) {
      const http = member(event.payload, 'http');
      expect(member(http, 'method')).toMatch(/^(GET|POST|PUT)$/);
      expect(member(http, 'path')).toMatch(/^\/api\//);
      expect(member(http, 'status')).toBeTypeOf('number');
      expect(member(event.payload, 'latencyMs')).toBeLessThan(1000);
      expect(member(event.payload, 'userId')).toMatch(/^u_\d+$/);
      expect(event.message).toMatch(/^[A-Z]+ \/api\/\S* \d{3} in \d+ ms$/);
    }
  });

  it('correlates trace ids across services', () => {
    const traced = generate(13, 5000).filter((event) => event.traceId !== undefined);
    expect(traced.length).toBeGreaterThan(3000);
    for (const event of traced) expect(event.traceId).toMatch(/^[0-9a-f]{32}$/);
    const servicesByTrace = new Map<string, Set<string>>();
    for (const event of traced) {
      const traceId = event.traceId ?? '';
      const services = servicesByTrace.get(traceId) ?? new Set<string>();
      services.add(event.service);
      servicesByTrace.set(traceId, services);
    }
    expect([...servicesByTrace.values()].some((services) => services.size > 1)).toBe(true);
  });

  it('turns about 30% of one service into errors during an error burst', () => {
    const start = T0;
    const generator = createGenerator({ seed: 42, scenario: 'error-burst', startedAt: start });
    const calm = generator.next(20_000, start + 1000);
    const burst = generator.next(20_000, start + ERROR_BURST.startMs + 1000);

    const errorShareByService = (events: readonly LogEvent[]) =>
      SERVICES.map((service) => {
        const own = events.filter((event) => event.service === service.name);
        return share(own, (event) => event.level === 'error');
      });
    const before = errorShareByService(calm);
    const during = errorShareByService(burst);
    const bursting = during.filter((value) => value > 0.25);
    expect(bursting).toHaveLength(1);
    expect(bursting[0]).toBeLessThan(0.4);
    expect(before.every((value) => value < 0.1)).toBe(true);
  });

  it('reports the traffic-spike multiplier and restarts the scenario on a switch', () => {
    const generator = createGenerator({ seed: 1, scenario: 'steady', startedAt: T0 });
    expect(generator.rateMultiplier(T0 + TRAFFIC_SPIKE.startMs)).toBe(1);
    generator.setScenario('traffic-spike', T0 + 60_000);
    expect(generator.scenario).toBe('traffic-spike');
    expect(generator.rateMultiplier(T0 + 60_000)).toBe(1);
    expect(generator.rateMultiplier(T0 + 60_000 + TRAFFIC_SPIKE.startMs)).toBe(
      TRAFFIC_SPIKE.rateMultiplier,
    );
  });

  it('makes requests slower during a traffic spike', () => {
    const latencies = (events: readonly LogEvent[]) => {
      const values = events
        .map((event) => event.payload?.latencyMs)
        .filter((value): value is number => typeof value === 'number')
        .sort((a, b) => a - b);
      return values[Math.floor(values.length / 2)] ?? 0;
    };
    const generator = createGenerator({ seed: 2, scenario: 'traffic-spike', startedAt: T0 });
    const calm = latencies(generator.next(10_000, T0 + 1000));
    const spike = latencies(generator.next(10_000, T0 + TRAFFIC_SPIKE.startMs + 1000));
    expect(spike).toBeGreaterThan(calm * 1.5);
  });
});
