# Every way to run a JavaScript API (2026): results

22 runtime × framework stacks, the same app (RealWorld "Conduit", 19 endpoints, Postgres), each written the way its
own docs show, on current versions, load tested on one 8 vCPU box. Design and rig: [`DESIGN.md`](DESIGN.md).
Runs: 2026-10-23 → 2026-10-25.

**Score** = most users held for 5 minutes with p95 < 500 ms, p99 < 1 s, < 1% errors (warm-up, 2-minute probes
doubling then narrowing to 5%, then 5-minute holds stepping down 5% until one passes). A user is a browser-like closed-model
visitor (7 s mean think time, one keep-alive connection, ~5% writes), ~0.26 req/s each.

| Box | Role |
|---|---|
| mc-target, 8 dedicated vCPU / 16 GB (Synteq, Xeon 8260) | the JS server, nothing else |
| mu-lg4, 16 vCPU / 31 GB | Postgres 18, own cluster, pgtune "web", restarted + cache dropped before every stack |
| mc-lg1, 16 vCPU (+ mu-lg1 for three re-runs) | Go load generator |

## 1. The ranking (HTTP/1.1)

| # | Stack | Users | req/s | p95 ms | App box CPU | App RAM | DB box CPU avg / peak |
|--:|---|--:|--:|--:|--:|--:|--:|
| 1 | **Bun · Bun.serve** | **84,000** | 21,469 | 445 | 91% | 390 MB | 71% / 98% |
| 2 | Bun · Elysia | 76,000 | 19,502 | 401 | 90% | 469 MB | 66% / 96% |
| 3 | Bun · H3 | 68,000 | 17,353 | 402 | 92% | 477 MB | 59% / 84% |
| 3 | Bun · Hono | 68,000 | 17,273 | 462 | 91% | 472 MB | 58% / 90% |
| 5 | Bun · Fastify | 67,000 | 17,164 | 422 | 92% | 1,111 MB | 62% / 89% |
| 6 | Bun · Express | 62,000 | 15,993 | 318 | 92% | 1,039 MB | 55% / 80% |
| 7 | Node · uWebSockets.js | 52,000 | 13,660 | 124 | 85% | 731 MB | 54% / 74% |
| 8 | Deno · Hono | 48,000 | 12,230 | 453 | 91% | 2,321 MB | 40% / 66% |
| 9 | Node · Fastify | 46,000 | 12,181 | 26 | 79% | 1,723 MB | 46% / 67% |
| 9 | Node · ultimate-express | 46,000 | 12,080 | 119 | 90% | 1,060 MB | 53% / 65% |
| 11 | Deno · Deno.serve | 44,000 | 11,150 | 496 | 91% | 2,411 MB | 36% / 61% |
| 12 | Node · node:http (no framework) | 42,000 | 11,099 | 24 | 79% | 1,661 MB | 44% / 59% |
| 13 | Node · Express | 40,000 | 10,530 | 78 | 88% | 1,767 MB | 43% / 60% |
| 13 | Node · H3 | 40,000 | 10,587 | 38 | 83% | 1,830 MB | 45% / 58% |
| 13 | Node · Elysia | 40,000 | 10,520 | 80 | 86% | 1,722 MB | 42% / 57% |
| 13 | Deno · Oak | 40,000 | 10,116 | 500 | 92% | 2,438 MB | 33% / 42% |
| 17 | Node · Hono | 39,000 | 10,298 | 49 | 86% | 1,705 MB | 43% / 56% |
| 17 | Node · Koa | 39,000 | 10,282 | 76 | 88% | 1,746 MB | 45% / 60% |
| 19 | Node · NestJS + Fastify | 38,000 | 10,030 | 52 | 84% | 1,825 MB | 41% / 56% |
| 20 | Node · NestJS + Express | 34,000 | 8,955 | 76 | 88% | 1,805 MB | 39% / 51% |
| 21 | Deno · Fastify (npm compat) | 32,000 † | 8,219 | 346 | 95% | 1,878 MB | 27% / 37% |
| 22 | Deno · Express (npm compat) | 24,000 ‡ | 6,288 | 141 | 95% | 2,039 MB | 19% / 34% |

Node rows use named prepared statements (section 3). App box CPU and DB box CPU are averages over the 5-minute hold;
"App RAM" is the server's PSS. † capped at 32,000 (it wedges/collapses past ~40k, so the search was capped to get a clean
hold). ‡ only from a fresh start; in a normal search it degraded hold after hold (section 5).

Control: the multicore challenge's Bun submission (one process, built for the challenge) held 24,000 on this rig
(18,000 when Postgres shared the box).

