# ultimate-express on Node (Conduit)

Front: direct

| | |
|---|---|
| Runtime | Node.js 26.12.1 |
| Framework | ultimate-express 2.2.3 (the Express API on uWebSockets.js; its own dependency pins uWebSockets.js 20.70.0) |
| Driver | pg 8.23.1 (`Pool`) |
| Validation | zod 4.6.7, same middleware as the Express row |
| JWT | `jose` 6.2.13 (no official helper). `Authorization: Token <jwt>`, HS256 only, `exp` required |
| Password hashing | bcrypt 6.0.0 (native), cost 10 |

## Multiple cores

`node:cluster`, one worker per `os.availableParallelism()`. ultimate-express detects that it runs in a cluster worker and has uWS listen on the port in shared mode (`SO_REUSEPORT`), so every worker owns its own listening socket and the kernel spreads connections (this is the documented cluster path in its `listen()`; verified: 14 listening sockets on a 14-core laptop, one per worker). Each worker has its own pg pool of `floor(90 / workers)` connections.

## Keep-alive

**Not configurable: uWS closes idle HTTP keep-alive connections after 10 s** (`HTTP_IDLE_TIMEOUT_S` is compiled into uWS; ultimate-express also sends `Keep-Alive: timeout=10`). Measured: an idle connection is closed after ~11.6 s (10 s plus uWS's 4 s timer granularity). Users who think longer than ~10 s reconnect on their next page.

## Deviations from the framework's defaults (and why)

- The app is the Express row's code with the import swapped to `ultimate-express`, plus
  `app.set("catch async errors", true)`: ultimate-express follows Express 4 semantics, so without this a rejected
  async handler is not forwarded to the error handler (its README's documented switch).
- Malformed JSON surfaces as the raw `SyntaxError` from its `express.json()` (not Express's `entity.parse.failed`
  400), so the error handler maps `SyntaxError` to 422.
- `app.listen(port, host)` returns the app, not an `http.Server`, so there is no keep-alive knob (see above).
- Uses ultimate-express's bundled Express 4 type definitions (it depends on `@types/express` 4).
- uWebSockets.js comes from GitHub (ultimate-express pins `uNetworking/uWebSockets.js#v20.70.0`); `npm ci`
  fetches it over HTTPS (no git/SSH needed; checked with SSH disabled). It is 20.70.0, not the 20.71.0 the uWS row
  uses, because that is what ultimate-express 2.2.3 declares; no override.

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
