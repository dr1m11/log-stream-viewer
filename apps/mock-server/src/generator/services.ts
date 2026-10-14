import type { JsonValue, LogLevel } from '@lsv/protocol';

import type { Prng } from './prng.ts';

type Payload = Record<string, JsonValue>;

/** Scratch object a template writes the event text into; reused for every event. */
export interface Draft {
  message: string;
  payload: Payload | undefined;
}

/** Scenario effects a template takes into account. */
export interface TemplateContext {
  readonly latencyFactor: number;
}

/** Writes the message and payload of one event of a given service and level into `out`. */
export type Template = (rng: Prng, ctx: TemplateContext, out: Draft) => void;

/** A simulated microservice. */
export interface ServiceSpec {
  readonly name: string;
  /** Relative share of the traffic. */
  readonly weight: number;
  /** Number of instances (hosts) logging for the service. */
  readonly instances: number;
  /** Probability that an event carries a trace id. */
  readonly tracedShare: number;
  readonly templates: Readonly<Record<LogLevel, readonly Template[]>>;
}

// --- Building blocks ------------------------------------------------------------------------------
// Lists are module constants so that templates allocate nothing but the event's own strings and
// payload objects.

const userId = (rng: Prng): string => `u_${String(rng.int(10_000, 100_000))}`;
const orderId = (rng: Prng): number => rng.int(10_000, 100_000);
const sku = (rng: Prng): string => `SKU-${String(rng.int(1000, 10_000))}`;
/** A price in dollars with cents. */
const amount = (rng: Prng): number => rng.int(500, 50_000) / 100;
const dollars = (value: number): string => `$${value.toFixed(2)}`;

/** Log-normal latency around `medianMs`, scaled by the scenario (spikes are slower). */
function latencyMs(rng: Prng, ctx: TemplateContext, medianMs: number, sigma = 0.6): number {
  return Math.max(1, Math.round(medianMs * Math.exp(sigma * rng.normal()) * ctx.latencyFactor));
}

/** `error` payload field with a stack trace; `frames` is a pre-joined block of `at …` lines. */
function failure(name: string, message: string, frames: string): Payload {
  return { name, message, stack: `${name}: ${message}\n${frames}` };
}

const frames = (...lines: string[]): string => lines.map((line) => `    at ${line}`).join('\n');

const SEARCH_TERMS = [
  'blue shoes',
  'wireless headphones',
  'coffee grinder',
  'running socks',
  'usb-c cable',
  'desk lamp',
  'yoga mat',
  'mechanical keyboard',
] as const;
const PAYMENT_PROVIDERS = ['acme-pay', 'stripe-like', 'paybridge'] as const;
const PAYMENT_METHODS = ['card', 'card', 'paypal', 'apple-pay'] as const;
const UPSTREAMS = ['orders', 'payments', 'search', 'auth'] as const;
const SIGN_IN_METHODS = ['password', 'google', 'github'] as const;
const OAUTH_PROVIDERS = ['google', 'github'] as const;
const CARRIERS = ['DHL', 'UPS', 'FedEx'] as const;
const QUEUES = ['email', 'sms', 'push'] as const;
const CHANNELS = ['email', 'email', 'push', 'sms'] as const;
const MESSAGE_TEMPLATES = [
  'order-confirmation',
  'password-reset',
  'shipping-update',
  'weekly-digest',
] as const;
const OK_STATUSES = [200, 200, 200, 201, 204, 304] as const;
const CLIENT_ERROR_STATUSES = [401, 404, 409, 429] as const;
const SERVER_ERROR_STATUSES = [500, 502, 503, 504] as const;

// --- api-gateway ----------------------------------------------------------------------------------

interface Route {
  readonly method: string;
  readonly path: (rng: Prng) => string;
}

