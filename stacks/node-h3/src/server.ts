// Entry point: node:cluster primary forks one worker per core; each worker serves the H3 app with
// h3's serve() (srvx's Node adapter, node:http underneath).
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
  const { serve } = await import("h3");
  const { createApp } = await import("./app.ts");
  const { createPool } = await import("./db.ts");
  const app = createApp(createPool(Math.floor(90 / workers)), process.env.JWT_SECRET ?? "");
  serve(app, {
    hostname: process.env.HOST ?? "0.0.0.0",
    port: Number(process.env.PORT ?? 3000),
    silent: true, // no per-worker "listening on" banner
    node: {
      // srvx listens with exclusive: true unless reusePort is set, which bypasses node:cluster's shared
      // listening socket; exclusive: false gives the standard cluster setup (primary distributes connections).
      exclusive: false,
      // Users idle up to ~70 s between pages on one keep-alive connection; Node's default is 5 s.
      keepAliveTimeout: 75_000,
      headersTimeout: 76_000,
    },
  });
}
