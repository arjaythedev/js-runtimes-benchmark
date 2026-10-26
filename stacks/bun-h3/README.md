# bun-h3: H3 v2 on Bun

Front: direct

| Piece | Choice |
|---|---|
| Runtime | Bun 1.4.4 |
| Framework | h3 2.0.8, `new H3()` + `serve(app, ...)` from h3 (srvx 1.0.6 → Bun.serve), as h3.dev shows |
| Driver | `Bun.sql` (built in) |
| Validator | `readValidatedBody` / `getValidatedQuery` with zod 4.6.7 (Standard Schema) |
| JWT | jose 6.2.13 (h3 has no JWT helper) |
| bcrypt | `Bun.password` (bcrypt, cost 10) |

- **Database:** `Bun.sql` (`new SQL(DATABASE_URL, { max: floor(90 / workers) })`), tagged-template queries with the
  reference SQL from SPEC.md verbatim. Bun.sql prepares statements by default. Pool per process = `floor(90 / WORKERS)`
  (8 workers → 11 each, 88 total); the launcher passes `WORKERS` to each process.
- **Passwords:** `Bun.password.hash(pw, { algorithm: "bcrypt", cost: 10 })` / `Bun.password.verify`.
- **Driver types:** Bun.sql returns `int8` as strings (its default `bigint: false`), so ids and counts go through
  `Number()` before JSON; `offset` is passed as a decimal string so values up to int64 max reach Postgres intact.
  `timestamptz` comes back as a `Date` with the microseconds truncated (checked: `.123999` → `.123Z`), so
  `toISOString()` is already the required format.
- `src/db.ts` (SQL) and `src/format.ts` (JSON shapes, limit/offset parsing, bcrypt calls) are identical in every
  bun-* stack, so rows differ only in the framework layer.

## Multiple cores

`start.sh` execs `src/cluster.ts`, the launcher from Bun's docs (bun.com/docs/guides/http/cluster): it spawns
`navigator.hardwareConcurrency` copies of `src/server.ts` with `Bun.spawn`, each listening with `reusePort: true`, so
the Linux kernel (SO_REUSEPORT) spreads connections over them. The launcher only forwards SIGINT/SIGTERM to its
children; it never restarts a worker that dies. Checked on Linux (oven/bun:1.4.4 container, `--cpus 4`): 4
listeners, 40 connections spread 4-17 per process. (`navigator.hardwareConcurrency` follows the cgroup CPU quota, so
the container got 4, not the host's 14.) macOS ignores SO_REUSEPORT balancing, which only matters for local tests.

## Keep-alive

`serve(app, { bun: { idleTimeout: 75 } })` (srvx passes `bun` options to Bun.serve; Bun's default is 10 s).
Measured: idle connection closed at 76 s.

## Deviations from defaults, and why

- Validation failures are 422: `readValidatedBody` / `getValidatedQuery` get `onError: () => ({ status: 422 })`
  (h3's default is 400). Malformed JSON is `HTTPError(400)` from `readBody`; the app-level `onError` maps 400 to
  422 and renders every `HTTPError` in the Conduit error shape.
- Auth is per-route `middleware` (route options) that parses `Token <jwt>` and stores `viewer`/`token` in
  `event.context`.
- `serve` options: `reusePort: true` (srvx's own option), `silent: true` (drops srvx's startup banner),
  `bun: { idleTimeout: 75, development: false }`. srvx's default graceful-shutdown handler is left on.
- **Passwords over 72 bytes are rejected with 422** before hashing. Bun.password would otherwise SHA-512 pre-hash
  them instead of failing like other bcrypt libraries; the contract (and the conformance suite) wants 422.
- `NODE_ENV=production`, no request logging, no compression.
