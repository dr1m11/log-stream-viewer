import process from 'node:process';

import { parseConfig } from './config.ts';
import { createServer } from './server.ts';

const config = parseConfig(process.env);
if (!config.ok) {
  console.error(
    `Invalid mock server configuration:\n${config.error.map((problem) => `  - ${problem}`).join('\n')}`,
  );
  process.exit(1);
}

const settings = config.value;
const server = createServer(settings);

try {
  const { address, port } = await server.listen();
  const host = address.includes(':') ? `[${address}]` : address;
  console.log(
    `listening url=http://${host}:${String(port)} version=${settings.gitSha} ` +
      `production=${String(settings.production)} maxRate=${String(settings.maxRate)} ` +
      `maxConnections=${String(settings.maxConnections)} perIp=${String(settings.maxConnectionsPerIp)} ` +
      `globalMaxEventsPerSec=${String(settings.globalMaxEventsPerSec)}`,
  );
} catch (error) {
  console.error(`Cannot listen on ${settings.host}:${String(settings.port)}: ${String(error)}`);
  process.exit(1);
}

let stopping = false;

function shutdown(signal: NodeJS.Signals): void {
  if (stopping) {
    console.log(`shutdown signal=${signal} forced`);
    process.exit(1);
  }
  stopping = true;
  console.log(`shutdown signal=${signal}`);
  server.close().then(
    () => process.exit(0),
    (error: unknown) => {
      console.error(`shutdown failed: ${String(error)}`);
      process.exit(1);
    },
  );
}

process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);
