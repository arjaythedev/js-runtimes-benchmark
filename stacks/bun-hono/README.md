# bun-hono: Hono 4 on Bun

Front: direct

| Piece | Choice |
|---|---|
| Runtime | Bun 1.4.4 |
| Framework | hono 4.13.13, served as hono.dev's Bun guide shows: `export default { fetch: app.fetch, ...Bun.serve options }` |
| Driver | `Bun.sql` (built in) |
| Validator | @hono/standard-validator 0.4.0 (`sValidator`) + zod 4.6.7 |
| JWT | `hono/jwt` `sign` / `verify` (HS256) |
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

`idleTimeout: 75` in the exported server options (Bun's default is 10 s). Measured: idle connection closed at 76 s.

## Deviations from defaults, and why

- **Not using the `jwt()` middleware from `hono/jwt`.** It only accepts `Authorization: Bearer`, has no
  auth-optional mode, and answers 401 with a plain-text body. A small middleware parses `Token <jwt>` and calls
  `hono/jwt`'s `verify(token, secret, "HS256")` (which rejects any other `alg`); it also requires `exp` to be
  present, since `hono/jwt` only checks `exp` when the claim exists. Tokens are made with `hono/jwt`'s `sign`.
- Validator hook returns **422** with the Conduit error shape (sValidator's default is 400). The `json` validator
  throws `HTTPException(400)` for a malformed body; `app.onError` turns that into 422 too.
- `limit`/`offset` are validated by a zod query schema (digits only, range, offset ≤ int64 max).
- `idleTimeout: 75`, `reusePort: true`, `development: false` in the exported options (see above).
- Bun prints one "Started server" line per process at startup (its export-default behaviour); nothing per request.
- **Passwords over 72 bytes are rejected with 422** before hashing. Bun.password would otherwise SHA-512 pre-hash
  them instead of failing like other bcrypt libraries; the contract (and the conformance suite) wants 422.
- `NODE_ENV=production`, no request logging, no compression.
