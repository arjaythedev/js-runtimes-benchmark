# node-uws

Front: direct

| | |
|---|---|
| Runtime | Node.js 26.12.1 |
| Framework | uWebSockets.js v20.71.0 (GitHub release tarball, pinned with integrity in `package-lock.json`), raw `uWS.App()` API |
| Build | `tsc` (TypeScript 6.0.3) to `dist/` |
| Router | uWS's own router (`app.get/post/put/del` with `:params`, `any('/*')` for 404), plus a ~100-line helper (`src/http.ts`) |
| Driver | `pg` 8.23.1 `Pool` (one per worker thread) |
| Validator | hand-written (`src/validate.ts`, same rules as the reference Go example): uWS has no validator |
| JWT | `jose` 6.2.13 (no official uWS helper) |
| bcrypt | `bcrypt` 6.0.0 (native, loads in worker threads), cost 10 |

The helper in `src/http.ts` does what uWS's docs require: it copies params, query and the `Authorization` header out
of `HttpRequest` synchronously (it is invalid after the first `await`), registers `onAborted` before going async,
reads bodies with `res.collectBody(1 MB, ...)` (as `examples/JsonPost.mjs`), and writes each reply inside
`res.cork()`.

## Multiple cores

`worker_threads`, the first approach in uWS's `examples/WorkerThreads.mjs`: the main thread starts
`os.availableParallelism()` workers, each creates its own `uWS.App()` and listens on the same `HOST:PORT`. uWS
binds with `SO_REUSEPORT`, so on Linux the kernel spreads new connections across the threads. Pool per thread
`floor(90 / workers)`. No restart on worker exit. (macOS accepts the duplicate binds but does not balance; fine for
conformance on the laptop.)

## Keep-alive: 10 s, not configurable

uWS closes an idle HTTP connection after **10 seconds** and this can't be changed from JS:
`HTTP_IDLE_TIMEOUT_S = 10` is a `static const` in `uWebSockets/src/HttpContext.h` (and `HTTP_TIMEOUT_S = 10` in
`HttpResponse.h`) in the uWebSockets commit that v20.71.0 is built from. The `idleTimeout` option in the JS API is
for WebSockets only. Measured on the laptop: an idle keep-alive connection is closed by the server after ~9-10 s.
So this row **does not meet the 75 s rule**; users who think longer than 10 s reconnect. Meeting it would mean
patching and recompiling uWS, which is not "plain".

## Deviations from defaults, and why

- `uWebSockets.js` is loaded with `createRequire(...)('uWebSockets.js')` (the CommonJS entry): v20.71.0's ESM entry
  `ESM_wrapper.mjs` does `import uws from './index.js'`, a file the release doesn't contain, so `import uWS from
  'uWebSockets.js'` throws `ERR_MODULE_NOT_FOUND`.
- Uses the `SO_REUSEPORT` approach, not the acceptor-app approach from the same example. With the acceptor approach
  the main thread accepts every connection; worker apps that don't listen themselves also exit immediately, as the
  worker in the example only stays alive because it also listens on its own port.
- Auth: `Authorization: Token <jwt>`; `jwtVerify(token, key, { algorithms: ['HS256'], requiredClaims: ['exp'] })`;
  `sub` must be a decimal string. Tokens are signed with `iat = now`, `exp = now + 30 d` from the same clock read.
- uWS's `getHeader` returns `''` for a missing header, so an empty `Authorization:` header is treated as absent.
- Path params are `decodeURIComponent`-ed (uWS gives them raw); bodies over 1 MB are rejected (422).
- `pg` type parsers: `int8` -> number, `timestamptz` -> RFC 3339 string truncated to ms (pool session
  `TimeZone=UTC`).
- `NODE_ENV=production`. No logging, no compression.

## Prepared statements (added after the first grid)

The pg `Pool` gets a small `Client` subclass (`pg-prepared.ts`, plugged in with Pool's documented `Client` option) that
sends every statement as a **named prepared statement**, so Postgres parses and plans each SQL text once per connection.
pg's default sends unnamed statements, which Postgres re-plans on every call: for this app's queries planning took
~0.4 ms against 0.16–0.57 ms of execution, and Node rows used ~2× the database CPU per request of the Bun (Bun.sql) and
Deno (postgres.js) rows, which prepare by default. `PG_PREPARE=0` restores pg's default; the first grid's scores were
measured that way.
