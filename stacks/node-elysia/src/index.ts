import cluster from 'node:cluster';
import os from 'node:os';

const workers = os.availableParallelism();

if (cluster.isPrimary) {
  console.log(`primary ${process.pid}: forking ${workers} workers`);
  for (let i = 0; i < workers; i++) cluster.fork({ WORKERS: String(workers) });
  // No restart: a worker that dies stays dead.
  cluster.on('exit', (w, code, signal) => console.error(`worker ${w.process.pid} exited (${signal ?? code})`));
} else {
  const { app } = await import('./app.js');
  app.listen(
    {
      hostname: process.env.HOST ?? '0.0.0.0',
      port: Number(process.env.PORT ?? 3000),
      // @elysiajs/node hands these to srvx, which spreads `node` into http.createServer().
      // Node's default keep-alive is 5 s; clients idle up to ~70 s between pages.
      node: { keepAliveTimeout: 75_000, headersTimeout: 76_000 },
    } as never, // listen()'s type is Bun's Serve options; the `node` passthrough isn't in it
    () => console.log(`worker ${process.pid} listening`),
  );
}
