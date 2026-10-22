// Entry of the stream worker (docs/adr/0006); `spawnStreamWorker` loads it. The logic lives in
// `createStreamWorkerHost`, which the tests drive with a fake port. The app is type-checked with
// the DOM library, where `self` is a `Window`; the members used here exist on both globals.
import { createStreamWorkerHost } from './stream-worker-host';

createStreamWorkerHost(self, { now: () => performance.now() });
