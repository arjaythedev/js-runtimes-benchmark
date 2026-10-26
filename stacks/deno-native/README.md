# deno-native: Conduit on plain Deno (`Deno.serve` via `deno serve`)

Front: direct

| | |
|---|---|
| Runtime | Deno 2.9.8 (V8 15.0, TypeScript 6.0.3) |
| Framework | none: `export default { fetch }` run by `deno serve --parallel`, routing with the web-standard `URLPattern` (one pattern per route, checked in order, method first) |
| Driver | postgres.js 3.4.9 (`npm:postgres`), tagged templates, prepared statements (its default) |
| Validator | zod 4.6.7 (`npm:zod`), `safeParse` in the handler |
| JWT | jose 6.2.13 (`npm:jose`), HS256, `algorithms: ["HS256"]`, `requiredClaims: ["exp"]` |
| bcrypt | bcrypt 6.0.0 (`npm:bcrypt`, native N-API addon), cost 10 |
| Deps | `deno.json` (`npm:` specifiers, exact versions) + `deno.lock`; `build.sh` runs `deno install --frozen --entrypoint src/main.ts` into `./node_modules` |

## Multicore

`deno serve --parallel` with `DENO_JOBS` = number of cores (start.sh sets it from `nproc`): one process,
`DENO_JOBS` isolates on their own threads, each running `src/main.ts` with its own postgres.js pool of
`floor(90 / DENO_JOBS)` connections (8 cores: 8 × 11 = 88).

How the connections are spread (read from Deno's source, `ext/net/tcp.rs` / `ext/http/00_serve.ts`): `deno serve`
always binds a "load-balanced" listener, which is **one listening socket cloned into every isolate, all racing to
`accept()`**. It is not `SO_REUSEPORT` hashing, on Linux either (that is only used for an explicit
`reusePort: true`). In a Linux container test (4 isolates, 256 keep-alive connections, DB-backed `GET /api/articles`)
the isolates' CPU time came out 1465 / 1435 / 668 / 488 ticks, so the split is uneven; with a trivial endpoint and
64 connections one isolate took ~90 % of the work. Keep-alive connections stay on the isolate that accepted them.

## Keep-alive

`Deno.serve` has **no idle keep-alive timeout** and no option for one (`Deno.ServeOptions` has none; hyper's
default is used). Measured on 2.9.8: an idle keep-alive connection still answered after 200 s. So nothing is set:
the ≥ 75 s requirement holds by default. Compression: `Deno.serve`'s `automaticCompression` defaults to `false`;
left off.

## Permissions (start.sh)

`--allow-net` (Postgres; `deno serve` grants its own listen address), `--allow-env` (DATABASE_URL, JWT_SECRET,
DENO_JOBS, plus env probes inside postgres.js and node-gyp-build), `--allow-read=.,/etc/alpine-release` and
`--allow-ffi=./node_modules` for the bcrypt addon. No `-A`.

## Deviations and notes

- **bcrypt on Deno**: `npm:bcrypt` loads fine in Deno 2.9.8. Deno does not run npm lifecycle scripts by default
  (`deno install` prints "Ignored build scripts for packages: npm:bcrypt@6.0.0"); none is needed because bcrypt 6
  ships prebuilt N-API binaries (`prebuilds/linux-x64/bcrypt.glibc.node`, also checked under `linux/amd64`).
  Loading it needs `--allow-ffi`, plus `--allow-read` of `/etc/alpine-release` on Linux (node-gyp-build's musl
  check throws `NotCapable` without it, it does not just return false). Hashes run off the JS thread: 8 concurrent
  cost-10 hashes take about the same wall time as 1 on Deno (Node's 4-thread libuv pool takes ~2×).
- **int8 as numbers**: postgres.js returns `bigint` columns (ids, `count(*)`) as strings by default; a custom type
  for OID 20 parses them with `Number()` (every value in this schema fits).
- **Timestamps**: postgres.js parses `timestamptz` into a `Date`; V8 truncates the microseconds to milliseconds,
  so `toISOString()` is already the required truncated RFC 3339 form.
- **Reference SQL**: written as postgres.js tagged templates (`${value}` becomes `$n`; the shared article SELECT is a
  nested `sql` fragment, so `viewer` is bound twice instead of reusing `$1`). Same statements, same order.
- **SIGTERM**: `deno serve` answers SIGTERM with a graceful shutdown (stop accepting, drain, exit when the event loop
  is empty), and the open pool connections kept the process alive forever. Each isolate adds a SIGTERM listener that
  calls `sql.end({ timeout: 5 })`; a second SIGTERM still kills at once.
- Passwords over 72 bytes are rejected with 422 (bcrypt would silently ignore the rest).
- URLPattern path groups are percent-decoded before use.