const ROUTES: readonly Route[] = [
  { method: 'GET', path: (rng) => `/api/orders/${String(orderId(rng))}` },
  { method: 'POST', path: () => '/api/orders' },
  { method: 'GET', path: (rng) => `/api/products/${sku(rng)}` },
  { method: 'GET', path: (rng) => `/api/search?q=${encodeURIComponent(rng.pick(SEARCH_TERMS))}` },
  { method: 'POST', path: () => '/api/auth/token' },
  { method: 'GET', path: () => '/api/users/me' },
  { method: 'PUT', path: (rng) => `/api/cart/items/${sku(rng)}` },
];

const GATEWAY_FRAMES = frames(
  'proxyRequest (proxy.ts:112:9)',
  'handleRoute (router.ts:58:14)',
  'runMiddleware (middleware.ts:31:7)',
  'Server.onRequest (server.ts:77:5)',
);

/** An access-log line: `GET /api/orders/84211 200 in 38 ms`. */
function gatewayRequest(
  rng: Prng,
  out: Draft,
  status: number,
  latency: number,
  error?: Payload,
): void {
  const route = rng.pick(ROUTES);
  const path = route.path(rng);
  const head = `${route.method} ${path} ${String(status)} in ${String(latency)} ms`;
  const http = { method: route.method, path, status };
  if (error === undefined) {
    out.message = latency >= 1000 ? `${head} (slow)` : head;
    out.payload = { http, latencyMs: latency, userId: userId(rng) };
  } else {
    out.message = `${head}: upstream failed`;
    out.payload = { http, latencyMs: latency, userId: userId(rng), error };
  }
}

const apiGateway: ServiceSpec = {
  name: 'api-gateway',
  weight: 30,
  instances: 3,
  tracedShare: 1,
  templates: {
    trace: [
      (rng, _ctx, out) => {
        const route = rng.pick(ROUTES);
        out.message = `Route matched: ${route.method} ${route.path(rng)}`;
        out.payload = undefined;
      },
    ],
    debug: [
      (rng, _ctx, out) => {
        const upstream = rng.pick(UPSTREAMS);
        out.message = `Forwarding request to ${upstream} (pool size ${String(rng.int(4, 17))})`;
        out.payload = { upstream };
      },
    ],
    info: [
      (rng, ctx, out) => {
        gatewayRequest(rng, out, rng.pick(OK_STATUSES), Math.min(999, latencyMs(rng, ctx, 40)));
      },
    ],
    warn: [
      (rng, ctx, out) => {
        gatewayRequest(rng, out, 200, Math.max(1000, latencyMs(rng, ctx, 1800, 0.3)));
      },
      (rng, ctx, out) => {
        gatewayRequest(rng, out, rng.pick(CLIENT_ERROR_STATUSES), latencyMs(rng, ctx, 6));
      },
    ],
    error: [
      (rng, ctx, out) => {
        const status = rng.pick(SERVER_ERROR_STATUSES);
        const message = `Upstream responded with ${String(status)}`;
        const error = failure('UpstreamError', message, GATEWAY_FRAMES);
        gatewayRequest(rng, out, status, latencyMs(rng, ctx, 4000, 0.5), error);
      },
    ],
    fatal: [
      (_rng, _ctx, out) => {
        out.message = 'Route table failed to load, refusing traffic';
        out.payload = {
          error: failure('ConfigError', 'routes.yaml: unexpected token at line 42', GATEWAY_FRAMES),
        };
      },
    ],
  },
};

// --- auth -----------------------------------------------------------------------------------------

const AUTH_FRAMES = frames(
  'fetchToken (oauth.ts:64:13)',
  'signIn (auth-service.ts:121:9)',
  'handleLogin (routes/login.ts:27:5)',
);

