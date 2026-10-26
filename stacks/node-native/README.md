# Plain node:http (Conduit)

Front: direct

| | |
|---|---|
| Runtime | Node.js 26.12.1 |
| Framework | none: `node:http` `createServer` with a ~50-line router (`src/http.ts`) |
| Driver | pg 8.23.1 (`Pool`) |
| Validation | hand-written checks (`src/validate.ts`), no schema library |
| JWT | `jose` 6.2.13. HS256 only, `exp` required |
| Password hashing | bcrypt 6.0.0 (native), cost 10 |

## Multiple cores

`node:cluster`: the primary forks `os.availableParallelism()` workers and owns the listening socket (round-robin). Each worker has its own pg pool of `floor(90 / workers)` connections.

## Keep-alive

`createServer({ keepAliveTimeout: 75_000, headersTimeout: 76_000 }, handler)`.

## Deviations from the framework's defaults (and why)

- None in the framework sense: this row is the "no framework" baseline. Body is read fully, `JSON.parse`d, and
  responses are `JSON.stringify` with an explicit `Content-Length`. Unknown routes get the JSON 404.

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
