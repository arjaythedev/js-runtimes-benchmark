// node:cluster primary: one worker per core (os.availableParallelism()). Bun's node:http ignores `reusePort` and
// `exclusive` in listen(), but each node:cluster worker binds its own SO_REUSEPORT socket on Linux, so the kernel
// balances connections across workers. No restart: a worker that dies stays dead.
import cluster from "node:cluster";
import os from "node:os";

if (cluster.isPrimary) {
  const workers = os.availableParallelism();
  for (let i = 0; i < workers; i++) cluster.fork({ WORKERS: String(workers) });
  cluster.on("exit", (w, code, signal) => console.error(`worker ${w.process.pid} exited (${signal ?? code})`));
} else {
  await import("./app");
}
