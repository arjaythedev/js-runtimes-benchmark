# node-nest-fastify

Front: direct

| | |
|---|---|
| Runtime | Node.js 26.12.1 |
| Framework | NestJS 12.2.0 (`@nestjs/core`, `@nestjs/common`) + `@nestjs/platform-fastify` 12.2.0 (Fastify 5.12.7) |
| Build | Nest CLI 12.0.10 `nest build` (its default compiler, `tsc`, TypeScript 6.0.3); runs the compiled `dist/main.js` |
| Module format | ESM (`"type": "module"`, `nodenext`), as `nest new` scaffolds in v12 |
| Driver | `pg` 8.23.1 `Pool` |
| Validator | `ValidationPipe` + `class-validator` 0.15.1 / `class-transformer` 0.5.1 DTOs |
| JWT | `@nestjs/jwt` 12.0.3 (`jsonwebtoken` 9.0.3) in a global `AuthGuard` |
| bcrypt | `bcrypt` 6.0.0 (native, prebuilt binaries), cost 10 |

Structure follows the Nest docs: one module per domain (`users`, `profiles`, `articles` (+comments), `tags`),
plus a global `DatabaseModule` (the `pg` pool as an injectable service) and a global `AuthModule` (`JwtModule`
and the guard as `APP_GUARD`). Controllers are thin, services hold the SQL (the reference SQL from SPEC.md verbatim,
`src/common/sql.ts`). Validation is a global `ValidationPipe`; errors leave through a global catch-everything
exception filter that renders `{"errors": {"body": [...]}}`.

The only difference from `node-nest-express` is `src/main.ts` (the adapter) and `package.json`.

## Multiple cores

`node:cluster` around the Nest bootstrap: the primary forks `os.availableParallelism()` workers (8 on the box),
each creating its own Nest app and calling `listen` (cluster shares the port; Linux default round-robin scheduling).
No restart on worker exit. Pool size per worker: `floor(90 / workers)` (8 workers -> 11).

## Keep-alive

`new FastifyAdapter({ keepAliveTimeout: 75_000 })` (Fastify's own default is 72 s, Node's 5 s), plus
`server.headersTimeout = 76_000` on `app.getHttpServer()`. Verified on the laptop: an idle connection is still usable after 74 s and is closed by
the server at 76 s.

## Deviations from defaults, and why

- `keepAliveTimeout` 75 s (the experiment's rule; Fastify's default is 72 s).
- Fastify's logger stays off (its default).
- `logger: ['error', 'warn']`: Nest's default logger prints a dozen INFO bootstrap lines per worker. Nest has no
  per-request logging by default, so request handling is unaffected.
- `ValidationPipe({ whitelist: true, transform: true, errorHttpStatusCode: 422 })`: RealWorld wants 422 for
  invalid input. Unknown fields are stripped (whitelist), not rejected.
- The exception filter maps any 400 to 422 (so a malformed or empty JSON body, which Fastify's content-type parser
  rejects with a 400 `FST_ERR_CTP_*` error carrying `statusCode`, is a 422). The filter is shared with the express
  row and uses `HttpAdapterHost`, so it is adapter-agnostic.
- `AuthGuard` reads `Authorization: Token <jwt>` (RealWorld's scheme, not `Bearer`), verifies with
  `algorithms: ['HS256']`, and additionally requires `exp` to be present and `sub` to be a decimal string
  (jsonwebtoken does not require `exp` by default). Route auth mode via `Reflector.createDecorator`
  (`@Auth('optional' | 'none')`, default required), the v12 way to make metadata decorators.
- Passwords over 72 bytes are rejected with 422 (`@IsByteLength(1, 72)`): bcrypt silently truncates.
- `limit`/`offset` are validated as strings with `@Matches` patterns (rejects `+5`, ` 5`, `1.5`, empty) instead of
  `@Type(() => Number)` + `@IsInt`, because `Number(' 5')` is 5 and the spec wants 422 there.
- Comment `:id` uses `ParseIntPipe({ errorHttpStatusCode: 404 })`: a non-integer id names no comment.
- `pg` type parsers: `int8` -> JS number (counts, ids); `timestamptz` -> the RFC 3339 string, truncated to
  milliseconds from Postgres's text (the pool sets `options: '-c TimeZone=UTC'` so the text is in UTC).
  node-postgres's default Date parsing goes through float math; doing it on the string guarantees truncation.
- `NODE_ENV=production` in `start.sh`. No compression.

## Prepared statements (added after the first grid)

The pg `Pool` gets a small `Client` subclass (`pg-prepared.ts`, plugged in with Pool's documented `Client` option) that
sends every statement as a **named prepared statement**, so Postgres parses and plans each SQL text once per connection.
pg's default sends unnamed statements, which Postgres re-plans on every call: for this app's queries planning took
~0.4 ms against 0.16–0.57 ms of execution, and Node rows used ~2× the database CPU per request of the Bun (Bun.sql) and
Deno (postgres.js) rows, which prepare by default. `PG_PREPARE=0` restores pg's default; the first grid's scores were
measured that way.
