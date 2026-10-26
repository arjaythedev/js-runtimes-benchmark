// Entry point: node:cluster primary forks one worker per core; each worker runs a plain node:http server.
import cluster from "node:cluster";
import { createServer } from "node:http";
import { createServer as createH2Server } from "node:http2";
import { availableParallelism } from "node:os";

const workers = availableParallelism();

if (cluster.isPrimary) {
  for (let i = 0; i < workers; i++) cluster.fork();
  // No restart-on-crash: a worker that dies stays dead.
  cluster.on("exit", (worker, code, signal) => {
    console.error(`worker ${worker.process.pid} exited (${signal ?? code})`);
  });
} else {
  const { createHandler } = await import("./app.ts");
  const { createPool } = await import("./db.ts");
  const handler = createHandler(createPool(Math.floor(90 / workers)), process.env.JWT_SECRET ?? "");
  // Users idle up to ~70 s between pages on one keep-alive connection; Node's default is 5 s.
  // H2C=1 (the HTTP/2 side test): node:http2's compatibility API (same req/res handler), cleartext h2.
  const server = process.env.H2C === "1"
    ? createH2Server(handler as any)
    : createServer({ keepAliveTimeout: 75_000, headersTimeout: 76_000 }, handler);
  server.listen(Number(process.env.PORT ?? 3000), process.env.HOST ?? "0.0.0.0");
}
