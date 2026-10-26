# node-elysia

Front: direct

| | |
|---|---|
| Runtime | Node.js 26.12.1 |
| Framework | Elysia 1.4.30 with the Node adapter `@elysiajs/node` 1.4.5 (which serves through srvx 0.11.22 on `node:http`) |
| Build | `tsc` (TypeScript 6.0.3) to `dist/`, run with `node dist/index.js`, as Elysia's Node page shows |
| Driver | `pg` 8.23.1 `Pool` |
| Validator | Elysia `t` (TypeBox 0.34.52) schemas on `body` / `query` |
| JWT | `@elysiajs/jwt` 1.4.2 (jose 6.2.13) |
| bcrypt | `bcrypt` 6.0.0 (native), cost 10 |

`new Elysia({ adapter: node() })`. Plugins: `setup` (decorates the `pg` pool, `jwt`, and an `auth` macro whose
`resolve` adds `viewer`/`token`), `errors` (a global `onError` that renders `{"errors": {"body": [...]}}`, with a
custom `HttpError` registered via `.error()`), and one route plugin per domain. SQL is the reference SQL verbatim.

Note: Elysia's own docs now point to `@elysia/node`, but that package only has 2.0 pre-releases (for Elysia 2);
`@elysiajs/node` 1.4.5 is the stable adapter for Elysia 1.4.

## Multiple cores

`node:cluster`: the primary forks `os.availableParallelism()` workers, each imports the app and calls
`app.listen()`. No restart on worker exit. Pool per worker `floor(90 / workers)`. (`@elysiajs/node` defaults
`reusePort: true`, which srvx maps to `listen({ exclusive: false })`, i.e. normal cluster handle sharing.)

## Keep-alive

`app.listen({ ..., node: { keepAliveTimeout: 75_000, headersTimeout: 76_000 } })`: srvx spreads `node` into
`http.createServer(options)`. Verified: an idle connection still works after 74 s and is closed at 76 s.

## Deviations from defaults, and why

- `keepAliveTimeout` 75 s (Node default 5 s). The `node` option is not in `listen()`'s TypeScript type (which is
  Bun's `Serve`), so it is passed with a cast.
- Validation errors and body parse errors (`VALIDATION`, `PARSE`) render as 422 with the RealWorld error shape
  (Elysia's default is 422 for validation already, 400 for parse).
- Auth: `Authorization: Token <jwt>` (not `Bearer`), `jwt.verify(token, { algorithms: ['HS256'] })`, then `exp`
  must be present and `sub` a decimal string (jose doesn't require `exp`).
- Passwords over 72 bytes are rejected with 422 in the handler (bcrypt truncates; `t.String` has no byte length).
- `limit`/`offset` are `t.String({ pattern })` (digits only, range in the pattern) so `+5`, ` 5`, `1.5` and
  empty give 422.
- Comment `:id` checked against `^[0-9]+$` in the handler (404 otherwise), not `t.Numeric` (that would be 422).
- `pg` type parsers: `int8` -> number, `timestamptz` -> RFC 3339 string truncated to ms (pool session
  `TimeZone=UTC`).
- Token `iat`/`exp`: `@elysiajs/jwt` always stamps `iat` with `new Date()` inside `sign()` and computes `exp: '30d'`
  separately; jose gives `exp = iat + 30 d` unless the two calls straddle a second boundary (microseconds apart).
- `NODE_ENV=production`. Elysia doesn't log requests. No compression.

## Surprise

Elysia's fast path-extraction assumes a URL host of at least 4 characters: a request with `Host: x` (or `ab`,
`abc`) is routed to the wrong path and gets 404. Any real host (`127.0.0.1:3000`, a domain) works.

## Prepared statements (added after the first grid)

The pg `Pool` gets a small `Client` subclass (`pg-prepared.ts`, plugged in with Pool's documented `Client` option) that
sends every statement as a **named prepared statement**, so Postgres parses and plans each SQL text once per connection.
pg's default sends unnamed statements, which Postgres re-plans on every call: for this app's queries planning took
~0.4 ms against 0.16–0.57 ms of execution, and Node rows used ~2× the database CPU per request of the Bun (Bun.sql) and
Deno (postgres.js) rows, which prepare by default. `PG_PREPARE=0` restores pg's default; the first grid's scores were
measured that way.
