import os from 'node:os';
import { createRequire } from 'node:module';
import { isMainThread, threadId, Worker, workerData } from 'node:worker_threads';
import type * as UWS from 'uWebSockets.js';

// v20.71.0's ESM entry (ESM_wrapper.mjs) imports a non-existent './index.js', so load the CommonJS entry.
const uWS: typeof UWS = createRequire(import.meta.url)('uWebSockets.js');

// uWS's documented multi-core setup (examples/WorkerThreads.mjs, first approach): one App per worker thread,
// every one listening on the same port. uWS sets SO_REUSEPORT and on Linux the kernel spreads new
// connections across the listeners. (macOS accepts the binds too but doesn't balance; fine for conformance.)
const HOST = process.env.HOST ?? '0.0.0.0';
const PORT = Number(process.env.PORT ?? 3000);

if (isMainThread) {
  const workers = os.availableParallelism();
  console.log(`main: starting ${workers} worker threads on ${HOST}:${PORT}`);
  for (let i = 0; i < workers; i++) {
    const w = new Worker(new URL(import.meta.url), { workerData: { workers } });
    // No restart: a worker that dies stays dead.
    w.on('error', (e) => console.error('worker crashed', e));
    w.on('exit', (code) => console.error(`a worker exited (${code})`));
  }
} else {
  const { createPool } = await import('./db.js');
  const { routes } = await import('./routes.js');
  // Total Postgres connections across all workers stay <= 90.
  const db = createPool(Math.floor(90 / workerData.workers));
  const app = uWS.App();
  routes(app, db);
  app.listen(HOST, PORT, (token) => {
    if (!token) {
      console.error(`worker ${threadId} failed to listen on ${HOST}:${PORT}`);
      process.exit(1);
    }
    console.log(`worker ${threadId} listening`);
  });
}
