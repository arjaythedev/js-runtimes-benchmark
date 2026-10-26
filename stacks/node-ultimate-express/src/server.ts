// Entry point: node:cluster primary forks one worker per core; each worker runs the ultimate-express app.
// ultimate-express listens through uWebSockets.js, not node:http: inside a cluster worker it binds the port
// itself in shared mode (SO_REUSEPORT), so the kernel spreads connections across the workers.
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
  // uWS has a fixed 10 s HTTP keep-alive idle timeout (compiled in, not configurable): see README.
  app.listen(port, host);
}
