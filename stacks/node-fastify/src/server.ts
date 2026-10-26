// Entry point: node:cluster primary forks one worker per core; each worker runs the Fastify app.
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
  const { buildApp } = await import("./app.ts");
  const { createPool } = await import("./db.ts");
  const app = buildApp(createPool(Math.floor(90 / workers)), process.env.JWT_SECRET ?? "");
  await app.listen({ host: process.env.HOST ?? "0.0.0.0", port: Number(process.env.PORT ?? 3000) });
}
