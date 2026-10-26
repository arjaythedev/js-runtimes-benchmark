# bun-elysia: Elysia 1.4 on Bun

Front: direct

| Piece | Choice |
|---|---|
| Runtime | Bun 1.4.4 |
| Framework | elysia 1.4.30, `.listen({ ...Bun.serve options })` |
| Driver | `Bun.sql` (built in) |
| Validator | Elysia `t` (TypeBox) schemas on `body` / `query` per route |
| JWT | @elysiajs/jwt 1.4.2 (`jwt.sign`, `jwt.verify`; HS256, `exp: "30d"`) |
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

`.listen({ idleTimeout: 75 })` (Bun's default is 10 s). Measured: idle connection closed at 76 s.

## Deviations from defaults, and why

- Auth is two macros (`auth`, `optionalAuth`) with `resolve`, as Elysia's macro docs show. They parse
  `Token <jwt>` themselves (the plugin has no header handling) and call `jwt.verify(token, { algorithms:
  ["HS256"], requiredClaims: ["exp"] })`: those options are passed through to jose, so a token without `exp` or with
  another `alg` is rejected.
- `onError`: `VALIDATION` (already 422 by default) and `PARSE` (400 by default, e.g. malformed or empty JSON) both
  answer 422 in the Conduit error shape.
- `limit`/`offset` use a `t.String({ pattern: "^[0-9]+$" })` query schema; the range (1..100, offset ≤ int64 max)
  is checked in the handler (`t.Numeric` would accept `1.5`, `+5`).
- `idleTimeout: 75`, `reusePort: true`, `development: false` passed to `.listen()`.
- **Passwords over 72 bytes are rejected with 422** before hashing. Bun.password would otherwise SHA-512 pre-hash
  them instead of failing like other bcrypt libraries; the contract (and the conformance suite) wants 422.
- `NODE_ENV=production`, no request logging, no compression.
