# deno-hono: Conduit on Hono 4 on Deno

Front: direct

| | |
|---|---|
| Runtime | Deno 2.9.8 (V8 15.0, TypeScript 6.0.3) |
| Framework | Hono 4.13.13 (`npm:hono`; Hono's Deno page offers npm or JSR, and npm is the one that pairs with npm middleware like `@hono/standard-validator`). `export default app` run by `deno serve --parallel` |
| Driver | postgres.js 3.4.9 (`npm:postgres`), tagged templates, prepared statements (its default) |
| Validator | `@hono/standard-validator` 0.4.0 (`sValidator("json", schema, hook)`) with zod 4.6.7 schemas |
| JWT | Hono's official helper `hono/jwt` (`sign` / `verify(token, secret, "HS256")`) in a `createMiddleware` auth middleware |
| bcrypt | bcrypt 6.0.0 (`npm:bcrypt`, native N-API addon), cost 10 |
| Deps | `deno.json` (`npm:` specifiers, exact versions) + `deno.lock`; `build.sh` runs `deno install --frozen --entrypoint src/main.ts` into `./node_modules` |

## Multicore

`deno serve --parallel` with `DENO_JOBS` = number of cores (start.sh sets it from `nproc`): one process,
`DENO_JOBS` isolates, each with its own postgres.js pool of `floor(90 / DENO_JOBS)` connections (8 cores: 8 × 11).

`deno serve` binds one listening socket, cloned into every isolate, which all race to `accept()` (its
"load-balanced" listener, from Deno's `ext/net/tcp.rs`; not `SO_REUSEPORT`, on Linux too). The split is uneven:
in a Linux container test with 4 isolates and 64 keep-alive connections the isolates' CPU time was 330 / 121 / 91 / 47
ticks. Keep-alive connections stay on the isolate that accepted them.

## Keep-alive

`Deno.serve` has **no idle keep-alive timeout** and no option for one. Measured on 2.9.8: an idle keep-alive connection
still answered after 200 s. Nothing set. Compression off (Deno's default; no `compress()` middleware).

## Permissions (start.sh)

`--allow-net`, `--allow-env`, `--allow-read=.,/etc/alpine-release`, `--allow-ffi=./node_modules` (the last two for
the bcrypt addon; see deno-native's README). No `-A`.

## Deviations and notes

- **Not the built-in `jwt()` middleware**: it only accepts `Authorization: Bearer <token>` (it checks
  `parts[0].toLowerCase() !== "bearer"`) and has no optional mode. RealWorld uses `Token <jwt>`, and some endpoints
  are auth-optional, so a small `createMiddleware` reads the header and calls `hono/jwt`'s `verify`.
- `hono/jwt`'s `verify` only checks `exp` when the claim is present; the spec requires it, so the middleware
  rejects tokens without a numeric `exp` (and a `sub` that is not a decimal string).
- The json validator throws a 400 `HTTPException` on a malformed body; `app.onError` maps that to 422, as the spec
  wants for every bad body. Schema failures return 422 from the validator hook.
- int8 parsed to numbers by a postgres.js custom type; timestamps come out as `Date`, which V8 truncates to ms.
- SIGTERM: `deno serve`'s graceful shutdown never finished while pool connections were open; each isolate closes its
  pool on SIGTERM (`sql.end({ timeout: 5 })`).
- bcrypt: loads in Deno 2.9.8 from its prebuilt binaries; its install script is skipped by Deno and isn't needed.
  Passwords over 72 bytes are rejected with 422.
