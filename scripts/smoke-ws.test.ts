import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { describe, it } from 'node:test';

import { WebSocketServer } from 'ws';

import {
  checkHealth,
  closeFailure,
  DEFAULT_TIMEOUT_MS,
  handshakeFailure,
  parseSmokeArgs,
  runSmoke,
  type SmokeOptions,
  StreamProbe,
} from './smoke-ws.ts';

const fixture = (name: string): string =>
  readFileSync(new URL(import.meta.resolve(`@lsv/protocol/fixtures/v1/${name}`)), 'utf8');

function parsedArgs(args: string[]): SmokeOptions {
  const result = parseSmokeArgs(args);
  if (!result.ok) throw new Error(result.error);
  return result.value;
}

function argsError(args: string[]): string {
  const result = parseSmokeArgs(args);
  if (result.ok) throw new Error(`expected ${JSON.stringify(args)} to be rejected`);
  return result.error;
}

describe('parseSmokeArgs', () => {
  it('derives the stream and health URLs and applies defaults', () => {
    assert.deepEqual(parsedArgs(['ws://localhost:8080/ws']), {
      streamUrl: 'ws://localhost:8080/ws?v=1',
      healthUrl: 'http://localhost:8080/healthz',
      origin: undefined,
      expectVersion: undefined,
      timeoutMs: DEFAULT_TIMEOUT_MS,
    });
  });

  it('reads every option and maps wss to https', () => {
    assert.deepEqual(
      parsedArgs([
        'wss://log-stream-viewer-mock.fly.dev/ws',
        '--origin',
        'https://log-stream-viewer.example.dev',
        '--expect-version=0123abc',
        '--timeout',
        '5000',
      ]),
      {
        streamUrl: 'wss://log-stream-viewer-mock.fly.dev/ws?v=1',
        healthUrl: 'https://log-stream-viewer-mock.fly.dev/healthz',
        origin: 'https://log-stream-viewer.example.dev',
        expectVersion: '0123abc',
        timeoutMs: 5000,
      },
    );
  });

  it('keeps an explicit version and other query parameters', () => {
    const options = parsedArgs(['ws://127.0.0.1:8787/ws?rate=50&v=2']);
    assert.equal(options.streamUrl, 'ws://127.0.0.1:8787/ws?rate=50&v=2');
    assert.equal(options.healthUrl, 'http://127.0.0.1:8787/healthz');
    assert.equal(parsedArgs(['ws://h/ws?rate=50']).streamUrl, 'ws://h/ws?rate=50&v=1');
  });

  it('rejects a missing, repeated or non-WebSocket URL', () => {
    assert.match(argsError([]), /exactly one WebSocket URL, got 0/);
    assert.match(argsError(['ws://a/ws', 'ws://b/ws']), /exactly one WebSocket URL, got 2/);
    assert.match(argsError(['https://a.dev/ws']), /not a ws:\/\/ or wss:\/\/ URL/);
    assert.match(argsError(['not a url']), /not a ws:\/\/ or wss:\/\/ URL/);
  });

  it('rejects bad option values and unknown options', () => {
    for (const timeout of ['0', '1.5', 'soon', '600001']) {
      assert.match(argsError(['ws://a/ws', '--timeout', timeout]), /--timeout must be/);
    }
    assert.match(argsError(['ws://a/ws', '--origin', 'https://a.dev/']), /--origin must be/);
    assert.match(argsError(['ws://a/ws', '--origin', 'a.dev']), /--origin must be/);
    assert.match(argsError(['ws://a/ws', '--expect-version', ' ']), /must not be empty/);
    assert.match(argsError(['ws://a/ws', '--retries', '3']), /--retries/);
  });
});

describe('checkHealth', () => {
  const body = JSON.stringify({ status: 'ok', version: 'abc', uptimeS: 3, connections: 0 });

  it('accepts status ok with the expected version', () => {
    const result = checkHealth(200, body, 'abc');
    assert.ok(result.ok);
    assert.equal(result.value.version, 'abc');
    assert.equal(result.value.body.uptimeS, 3);
    assert.ok(checkHealth(200, body, undefined).ok);
  });

  it('reports a different version, an HTTP error and an unexpected body', () => {
    assert.deepEqual(checkHealth(200, body, 'def'), {
      ok: false,
      error: 'version is "abc", expected "def"',
    });
    assert.deepEqual(checkHealth(503, 'starting\n', undefined), {
      ok: false,
      error: 'HTTP 503: starting',
    });
    assert.deepEqual(checkHealth(200, '<html>', undefined), {
      ok: false,
      error: 'not JSON: <html>',
    });
    assert.deepEqual(checkHealth(200, '{"status":"ok"}', undefined), {
      ok: false,
      error: 'expected { status: "ok", version }, got {"status":"ok"}',
    });
    assert.equal(checkHealth(200, '[1]', undefined).ok, false);
  });
});

