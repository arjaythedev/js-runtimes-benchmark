# Every way to run a JavaScript API (2026)

**Question:** you're building a new JS/TS API in 2026. How much does the choice of runtime and framework change how many
users one server can handle?

## The stacks (22)

| Runtime | Frameworks |
|---|---|
| **Node 26.12.1** (LTS from 2026-10-28) | Express 5 · Fastify 5 · Hono 4 (node-server v2) · Koa 3 · NestJS 12 + Express · NestJS 12 + Fastify · H3 v2 · Elysia 1.4 (Node adapter) · uWebSockets.js v20 · ultimate-express (Express API on uWS) · plain `node:http` |
| **Bun 1.4.4** | Bun.serve (native routes) · Elysia · Hono · H3 · Express (via node:http) · Fastify (via node:http) |
| **Deno 2.9.8** | Deno.serve (native) · Hono · Oak 17 · Express (npm compat) · Fastify (npm compat) |

Versions were checked against npm/GitHub/JSR on 2026-10-23. Each stack is written the way its own docs
show: its validator, its error handling, its JWT helper. Runtime pieces follow the runtime: `pg` + `bcrypt` on Node,
`Bun.sql` + `Bun.password` on Bun, `postgres.js` + `bcrypt` on Deno. Every stack uses all 8 cores the runtime's
documented way (`node:cluster`, Bun `reusePort`, `deno serve --parallel`). Where a combination can't (e.g. node-compat
frameworks on Deno), that's a finding, not something I paper over.

## The app and the load

- **Conduit** (RealWorld Medium clone), 19 endpoints, the multicore challenge's SPEC + 197-step conformance suite.
  Seed: 100k users, 500k articles, 5M favorites, 2.5M comments (2.3 GB).
- **Load:** the challenge's custom Go load generator. Closed-model browser users (TPC-W think time 7 s, 15-minute
  sessions, ~5% writes, one keep-alive connection per user).
- **Score** = most users held for 5 minutes with p95 < 500 ms, p99 < 1 s, errors < 1% (warm-up, 2-min probes
  doubling then narrowing to 5%, 5-min hold). Same as the leaderboard.

## The boxes (Synteq, Dallas)

| Role | Box | Spec |
|---|---|---|
| App | mc-target (4 IPs: mc-target, mc-target-2 … -4) | 8 dedicated vCPU, 16 GB. Only the JS server runs here (local Postgres/Nginx stopped) |
| Postgres 18 | mu-lg4 (port 5433) | 16 vCPU, 31 GB, own cluster `18/conduit`, pgtune "web", max_connections 100. Restart + drop caches before every stack |
| Load | mc-lg1 | 16 vCPU (runs flagged LG-limited above 75% CPU) |

Postgres is on its own, bigger box so the JS process gets all 8 cores and the database is never what's being measured.
The DB box's CPU is recorded every second in every run (`monitor-db.csv`) to prove it. App ↔ DB RTT 0.21 ms.

## Phases

1. **Main grid:** all 22 stacks over HTTP/1.1 keep-alive. In 2026 that's what the app sees: TLS/HTTP/2/HTTP/3 end at the CDN
   or proxy (Cloudflare, Caddy, nginx), and nginx only got HTTP/2 to backends in April 2026, without multiplexing.
2. **HTTP/2 side test:** the stacks that can serve h2c (Fastify, Hono, node:http2, Bun.serve, Deno.serve) re-run with the
   load generator in `h2c://` mode (`js/bench`: one HTTP/2 connection per user, requests sequential, so it isolates the
   protocol).
3. **HTTP/3:** not run. Node 26's official binary has no QUIC (`node:quic` missing), `Deno.serve` has no HTTP/3, and
   Bun's is marked "highly experimental, do not deploy".

## Tooling (js/)

`stacks/<runtime>-<framework>/` (install/build/start like a challenge submission) · `install/` runtime installers ·
`score/switch.sh` (remote-DB switch) · `score/chain-js.sh` (unattended runner on mc-lg1) · `score/push.sh` ·
`score/monitor-pgbox.sh` · `bench/` (challenge loadgen + h2c mode).

Control: the challenge's bun-native entry (18,000 users with Postgres on the same box) re-run with Postgres on its own box.
