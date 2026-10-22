// Test doubles and data for unit tests only; production code never imports this module.
export { type CloseRequest, FakeWebSocket } from './fake-web-socket';
export { FakeMessagePort, FakeWorker, type PostedMessage } from './fake-worker';
export { testBatch, testHeartbeat, testHello, testLogEvent } from './log-events';