describe('StreamProbe', () => {
  it('waits for hello, skips heartbeats and finishes on the first batch', () => {
    const probe = new StreamProbe();
    assert.deepEqual(probe.receive(fixture('hello.json')), { kind: 'waiting' });
    assert.equal(probe.hello?.streamId, 'st_01JA2R7QK3M9X4V8T6');
    assert.deepEqual(probe.receive(fixture('heartbeat.json')), { kind: 'waiting' });
    assert.deepEqual(probe.receive(fixture('invalid-server-unknown-type.json')), {
      kind: 'waiting',
    });
    const step = probe.receive(fixture('batch.json'));
    if (step.kind !== 'done') throw new Error(`expected done, got ${step.kind}`);
    assert.ok(step.events > 0);
    assert.ok(step.firstSeq <= step.lastSeq);
  });

  it('fails when the stream does not start with a v1 hello', () => {
    assert.deepEqual(new StreamProbe().receive(fixture('batch.json')), {
      kind: 'failed',
      reason: 'expected hello first, got batch',
    });
    const v2 = JSON.stringify({ ...JSON.parse(fixture('hello.json')), protocolVersion: 2 });
    assert.match(failure(new StreamProbe().receive(v2)), /protocolVersion is 2, expected 1/);
    assert.match(failure(new StreamProbe().receive('{')), /invalid server message/);
  });

  it('fails on an error message or a second hello', () => {
    const probe = new StreamProbe();
    probe.receive(fixture('hello.json'));
    assert.match(failure(probe.receive(fixture('error.json'))), /^server error /);
    assert.match(failure(probe.receive(fixture('hello.json'))), /second hello/);
  });

  function failure(step: ReturnType<StreamProbe['receive']>): string {
    if (step.kind !== 'failed') throw new Error(`expected a failure, got ${step.kind}`);
    return step.reason;
  }
});

describe('closeFailure and handshakeFailure', () => {
  it('retries busy, going-away and abnormal closes but not terminal ones', () => {
    assert.equal(closeFailure(4029, 'busy; retry-after=30').retry, true);
    assert.equal(closeFailure(1001, '').retry, true);
    assert.equal(closeFailure(1006, '').retry, true);
    assert.equal(closeFailure(4001, 'unsupported protocol version').retry, false);
    assert.equal(closeFailure(4000, '').retry, false);
    assert.equal(
      closeFailure(4001, 'unsupported protocol version').message,
      'the server closed the stream with 4001 (unsupported protocol version)',
    );
  });

  it('explains a 403 and retries only server errors', () => {
    assert.deepEqual(handshakeFailure(403).retry, false);
    assert.match(handshakeFailure(403).message, /ALLOWED_ORIGINS/);
    assert.equal(handshakeFailure(404).retry, false);
    assert.equal(handshakeFailure(502).retry, true);
  });
});

interface FakeServer {
  readonly url: string;
  close(): Promise<void>;
}

interface FakeServerOptions {
  readonly version?: string;
  readonly allowedOrigin?: string;
  /** `/healthz` answers 503 this many times before it answers 200. */
  readonly startingRequests?: number;
  /** This many connections are closed with 4029 before one streams. */
  readonly busyConnections?: number;
  readonly sendBatch?: boolean;
}

