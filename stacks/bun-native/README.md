# bun-native: Bun.serve with built-in `routes`, no framework

Front: direct

| Piece | Choice |
|---|---|
| Runtime | Bun 1.4.4 |
| Framework | none: `Bun.serve({ routes })` (per-method route objects, `req.params`) |
| Driver | `Bun.sql` (built in) |
| Validator | hand-written (no framework, so no schema library) |
| JWT | jose 6.2.13 (HS256, `requiredClaims: ["exp"]`, `algorithms: ["HS256"]`) |
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

`Bun.serve({ idleTimeout: 75 })` (Bun's default is 10 s, max 255). Measured: an idle keep-alive connection is
closed at 76 s.

## Deviations from defaults, and why

- `idleTimeout: 75` (default 10): the workload thinks up to 70 s between requests on one connection.
- `reusePort: true`: the documented multi-process setup.
- `development: false`: Bun.serve's production mode (also implied by `NODE_ENV=production`).
- **Passwords over 72 bytes are rejected with 422** before hashing. Bun.password would otherwise SHA-512 pre-hash
  them instead of failing like other bcrypt libraries; the contract (and the conformance suite) wants 422.
- `NODE_ENV=production`, no request logging, no compression.