const auth: ServiceSpec = {
  name: 'auth',
  weight: 15,
  instances: 2,
  tracedShare: 0.9,
  templates: {
    trace: [
      (rng, _ctx, out) => {
        const user = userId(rng);
        const hit = rng.chance(0.85);
        out.message = `Session cache ${hit ? 'hit' : 'miss'} for ${user}`;
        out.payload = { userId: user, cacheHit: hit };
      },
    ],
    debug: [
      (rng, _ctx, out) => {
        const user = userId(rng);
        const expiresInS = rng.int(30, 3600);
        out.message = `JWT validated for ${user} (expires in ${String(expiresInS)} s)`;
        out.payload = { userId: user, expiresInS };
      },
    ],
    info: [
      (rng, ctx, out) => {
        const user = userId(rng);
        const method = rng.pick(SIGN_IN_METHODS);
        out.message = `User ${user} signed in via ${method}`;
        out.payload = { userId: user, method, latencyMs: latencyMs(rng, ctx, 90) };
      },
      (rng, ctx, out) => {
        const user = userId(rng);
        out.message = `Token refreshed for ${user}`;
        out.payload = { userId: user, latencyMs: latencyMs(rng, ctx, 15) };
      },
    ],
    warn: [
      (rng, _ctx, out) => {
        const user = userId(rng);
        const attempt = rng.int(2, 6);
        out.message = `Failed login attempt ${String(attempt)}/5 for ${user}`;
        out.payload = { userId: user, attempt, maxAttempts: 5 };
      },
    ],
    error: [
      (rng, ctx, out) => {
        const provider = rng.pick(OAUTH_PROVIDERS);
        const latency = latencyMs(rng, ctx, 5000, 0.1);
        out.message = `OAuth provider ${provider} timed out after ${String(latency)} ms`;
        out.payload = {
          provider,
          latencyMs: latency,
          error: failure('TimeoutError', `Request to ${provider} timed out`, AUTH_FRAMES),
        };
      },
    ],
    fatal: [
      (_rng, _ctx, out) => {
        out.message = 'Signing key store unavailable, shutting down';
        out.payload = {
          error: failure('KeyStoreError', 'Vault returned 503 for transit/keys/jwt', AUTH_FRAMES),
        };
      },
    ],
  },
};

// --- orders ---------------------------------------------------------------------------------------

const ORDERS_FRAMES = frames(
  'reserve (inventory.ts:88:11)',
  'placeOrder (orders.ts:142:5)',
  'OrdersController.create (controller.ts:36:12)',
);

const orders: ServiceSpec = {
  name: 'orders',
  weight: 15,
  instances: 3,
  tracedShare: 0.95,
  templates: {
    trace: [
      (rng, _ctx, out) => {
        const user = userId(rng);
        const items = rng.int(0, 8);
        out.message = `Loaded cart for ${user} (${String(items)} items)`;
        out.payload = { userId: user, items };
      },
    ],
    debug: [
      (rng, _ctx, out) => {
        const items = rng.int(1, 8);
        const total = amount(rng);
        out.message = `Cart recalculated: ${String(items)} items, ${dollars(total)}`;
        out.payload = { items, total, currency: 'USD' };
      },
    ],
    info: [
      (rng, _ctx, out) => {
        const order = orderId(rng);
        const user = userId(rng);
        const items = rng.int(1, 8);
        const total = amount(rng);
        out.message = `Order ${String(order)} placed by ${user} (${String(items)} items, ${dollars(total)})`;
        out.payload = { orderId: order, userId: user, items, total, currency: 'USD' };
      },
      (rng, _ctx, out) => {
        const order = orderId(rng);
        const carrier = rng.pick(CARRIERS);
        out.message = `Order ${String(order)} shipped via ${carrier}`;
        out.payload = { orderId: order, carrier };
      },
    ],
    warn: [
      (rng, _ctx, out) => {
        const order = orderId(rng);
        const waitS = rng.int(30, 300);
        out.message = `Order ${String(order)} waiting for payment for ${String(waitS)} s`;
        out.payload = { orderId: order, waitS };
      },
    ],
    error: [
      (rng, _ctx, out) => {
        const order = orderId(rng);
        const item = sku(rng);
        out.message = `Failed to reserve stock for order ${String(order)}`;
        out.payload = {
          orderId: order,
          sku: item,
          retryable: false,
          error: failure('StockReservationError', `Insufficient stock for ${item}`, ORDERS_FRAMES),
        };
      },
    ],
    fatal: [
      (_rng, _ctx, out) => {
        out.message = 'Order database connection lost, shutting down';
        out.payload = {
          error: failure('ConnectionError', 'Connection terminated unexpectedly', ORDERS_FRAMES),
        };
      },
    ],
  },
};

