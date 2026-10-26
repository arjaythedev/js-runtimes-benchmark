# deno-oak: Conduit on Oak 17 on Deno

Front: direct

| | |
|---|---|
| Runtime | Deno 2.9.8 (V8 15.0, TypeScript 6.0.3) |
| Framework | Oak 17.2.0 (`jsr:@oak/oak`): `Application` + `Router`, middleware for auth and errors |
| Driver | postgres.js 3.4.9 (`npm:postgres`), tagged templates, prepared statements (its default) |
| Validator | zod 4.6.7, `safeParse` of `ctx.request.body.json()` in the handler (Oak has no validator of its own) |
| JWT | jose 6.2.13 (Oak has no official JWT helper) |
| bcrypt | bcrypt 6.0.0 (`npm:bcrypt`, native N-API addon), cost 10 |
| Deps | `deno.json` (`jsr:`/`npm:` specifiers, exact versions) + `deno.lock`; `build.sh` runs `deno install --frozen --entrypoint src/main.ts` (npm packages into `./node_modules`, JSR modules into the Deno cache) |

## Multicore

Oak's usual entry point is `app.listen()`, which wraps a single `Deno.serve`. Oak also documents `app.fetch`, "a
method that is compatible with the Cloudflare Worker Fetch Handler", with the example
`export default { fetch: app.fetch };` (Oak README and `Application.fetch` docs on JSR). That is exactly the shape
`deno serve` takes, so this stack exports it and runs `deno serve --parallel`. Oak documents the export for Cloudflare
Workers, not for `deno serve` by name; it works unchanged (197/197).

`DENO_JOBS` = number of cores (from `nproc`); each isolate has its own postgres.js pool of `floor(90 / DENO_JOBS)`.
`deno serve` shares one listening socket between the isolates, which race to `accept()` (not `SO_REUSEPORT`), so
the split between isolates is uneven (see deno-native's README for measurements).

(`app.listen()` passes its options through to `Deno.serve`, so N processes with `reusePort: true` would also work on
Linux, but `Deno.listen({ reusePort })` is marked unstable in Deno's source and `deno serve --parallel` is what the
other Deno rows use.)

## Keep-alive

`Deno.serve` has **no idle keep-alive timeout** and no option for one; an idle connection still answered after 200 s on
2.9.8. Nothing set. Compression off (no compression middleware).

## Permissions (start.sh)

`--allow-net`, `--allow-env`, `--allow-read=.,/etc/alpine-release`, `--allow-ffi=./node_modules`. No `-A`.

## Deviations and notes

- `app.fetch` instead of `app.listen()` (see Multicore). `app.fetch` re-throws errors that escape the middleware
  stack, so the first middleware is the usual Oak try/catch error handler that answers with the JSON error shape.
- Unmatched routes get a JSON 404 from a last middleware (Oak's default is a plain-text 404).
- `app.fetch` is typed as a Cloudflare handler `(request, env, ctx)`; `deno serve` calls it with `(request, info)`.
  Only types differ.
- int8 parsed to numbers by a postgres.js custom type; timestamps come out as `Date`, which V8 truncates to ms.
- SIGTERM: each isolate closes its pool on SIGTERM so `deno serve`'s graceful shutdown can finish.
- bcrypt loads in Deno 2.9.8 from its prebuilt binaries (install script skipped, not needed). Passwords over 72 bytes
  are rejected with 422.