/** A stand-in for the mock server that replays golden fixtures. */
async function startFakeServer(options: FakeServerOptions = {}): Promise<FakeServer> {
  let starting = options.startingRequests ?? 0;
  let busy = options.busyConnections ?? 0;
  const http = createServer((request, response) => {
    if (request.url !== '/healthz') {
      response.writeHead(404).end();
    } else if (starting > 0) {
      starting--;
      response.writeHead(503).end('starting');
    } else {
      const version = options.version ?? 'dev';
      response
        .writeHead(200, { 'content-type': 'application/json' })
        .end(JSON.stringify({ status: 'ok', version, uptimeS: 1, connections: 0 }));
    }
  });
  const wss = new WebSocketServer({ noServer: true });
  http.on('upgrade', (request, socket, head) => {
    if (options.allowedOrigin !== undefined && request.headers.origin !== options.allowedOrigin) {
      socket.end('HTTP/1.1 403 Forbidden\r\nConnection: close\r\nContent-Length: 0\r\n\r\n');
      return;
    }
    wss.handleUpgrade(request, socket, head, (ws) => {
      if (busy > 0) {
        busy--;
        ws.close(4029, 'busy; retry-after=30');
        return;
      }
      ws.send(fixture('hello.json'));
      ws.send(fixture('heartbeat.json'));
      if (options.sendBatch !== false) ws.send(fixture('batch.json'));
    });
  });
  await new Promise<void>((resolve) => http.listen(0, '127.0.0.1', resolve));
  const address = http.address();
  if (address === null || typeof address === 'string') throw new Error('no TCP address');
  return {
    url: `ws://127.0.0.1:${String(address.port)}/ws`,
    close: async () => {
      for (const ws of wss.clients) ws.terminate();
      wss.close();
      http.closeAllConnections();
      await new Promise((resolve) => http.close(resolve));
    },
  };
}

async function smoke(server: FakeServer, args: string[], timeoutMs = 3000) {
  const lines: string[] = [];
  const options = parsedArgs([server.url, '--timeout', String(timeoutMs), ...args]);
  const started = performance.now();
  const result = await runSmoke(options, { log: (line) => lines.push(line), retryDelayMs: 20 });
  return { result, lines, elapsedMs: performance.now() - started };
}

describe('runSmoke', () => {
  const origin = 'http://localhost:4173';

  it('passes when /healthz reports the version and the stream starts', async () => {
    const server = await startFakeServer({ version: 'abc', allowedOrigin: origin });
    try {
      const { result, lines } = await smoke(server, [
        '--origin',
        origin,
        '--expect-version',
        'abc',
      ]);
      assert.ok(result.ok, result.ok ? '' : result.error);
      assert.equal(result.value.health.version, 'abc');
      assert.ok(result.value.stream.events > 0);
      assert.ok(lines.some((line) => line.includes('ok hello: stream st_01JA2R7QK3M9X4V8T6')));
    } finally {
      await server.close();
    }
  });

  it('retries while the server starts and while it is busy', async () => {
    const server = await startFakeServer({ startingRequests: 2, busyConnections: 1 });
    try {
      const { result, lines } = await smoke(server, []);
      assert.ok(result.ok, result.ok ? '' : result.error);
      assert.equal(lines.filter((line) => line.includes('healthz attempt')).length, 2);
      assert.ok(
        lines.some((line) =>
          line.includes('stream attempt 1: the server closed the stream with 4029'),
        ),
      );
    } finally {
      await server.close();
    }
  });

  it('fails at once when the Origin is rejected', async () => {
    const server = await startFakeServer({ allowedOrigin: origin });
    try {
      const { result, elapsedMs } = await smoke(server, ['--origin', 'https://evil.example']);
      assert.ok(!result.ok);
      assert.match(result.error, /^stream: handshake rejected with HTTP 403/);
      assert.ok(elapsedMs < 2000, `took ${String(elapsedMs)} ms`);
    } finally {
      await server.close();
    }
  });

  it('fails at the deadline when the version never matches', async () => {
    const server = await startFakeServer({ version: 'old' });
    try {
      const { result } = await smoke(server, ['--expect-version', 'new'], 300);
      assert.ok(!result.ok);
      assert.match(
        result.error,
        /^healthz: version is "old", expected "new" \(gave up after \d+ attempts\)$/,
      );
    } finally {
      await server.close();
    }
  });

  it('fails at the deadline when no batch arrives', async () => {
    const server = await startFakeServer({ sendBatch: false });
    try {
      const { result } = await smoke(server, [], 300);
      assert.ok(!result.ok);
      assert.match(result.error, /^stream: no batch within \d+ ms \(gave up after \d+ attempts\)$/);
    } finally {
      await server.close();
    }
  });
});
