// Entry point: node:cluster primary forks one worker per core; each worker serves the Hono app
// through @hono/node-server (node:http underneath).
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
  const { serve } = await import("@hono/node-server");
  // H2C=1 (the HTTP/2 side test): @hono/node-server's documented `createServer: http2.createServer` (cleartext h2).
  const http2 = process.env.H2C === "1" ? await import("node:http2") : undefined;
  const { createApp } = await import("./app.ts");
  const { createPool } = await import("./db.ts");
  const app = createApp(createPool(Math.floor(90 / workers)), process.env.JWT_SECRET ?? "");
  serve({
    fetch: app.fetch,
    ...((http2 ? { createServer: http2.createServer } : {}) as {}),
    hostname: process.env.HOST ?? "0.0.0.0",
    port: Number(process.env.PORT ?? 3000),
    // Users idle up to ~70 s between pages on one keep-alive connection; Node's default is 5 s.
    serverOptions: { keepAliveTimeout: 75_000, headersTimeout: 76_000 },
  });
}