## 2. Runtime beats framework

The same framework on each runtime:

| Framework | Node 26.12 | Bun 1.4.4 | Deno 2.9.8 |
|---|--:|--:|--:|
| No framework (native server) | 42,000 | **84,000** | 44,000 |
| Elysia | 40,000 | **76,000** | — |
| Hono | 39,000 | **68,000** | 48,000 |
| H3 | 40,000 | **68,000** | — |
| Fastify | 46,000 | **67,000** | 32,000 † |
| Express | 40,000 | **62,000** | 24,000 ‡ |

- **Every Bun row beats every Node and Deno row.** Express on Bun (62k) beats the fastest Node stack, raw uWebSockets.js (52k).
- **On Node the framework barely matters** once it's set up properly: everything from Koa to H3 to Elysia lands at
  39–42k; only uWS (52k) and Fastify/ultimate-express (46k) stand out, and NestJS costs ~15–25%.
- **On Bun the framework matters more** (62–84k): the runtime is fast enough that framework overhead shows.
- **Deno is in between with its own server** (44–48k), but its Node-compatibility path (Express/Fastify from npm) is the
  worst way to run JS in this test, and unstable under overload (section 5).
- Every row is CPU-bound on the app box (79–95% over the hold, 96–99% per core when checked live), not database-bound,
  except the top Bun rows, where the database box peaks at 96–98% (section 6).

## 3. node-postgres's default is a hidden tax

The first Node grid used `pg` as most code does: plain `pool.query(text, values)`. pg sends those as **unnamed**
statements, which Postgres parses and plans on every call. For this app's queries planning took ~0.4 ms vs 0.16–0.57 ms
of execution. Bun.sql and postgres.js (used by the Deno rows) prepare automatically. Re-run with every statement named
(pg's documented `name` option, via a `Client` subclass passed to `Pool`; [`stacks/_shared/pg-prepared.ts`](stacks/_shared/pg-prepared.ts)):

| Node stack | default pg | prepared | change | DB box peak, before → after |
|---|--:|--:|--:|--:|
| uWebSockets.js | 46,000 | 52,000 | +13% | 95% → 74% |
| ultimate-express | 35,000 | 46,000 | +31% | 81% → 65% |
| Fastify | 42,000 | 46,000 | +10% | 91% → 67% |
| node:http | 36,000 | 42,000 | +17% | 83% → 59% |
| H3 | 35,000 | 40,000 | +14% | 81% → 58% |
| Express | 39,000 | 40,000 | +3% | 81% → 60% |
| Elysia (Node adapter) | 32,000 | 40,000 | +25% | 74% → 57% |
| Koa | 34,000 | 39,000 | +15% | 78% → 60% |
| Hono | 35,000 | 39,000 | +11% | 78% → 56% |
| NestJS + Fastify | 33,000 | 38,000 | +15% | 76% → 56% |
| NestJS + Express | 30,000 | 34,000 | +13% | 69% → 51% |

Median +14%, and ~30–37% less database CPU per request (e.g. Fastify 67% of the DB box at 11.1k req/s → 46% at 12.2k). It doesn't close the gap to Bun: the Node rows were and are
limited by Node's own CPU (all 8 cores 96–99% busy in node-express's hold). Express gained least because Express itself
is the bottleneck. `PG_PREPARE=0` restores the default; the default-pg runs are in `results/defaultpg/`.

## 4. HTTP/2 makes it slower

Five stacks that can serve cleartext HTTP/2 (h2c, prior knowledge), same code with `H2C=1`, conformance passed over
h2c, load generator in h2c mode (one HTTP/2 connection per user, requests sequential, like the HTTP/1.1 runs):

