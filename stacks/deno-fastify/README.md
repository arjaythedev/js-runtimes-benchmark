# deno-fastify: Conduit on Fastify 5 on Deno's Node compatibility layer

Front: direct

| | |
|---|---|
| Runtime | Deno 2.9.8 (V8 15.0, TypeScript 6.0.3), Fastify running on `node:http` as Deno implements it |
| Framework | Fastify 5.12.7 (`npm:fastify`): JSON Schema request validation (Ajv) and response serialization (fast-json-stringify), `setErrorHandler`, `setNotFoundHandler` |
| Driver | postgres.js 3.4.9 (`npm:postgres`), tagged templates, prepared statements (its default) |
| Validator | Fastify's built-in JSON Schema validation (schemas shared with node-fastify) |
| JWT | `@fastify/jwt` 10.2.5 (official plugin): `sign: { algorithm: "HS256", expiresIn: "30d" }`, `verify: { algorithms: ["HS256"], requiredClaims: ["exp"], extractToken }` |
| bcrypt | bcrypt 6.0.0 (`npm:bcrypt`, native N-API addon), cost 10 |
| Deps | `deno.json` (`npm:` specifiers, exact versions) + `deno.lock`; `build.sh` runs `deno install --frozen --entrypoint src/main.ts` into `./node_modules` |

## Multicore: node:cluster works on Deno 2.9.8

Fastify listens through `node:http`, so `deno serve --parallel` is out. Deno's docs still call `node:cluster` "non-functional
stubs", but in 2.9.8 it is a real port of Node's cluster module (round-robin scheduling by default, as in Node). Tested
in a Linux container: 4 workers, 256 keep-alive connections, CPU time 1160 / 1216 / 1102 / 1270 ticks, primary idle.
(`node:http`'s `reusePort: true` with separate processes also works on Linux; not needed.)

So this stack does what node-fastify does: the primary forks `os.availableParallelism()` workers, each builds the
Fastify app with its own postgres.js pool of `floor(90 / workers)`. No restart of dead workers. SIGTERM to the primary
takes the workers down with it.

## Keep-alive

`keepAliveTimeout: 75_000` (Fastify's default is 72 s) and `http: { headersTimeout: 76_000 }`. Deno's `node:http`
honours them: idle 72 s, still answered; idle 80 s, closed. No compression plugin. `logger: false` (the default).

## Permissions (start.sh): `-A`

Deno spawns cluster workers as `deno run -A --unstable-bare-node-builtins --unstable-detect-cjs <script>`, whatever
flags the primary got, and the primary needs `--allow-run` on the deno binary to fork them, so narrower flags would
only be decoration. Workers also don't inherit `--frozen --cached-only`.

## Deviations and notes

- `ajv.customOptions.coerceTypes: false`: Fastify's default `coerceTypes: "array"` turns `{"username": 123}` into
  `"123"` (and `null` into `""`); the API must reject wrong JSON types with 422. Same as node-fastify.
- `setErrorHandler` answers schema failures and `FST_ERR_CTP_INVALID_JSON_BODY` / `FST_ERR_CTP_EMPTY_JSON_BODY` with
  422 (Fastify's default is 400), everything with the `{"errors": {"body": [...]}}` shape.
- `@fastify/jwt`'s `extractToken` reads `Authorization: Token <jwt>` (RealWorld's scheme; the plugin's default wants
  `Bearer`). The `sub` claim must be a decimal string.
- The 72-byte bcrypt limit is checked in the handler (JSON Schema `maxLength` counts characters, not bytes).
- int8 parsed to numbers by a postgres.js custom type; timestamps come out as `Date`, which V8 truncates to ms.
- bcrypt loads in Deno 2.9.8 from its prebuilt binaries (install script skipped by Deno, not needed).