// --- payments -------------------------------------------------------------------------------------

const PAYMENTS_FRAMES = frames(
  'ProcessorClient.capture (processor.ts:73:15)',
  'capturePayment (payments.ts:58:10)',
  'PaymentsWorker.handle (worker.ts:24:7)',
);

const payments: ServiceSpec = {
  name: 'payments',
  weight: 12,
  instances: 2,
  tracedShare: 1,
  templates: {
    trace: [
      (rng, _ctx, out) => {
        const order = orderId(rng);
        out.message = `Idempotency key checked for order ${String(order)}`;
        out.payload = { orderId: order };
      },
    ],
    debug: [
      (rng, _ctx, out) => {
        const order = orderId(rng);
        const score = rng.int(0, 100) / 100;
        out.message = `Fraud score ${score.toFixed(2)} for order ${String(order)}`;
        out.payload = { orderId: order, fraudScore: score };
      },
    ],
    info: [
      (rng, ctx, out) => {
        const order = orderId(rng);
        const total = amount(rng);
        const method = rng.pick(PAYMENT_METHODS);
        out.message = `Payment captured for order ${String(order)} (${dollars(total)} via ${method})`;
        out.payload = {
          orderId: order,
          amount: total,
          currency: 'USD',
          method,
          provider: rng.pick(PAYMENT_PROVIDERS),
          latencyMs: latencyMs(rng, ctx, 220),
        };
      },
    ],
    warn: [
      (rng, ctx, out) => {
        out.message = 'Card processor responded slowly, retrying';
        out.payload = {
          latencyMs: latencyMs(rng, ctx, 2000, 0.3),
          attempt: rng.int(2, 4),
          provider: rng.pick(PAYMENT_PROVIDERS),
        };
      },
    ],
    error: [
      (rng, _ctx, out) => {
        const order = orderId(rng);
        const provider = rng.pick(PAYMENT_PROVIDERS);
        out.message = `Card processor ${provider} returned 502 for order ${String(order)}`;
        out.payload = {
          orderId: order,
          provider,
          error: failure('ProcessorError', `${provider} responded with 502`, PAYMENTS_FRAMES),
        };
      },
    ],
    fatal: [
      (_rng, _ctx, out) => {
        out.message = 'Ledger connection pool exhausted, shutting down';
        out.payload = {
          error: failure('PoolExhaustedError', 'No connection within 30000 ms', PAYMENTS_FRAMES),
        };
      },
    ],
  },
};

// --- search ---------------------------------------------------------------------------------------

const SEARCH_FRAMES = frames(
  'ShardClient.query (shard-client.ts:91:13)',
  'fanOut (search.ts:47:22)',
  'SearchController.find (controller.ts:19:9)',
);

