// Entry point: node:cluster primary forks one worker per core; each worker runs the Express app.
import cluster from "node:cluster";
import { availableParallelism } from "node:os";

const workers = availableParallelism();

if (cluster.isPrimary) {
  for (let i = 0; i < workers; i++) cluster.fork();
  // No restart-on-crash: a worker that dies stays dead.
  cluster.on("exit", (worker, code, signal) => {
    console.error(`worker ${worker.process.pid} exited (${signal ?? code})`);
  });
} else {
  const { createApp } = await import("./app.ts");
  const { createPool } = await import("./db.ts");
  const pool = createPool(Math.floor(90 / workers));
  const app = createApp(pool, process.env.JWT_SECRET ?? "");
  const host = process.env.HOST ?? "0.0.0.0";
  const port = Number(process.env.PORT ?? 3000);
  const server = app.listen(port, host, (err?: Error) => {
    if (err) throw err;
  });
  // Users idle up to ~70 s between pages on one keep-alive connection; Node's default is 5 s.
  server.keepAliveTimeout = 75_000;
  server.headersTimeout = 76_000;
}
