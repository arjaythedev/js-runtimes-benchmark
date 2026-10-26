# bun-fastify: Fastify 5 on Bun's node:http

Front: direct

| Piece | Choice |
|---|---|
| Runtime | Bun 1.4.4 |
| Framework | fastify 5.12.7 (`app.listen`, i.e. Bun's `node:http`) |
| Driver | `Bun.sql` (built in) |
| Validator | Fastify JSON Schema (`schema.body` / `schema.querystring`, Ajv) |
| JWT | @fastify/jwt 10.2.5 (fast-jwt 6.3.5): `app.jwt.sign`, `request.jwtVerify()` in an `onRequest` hook |
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

`start.sh` execs `src/server.ts`, a `node:cluster` primary that forks `os.availableParallelism()` workers (8 on the
box); each worker imports `src/app.ts`. No restart: a dead worker stays dead.

Why not "N processes + `reusePort`" like the Bun.serve rows: tested in an oven/bun:1.4.4 Linux container, Bun's
`node:http` `listen()` **ignores both `reusePort: true` and `exclusive: false`**: the 2nd..Nth process gets
`EADDRINUSE`. `node:cluster` (marked "not battle-tested" in Bun's compat page) does work: on Bun each HTTP worker
binds its own SO_REUSEPORT socket (instead of Node's primary round-robin), so the kernel balances. Checked: 4
workers listening, 40 connections spread 8/8/11/13. Bun's docs say this balancing is Linux-only; on macOS one
worker gets everything (fine for conformance).

## Keep-alive

`Fastify({ keepAliveTimeout: 75_000 })` (Fastify's default is 72 s) and `app.server.headersTimeout = 76_000`.
Bun's node:http honours keepAliveTimeout (measured on Linux: idle connection closed at 76 s).

## Deviations from defaults, and why

- `ajv: { customOptions: { coerceTypes: false } }`. Fastify's Ajv coerces by default, so `{"username": 123}` would
  become `"123"` and `null` would become `""`; the API must reject wrong JSON types with 422. Everything else in
  Fastify's Ajv setup is default (it still strips unknown properties).
- @fastify/jwt only reads `Bearer`; `verify.extractToken` reads `Token <jwt>`. Verify options `algorithms:
  ["HS256"]`, `requiredClaims: ["exp"]`; no verification cache (fast-jwt's default).
- `setErrorHandler` maps schema failures (`err.validation`) and `FST_ERR_CTP_*` (empty/malformed JSON, 400) to
  422 in the Conduit shape. `limit`/`offset` are digits-only strings in the querystring schema; the range is checked
  in the handler.
- `keepAliveTimeout`/`headersTimeout` as above. Logger is Fastify's default (off).
- **Passwords over 72 bytes are rejected with 422** before hashing. Bun.password would otherwise SHA-512 pre-hash
  them instead of failing like other bcrypt libraries; the contract (and the conformance suite) wants 422.
- `NODE_ENV=production`, no request logging, no compression.