const search: ServiceSpec = {
  name: 'search',
  weight: 18,
  instances: 3,
  tracedShare: 0.8,
  templates: {
    trace: [
      (rng, _ctx, out) => {
        const query = rng.pick(SEARCH_TERMS);
        out.message = `Tokenized query "${query}"`;
        out.payload = { query };
      },
    ],
    debug: [
      (rng, _ctx, out) => {
        out.message = rng.chance(0.7) ? 'Query plan cache hit' : 'Query plan cache miss';
        out.payload = undefined;
      },
    ],
    info: [
      (rng, ctx, out) => {
        const query = rng.pick(SEARCH_TERMS);
        const hits = rng.int(0, 500);
        const latency = latencyMs(rng, ctx, 25);
        out.message = `Search "${query}" returned ${String(hits)} hits in ${String(latency)} ms`;
        out.payload = { query, hits, latencyMs: latency, page: rng.int(1, 4) };
      },
    ],
    warn: [
      (rng, ctx, out) => {
        const query = rng.pick(SEARCH_TERMS);
        const shard = rng.int(0, 8);
        const latency = latencyMs(rng, ctx, 1200, 0.3);
        out.message = `Slow query "${query}" took ${String(latency)} ms on shard ${String(shard)}`;
        out.payload = { query, shard, latencyMs: latency };
      },
    ],
    error: [
      (rng, _ctx, out) => {
        const shard = rng.int(0, 8);
        out.message = `Index shard ${String(shard)} unavailable, partial results returned`;
        out.payload = {
          shard,
          error: failure(
            'ShardUnavailableError',
            `Shard ${String(shard)} did not respond`,
            SEARCH_FRAMES,
          ),
        };
      },
    ],
    fatal: [
      (_rng, _ctx, out) => {
        out.message = 'Search index corrupted, refusing queries';
        out.payload = {
          error: failure('IndexCorruptedError', 'Checksum mismatch in segment _4f2', SEARCH_FRAMES),
        };
      },
    ],
  },
};

// --- notifications --------------------------------------------------------------------------------

const NOTIFICATIONS_FRAMES = frames(
  'PushClient.send (push.ts:52:11)',
  'deliver (dispatcher.ts:83:7)',
  'QueueConsumer.onMessage (consumer.ts:40:5)',
);

const notifications: ServiceSpec = {
  name: 'notifications',
  weight: 10,
  instances: 2,
  tracedShare: 0.4,
  templates: {
    trace: [
      (rng, _ctx, out) => {
        const queue = rng.pick(QUEUES);
        const jobs = rng.chance(0.6) ? 0 : rng.int(1, 40);
        out.message = `${queue} queue polled, ${String(jobs)} jobs`;
        out.payload = { queue, jobs };
      },
    ],
    debug: [
      (rng, ctx, out) => {
        const template = rng.pick(MESSAGE_TEMPLATES);
        const latency = latencyMs(rng, ctx, 4);
        out.message = `Rendered template ${template} in ${String(latency)} ms`;
        out.payload = { template, latencyMs: latency };
      },
    ],
    info: [
      (rng, ctx, out) => {
        const user = userId(rng);
        const channel = rng.pick(CHANNELS);
        const template = rng.pick(MESSAGE_TEMPLATES);
        out.message = `Sent ${template} to ${user} via ${channel}`;
        out.payload = { userId: user, channel, template, latencyMs: latencyMs(rng, ctx, 120) };
      },
    ],
    warn: [
      (rng, _ctx, out) => {
        const backoffMs = rng.int(1, 6) * 1000;
        out.message = `SMS provider rate limited, backing off ${String(backoffMs / 1000)} s`;
        out.payload = { provider: 'textly', backoffMs };
      },
    ],
    error: [
      (rng, _ctx, out) => {
        const user = userId(rng);
        out.message = `Push delivery failed for ${user}: device token expired`;
        out.payload = {
          userId: user,
          error: failure('DeliveryError', 'APNs responded 410 Unregistered', NOTIFICATIONS_FRAMES),
        };
      },
    ],
    fatal: [
      (_rng, _ctx, out) => {
        out.message = 'Message broker unreachable, shutting down';
        out.payload = {
          error: failure(
            'BrokerError',
            'connect ECONNREFUSED 10.0.3.17:5672',
            NOTIFICATIONS_FRAMES,
          ),
        };
      },
    ],
  },
};

/** The simulated services, in a fixed order (indices are part of the deterministic stream). */
export const SERVICES: readonly ServiceSpec[] = [
  apiGateway,
  auth,
  orders,
  payments,
  search,
  notifications,
];
