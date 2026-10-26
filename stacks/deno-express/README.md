# deno-express: Conduit on Express 5 on Deno's Node compatibility layer

Front: direct

| | |
|---|---|
| Runtime | Deno 2.9.8 (V8 15.0, TypeScript 6.0.3), Express running on `node:http` as Deno implements it |
| Framework | Express 5.3.0 (`npm:express`), `express.json()` body parser, error-handling middleware |
| Driver | postgres.js 3.4.9 (`npm:postgres`), tagged templates, prepared statements (its default) |
| Validator | zod 4.6.7, `safeParse(req.body)` in the handler |
| JWT | jose 6.2.13 (Express has no official JWT helper) |
| bcrypt | bcrypt 6.0.0 (`npm:bcrypt`, native N-API addon), cost 10 |
| Deps | `deno.json` (`npm:` specifiers, exact versions; `@types/express` 5.0.6 for types) + `deno.lock`; `build.sh` runs `deno install --frozen --entrypoint src/main.ts` into `./node_modules` |

## Multicore: node:cluster works on Deno 2.9.8

Express exposes no fetch handler, so `deno serve --parallel` is out. What I checked:

- **`node:cluster` works.** Deno's docs (Node APIs page) still list `node:cluster` under "Unsupported modules: All
  exports are non-functional stubs", but in 2.9.8 it is a real port of Node's cluster module
  (`ext/node/polyfills/internal/cluster/`, round-robin scheduling by default on Linux, as in Node). Tested in a Linux
  container: 4 workers, 64 keep-alive connections, CPU time 323 / 354 / 356 / 290 ticks, primary idle (same test on
  deno-fastify with 256 connections on a DB route: 1160 / 1216 / 1102 / 1270).
- **`server.listen({ reusePort: true })` on `node:http` also works on Linux** (several separate `deno run`
  processes on one port, connections spread across them), so that was the fallback.

So this stack does what the Node rows do: the primary forks `os.availableParallelism()` workers, each runs the Express
app with its own postgres.js pool of `floor(90 / workers)` connections. No restart of dead workers. SIGTERM to the
primary takes the workers down with it.

## Keep-alive

Deno's `node:http` keeps Node's defaults and honours them: `keepAliveTimeout` 5 s (an idle connection was reset after
7 s). Set as on the Node rows: `server.keepAliveTimeout = 75_000`, `server.headersTimeout = 76_000`. Measured: idle
72 s, still answered; idle 80 s, closed. No compression middleware.

## Permissions (start.sh): `-A`

Deno spawns cluster workers as `deno run -A --unstable-bare-node-builtins --unstable-detect-cjs <script>`, whatever
flags the primary got, and the primary needs `--allow-run` on the deno binary to fork them. Narrower flags on the
primary would only be decoration, so start.sh uses `-A`. (Workers also don't inherit `--frozen --cached-only`; they
read the same `deno.json`/`deno.lock`/`node_modules`.)

## Deviations and notes

- `app.disable("x-powered-by")` (Express production-security advice) and `app.disable("etag")` (no caching of any
  kind), as on node-express.
- body-parser's malformed-JSON error (400, `entity.parse.failed`) is answered with 422 by the error middleware; the spec
  wants 422 for every bad body. Express 5 forwards rejected async handlers to that middleware.
- Unmatched routes get a JSON 404.
- int8 parsed to numbers by a postgres.js custom type; timestamps come out as `Date`, which V8 truncates to ms.
- bcrypt loads in Deno 2.9.8 from its prebuilt binaries (install script skipped by Deno, not needed). Passwords over
  72 bytes are rejected with 422.
