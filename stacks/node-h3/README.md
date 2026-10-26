# H3 v2 on Node (Conduit)

Front: direct

| | |
|---|---|
| Runtime | Node.js 26.12.1 |
| Framework | h3 2.0.8, served with h3's `serve()` (srvx 1.0.6 Node adapter, node:http underneath) |
| Driver | pg 8.23.1 (`Pool`) |
| Validation | zod 4.6.7 via h3's `readValidatedBody(event, schema, { onError })` and `getValidatedQuery()` (Standard Schema) |
| JWT | `jose` 6.2.13 (H3 has no JWT helper). HS256 only, `exp` required. Auth is per-route `middleware` in the route options |
| Password hashing | bcrypt 6.0.0 (native), cost 10 |

## Multiple cores

`node:cluster`: the primary forks `os.availableParallelism()` workers and owns the listening socket (round-robin). Each worker has its own pg pool of `floor(90 / workers)` connections.

## Keep-alive

srvx `node: { keepAliveTimeout: 75_000, headersTimeout: 76_000 }` (passed to `http.createServer()`).

## Deviations from the framework's defaults (and why)

- **`node: { exclusive: false }`**. srvx listens with `exclusive: !reusePort`, i.e. exclusive by default, which
  bypasses node:cluster's shared socket: in a cluster every worker but one fails with EADDRINUSE (and with
  `silent: true` you never see it). Verified on the laptop: 3 workers, 2 EADDRINUSE. `exclusive: false` restores the
  standard cluster setup that every other Node row uses (the alternative, `reusePort: true`, would be a different
  distribution mechanism than the other Node rows).
- `serve(..., { silent: true })` (no per-worker "listening" banner) and `new H3({ silent: true })`.
- Validation `onError` gives 422 (h3's default is 400). `readBody` throws a 400 for malformed JSON; the app's
  `onError` maps 400 to 422 and renders `{"errors": {"body": [...]}}` for every error, including h3's 404.
- Route params are read with `getRouterParam(event, name, { decode: true })` (h3 v2 returns them still
  percent-encoded by default).
- srvx writes the status line without a reason phrase (`HTTP/1.1 200 `); harmless.

## Common to every Node row

- **TypeScript**: Node 26 runs the `.ts` sources directly (built-in type stripping, no flag). `build.sh` runs
  `npm ci` (lockfile, exact pins) and `tsc --noEmit` as the type check; there is no emit/bundle step. The code
  uses only erasable TS syntax (`erasableSyntaxOnly`), so nothing needs transforming at runtime.
- **Database**: `pg` (node-postgres) 8.23.1 `Pool` per worker, `max = floor(90 / workers)` (8 workers -> 11, 88
  total), other pool settings default. Reference SQL from SPEC.md verbatim. Timestamps come back as JS `Date`
  (millisecond precision; pg's parser truncates the microseconds, checked for all 10^6 fractions) and are sent
  with `toISOString()`. `bigint`/`count(*)` come back as strings; counts and comment ids go out as numbers.
- **bcrypt**: `bcrypt` 6.0.0 (native, prebuilt binary; async hash/compare on libuv's default 4-thread pool),
  cost 10. Passwords over 72 bytes are rejected with 422 (bcrypt would silently truncate them).
- `NODE_ENV=production`, no request logging, no compression. A worker that dies is not restarted.
- npm 11.20 (bundled with Node 26.12.1) no longer runs dependency install scripts unless approved; `bcrypt`'s
  install script is just `node-gyp-build`, which only picks the prebuilt binary that ships in the package, so the
  skipped script changes nothing (the warning in the build log is expected).

## Files

`install.sh` -> `install-runtime.sh` (copy of `js/install/node.sh`), `build.sh` (npm ci + tsc --noEmit),
`start.sh` (`exec node src/server.ts`), `src/server.ts` (cluster), `src/app.ts` (routes), `src/db.ts` (SQL + row
mapping).

## Prepared statements (added after the first grid)

The pg `Pool` gets a small `Client` subclass (`pg-prepared.ts`, plugged in with Pool's documented `Client` option) that
sends every statement as a **named prepared statement**, so Postgres parses and plans each SQL text once per connection.
pg's default sends unnamed statements, which Postgres re-plans on every call: for this app's queries planning took
~0.4 ms against 0.16–0.57 ms of execution, and Node rows used ~2× the database CPU per request of the Bun (Bun.sql) and
Deno (postgres.js) rows, which prepare by default. `PG_PREPARE=0` restores pg's default; the first grid's scores were
measured that way.
