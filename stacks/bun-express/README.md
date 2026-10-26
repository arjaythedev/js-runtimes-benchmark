# bun-express: Express 5 on Bun's node:http

Front: direct

| Piece | Choice |
|---|---|
| Runtime | Bun 1.4.4 |
| Framework | express 5.3.0 (`app.listen`, i.e. Bun's `node:http`) |
| Driver | `Bun.sql` (built in) |
| Validator | zod 4.6.7 in a small `validate(where, schema)` middleware (most common Express practice) |
| JWT | jose 6.2.13 (Express has no official JWT helper) |
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

`server.keepAliveTimeout = 75_000`, `server.headersTimeout = 76_000` (Node's defaults: 5 s / 60 s). Checked that
Bun's node:http honours it: default closes an idle connection at ~6 s, 3 s → 4 s, 75 s → 76 s (measured on Linux).

## Deviations from defaults, and why

- `keepAliveTimeout`/`headersTimeout` as above.
- Express 5 forwards rejected promises from async handlers to the error middleware, so handlers are plain async
  functions. The error middleware maps body-parser's `entity.parse.failed` (400) to 422 in the Conduit shape.
- Validated data goes to `res.locals` (Express 5's `req.query` is a getter and can't be replaced).
- Express defaults left as they are: weak `ETag` on JSON responses and the `X-Powered-By` header.
- **Passwords over 72 bytes are rejected with 422** before hashing. Bun.password would otherwise SHA-512 pre-hash
  them instead of failing like other bcrypt libraries; the contract (and the conformance suite) wants 422.
- `NODE_ENV=production`, no request logging, no compression.