| Stack | HTTP/1.1 | HTTP/2 | change | App RAM, h1 → h2 |
|---|--:|--:|--:|--:|
| Bun · Bun.serve | 84,000 | 80,000 | −5% (both at the DB box's limit, peak 96–98%) | 390 → 1,238 MB |
| Node · Fastify | 46,000 | 40,000 | −13% | 1,723 → 3,641 MB |
| Node · Hono | 39,000 | 33,000 | −15% | 1,705 → 3,493 MB |
| Node · node:http2 | 42,000 | 34,000 | −19% | 1,661 → 3,380 MB |
| Deno · Deno.serve | 44,000 | 28,000 ‡ | −36% | 2,411 → 3,640 MB |

HTTP/2's wins (multiplexing, header compression) are for browsers over high-latency links. Between a proxy and an app on
a fast network it is pure extra CPU and memory: every stack lost users and used 1.5–3× the memory. That's why, in 2026,
TLS/HTTP/2/HTTP/3 end at the CDN or proxy and the app speaks HTTP/1.1.
Node's h2c servers (Fastify `http2`, `node:http2`, Hono via `http2.createServer`) **refuse HTTP/1.1** entirely; Bun and
Deno serve both on one port. ‡ Deno over HTTP/2 held 28,000 only from a fresh start; after the 64k probe overloaded it,
every hold from 36k down to 20k failed (p95 ~650–970 ms at ~86–93% CPU).

**HTTP/3 was not run:** Node 26's official binary has no QUIC (`node:quic` is missing), `Deno.serve` has no HTTP/3, and
Bun's is marked "highly experimental, do not deploy".

## 5. Gotchas found along the way

1. **H3 v2's `serve()` silently breaks `node:cluster`**: srvx listens with `exclusive: true`, so all workers but one fail
   with EADDRINUSE, and `silent: true` hides it. Fix: `node: { exclusive: false }`.
2. **Bun's `node:http` ignores `reusePort`/`exclusive: false`**, so Express/Fastify on Bun need `node:cluster`
   (documented as "not battle-tested"; worked fine here).
3. **`deno serve --parallel` doesn't use SO_REUSEPORT**: every isolate accepts from one shared socket, and the split is
   uneven (one isolate took ~90% in a container test). Keep-alive connections stay where they landed.
4. **Deno's `node:cluster` works in 2.9.8** although the docs still call it a stub, but **Deno + Express wedged
   permanently** once overloaded (the primary stopped handing out connections: listen backlog full, 0 established, workers
   idle) and otherwise degraded hold after hold (32k → 20k all failed, 7.4k → 5.0k req/s; 1.5k–3.9k connections per worker).
   Deno + Fastify collapsed under overload but recovered ~30 s later.
5. **uWebSockets.js (and ultimate-express) close idle connections after 10 s**, a compile-time constant you can't
   configure; users who think longer reconnect.
6. **Node's default keep-alive is 5 s** (set to 75 s everywhere here; users think up to 70 s). Deno.serve has no idle
   timeout at all.
7. **Fastify's default `coerceTypes: 'array'`** turns `{"username": 123}` into `"123"`, accepting input the API must
   reject. Turned off.
8. **Hono's, Fastify's and Elysia's JWT helpers only read `Bearer`** (RealWorld uses `Token`); `hono/jwt`'s `verify`
   doesn't require `exp`.
9. **Bun.sql returns `int8` as strings** and **npm 11.20 skips dependency install scripts** (bcrypt works anyway from its
   prebuilt binaries); bcrypt needs `--allow-ffi` and read access to `/etc/alpine-release` on Deno.

## 6. Caveats

- **Uneven background load (≈5% of the app box).** Two monitor processes orphaned by an earlier experiment kept
  sampling the app box (~0.4 core of 8) through the whole first grid. That grid produced the **Bun and Deno** rows and the
  default-pg Node rows. They were found and killed before the prepared-statement Node re-run and the HTTP/2 runs, which
  ran clean. So Bun and Deno scores are probably a few percent low relative to the final Node rows; it doesn't change any
  ordering between runtimes.
- **The database box is at its limit for the top Bun rows** (peaks 96–98% for Bun.serve, Elysia and Bun h2c): read 84k,
  76k and 80k as "at least". Postgres can't go bigger on this VPS line (16 vCPU max).
- **Deno node-compat rows** needed a second load generator (a collapse at 64k triggered reconnect storms that stalled the
  load generator's timers, which the rules count as LG-limited) and a capped search; deno-express and deno-native over
  h2c are fresh-start scores. The stopped walk-downs are kept in `results/old/`.
- One run per stack: single-search spread on this rig is about ±1 step (5%). Differences under ~10% are within noise.
- Each stack follows its framework's docs, so validators, JWT helpers and error handling differ per row; the runtime
  pieces are the same per runtime (pg + bcrypt on Node, Bun.sql + Bun.password on Bun, postgres.js + bcrypt on Deno).
  Every README lists its deviations from defaults.

## Files

`stacks/<runtime>-<framework>/` (code + README per stack) · `results/holds.tsv` (every scored hold: users, req/s, p95,
p99, app box CPU %, app PSS MB, DB box CPU avg %, DB box CPU peak %) · `results/<stack>/SUMMARY.txt`, `search.log` ·
`results/defaultpg/` (Node rows on default pg) · `results/old/` (LG-limited, wedged and stopped runs) · `score/` (rig).
Per-second monitor CSVs (323 MB) stay on mc-lg1 in `/root/js-results`.
