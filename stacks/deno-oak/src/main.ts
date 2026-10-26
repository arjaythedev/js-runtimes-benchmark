// Conduit on Oak 17 (jsr:@oak/oak). Served by `deno serve --parallel` through Oak's documented fetch handler
// (`export default { fetch: app.fetch }`), instead of `app.listen()`, so it can use every core.
import { Application, type Context, type Middleware, Router, type RouterContext } from "@oak/oak";
import bcrypt from "bcrypt";
import type { z } from "zod";
import { authOf, signToken } from "./auth.ts";
import { connect, type Filter, isUniqueViolation, queries } from "./db.ts";
import { articleOf, BCRYPT_COST, commentOf, errorBody, pageOf, parseUint, profileOf, userOf } from "./format.ts";
import * as S from "./schemas.ts";

const workers = Number(Deno.env.get("DENO_JOBS")) || navigator.hardwareConcurrency;
const q = queries(connect(workers));

type State = { viewer: number; token: string };

const send = (ctx: Context, status: number, body: Record<string, unknown>) => {
  ctx.response.status = status;
  ctx.response.body = body;
};
const fail = (ctx: Context, status: number, msg: string) => send(ctx, status, errorBody(msg));

// required: a missing or invalid token gives 401. optional: no header is anonymous, an invalid one is 401.
const auth = (required: boolean): Middleware<State> => async (ctx, next) => {
  const { present, viewer, token } = await authOf(ctx.request.headers.get("authorization"));
  if (viewer === 0 && (present || required)) return fail(ctx, 401, "unauthorized");
  ctx.state.viewer = viewer;
  ctx.state.token = token;
  await next();
};
const required = auth(true), optional = auth(false);

// JSON body -> zod-validated object, or null (malformed JSON, empty body, wrong shape) -> the handler sends 422.
async function bodyOf<T extends z.ZodType>(ctx: Context, schema: T): Promise<z.infer<T> | null> {
  let raw: unknown;
  try {
    raw = await ctx.request.body.json();
  } catch {
    return null;
  }
  const r = schema.safeParse(raw);
  return r.success ? r.data : null;
}

const page = (ctx: Context) =>
  pageOf(ctx.request.url.searchParams.get("limit"), ctx.request.url.searchParams.get("offset"));

const router = new Router<State>();

router.post("/api/users", async (ctx) => {
  const b = await bodyOf(ctx, S.registerBody);
  if (!b) return fail(ctx, 422, "username, email and password are required");
  const { username, email, password } = b.user;
  const hash = await bcrypt.hash(password, BCRYPT_COST);
  try {
    const [u] = await q.insertUser(username, email, hash);
    send(ctx, 201, { user: userOf(u, await signToken(u.id)) });
  } catch (e) {
    if (isUniqueViolation(e)) return fail(ctx, 422, "username or email is already taken");
    throw e;
  }
});

router.post("/api/users/login", async (ctx) => {
  const b = await bodyOf(ctx, S.loginBody);
  if (!b) return fail(ctx, 422, "email and password are required");
  const [u] = await q.userByEmail(b.user.email);
  if (!u || !(await bcrypt.compare(b.user.password, u.password_hash))) return fail(ctx, 401, "invalid email or password");
  send(ctx, 200, { user: userOf(u, await signToken(u.id)) });
});

router.get("/api/user", required, async (ctx) => {
  const [u] = await q.userById(ctx.state.viewer);
  if (!u) return fail(ctx, 401, "unauthorized");
  send(ctx, 200, { user: userOf(u, ctx.state.token) });
});

router.put("/api/user", required, async (ctx) => {
  const b = await bodyOf(ctx, S.updateUserBody);
  if (!b) return fail(ctx, 422, "invalid user fields");
  const f = b.user;
  const hash = f.password != null ? await bcrypt.hash(f.password, BCRYPT_COST) : null;
  try {
    const [u] = await q.updateUser(ctx.state.viewer, f.email ?? null, f.username ?? null, hash, f.bio ?? null, f.image ?? null);
    if (!u) return fail(ctx, 401, "unauthorized");
    send(ctx, 200, { user: userOf(u, ctx.state.token) });
  } catch (e) {
    if (isUniqueViolation(e)) return fail(ctx, 422, "username or email is already taken");
    throw e;
  }
});

router.get("/api/profiles/:username", optional, async (ctx) => {
  const [u] = await q.profile(ctx.state.viewer, ctx.params.username);
  if (!u) return fail(ctx, 404, "profile not found");
  send(ctx, 200, { profile: profileOf(u, u.following) });
});

const follow = (on: boolean) => async (ctx: RouterContext<"/api/profiles/:username/follow", { username: string }, State>) => {
  const [u] = await q.userByUsername(ctx.params.username);
  if (!u) return fail(ctx, 404, "profile not found");
  await (on ? q.follow(ctx.state.viewer, u.id) : q.unfollow(ctx.state.viewer, u.id));
  send(ctx, 200, { profile: profileOf(u, on) });
};
router.post("/api/profiles/:username/follow", required, follow(true));
router.delete("/api/profiles/:username/follow", required, follow(false));

router.get("/api/articles/feed", required, async (ctx) => {
  const p = page(ctx);
  if (!p) return fail(ctx, 422, "limit must be 1-100 and offset >= 0");
  const rows = await q.feedPage(ctx.state.viewer, p.limit, p.offset);
  const [{ count }] = await q.feedCount(ctx.state.viewer);
  send(ctx, 200, { articles: rows.map(articleOf), articlesCount: count });
});

router.get("/api/articles", optional, async (ctx) => {
  const p = page(ctx);
  if (!p) return fail(ctx, 422, "limit must be 1-100 and offset >= 0");
  // Only the first non-empty filter in the order tag, author, favorited applies.
  let filter: Filter = null;
  for (const kind of ["tag", "author", "favorited"] as const) {
    const value = ctx.request.url.searchParams.get(kind);
    if (value) { filter = { kind, value }; break; }
  }
  const rows = await q.listPage(ctx.state.viewer, p.limit, p.offset, filter);
  const [{ count }] = await q.listCount(filter);
  send(ctx, 200, { articles: rows.map(articleOf), articlesCount: count });
});

const fullArticle = async (ctx: Context<State>, id: number, status: number) => {
  const [r] = await q.articleById(ctx.state.viewer, id);
  if (!r) return fail(ctx, 404, "article not found");
  send(ctx, status, { article: articleOf(r) });
};

router.post("/api/articles", required, async (ctx) => {
  const b = await bodyOf(ctx, S.createArticleBody);
  if (!b) return fail(ctx, 422, "title, description and body are required; tagList must be an array of non-empty strings");
  const { title, description, body, tagList } = b.article;
  const id = await q.createArticle(ctx.state.viewer, title, description, body, tagList ?? []);
  await fullArticle(ctx, id, 201);
});

router.get("/api/articles/:slug", optional, async (ctx) => {
  const [r] = await q.articleBySlug(ctx.state.viewer, ctx.params.slug);
  if (!r) return fail(ctx, 404, "article not found");
  send(ctx, 200, { article: articleOf(r) });
});

router.put("/api/articles/:slug", required, async (ctx) => {
  const b = await bodyOf(ctx, S.updateArticleBody);
  if (!b) return fail(ctx, 422, "title, description and body must be non-empty strings");
  const [own] = await q.articleOwner(ctx.params.slug);
  if (!own) return fail(ctx, 404, "article not found");
  if (own.author_id !== ctx.state.viewer) return fail(ctx, 403, "not the author");
  const f = b.article;
  await q.updateArticle(own.id, f.title ?? null, f.description ?? null, f.body ?? null);
  await fullArticle(ctx, own.id, 200);
});

router.delete("/api/articles/:slug", required, async (ctx) => {
  const [own] = await q.articleOwner(ctx.params.slug);
  if (!own) return fail(ctx, 404, "article not found");
  if (own.author_id !== ctx.state.viewer) return fail(ctx, 403, "not the author");
  await q.deleteArticle(own.id);
  ctx.response.status = 204;
});

const favorite = (on: boolean) => async (ctx: RouterContext<"/api/articles/:slug/favorite", { slug: string }, State>) => {
  const [a] = await q.articleIdBySlug(ctx.params.slug);
  if (!a) return fail(ctx, 404, "article not found");
  await (on ? q.favorite(ctx.state.viewer, a.id) : q.unfavorite(ctx.state.viewer, a.id));
  await fullArticle(ctx, a.id, 200);
};
router.post("/api/articles/:slug/favorite", required, favorite(true));
router.delete("/api/articles/:slug/favorite", required, favorite(false));

router.get("/api/articles/:slug/comments", optional, async (ctx) => {
  const [a] = await q.articleIdBySlug(ctx.params.slug);
  if (!a) return fail(ctx, 404, "article not found");
  const rows = await q.comments(ctx.state.viewer, a.id);
  send(ctx, 200, { comments: rows.map((r) => commentOf(r, r.following)) });
});

router.post("/api/articles/:slug/comments", required, async (ctx) => {
  const b = await bodyOf(ctx, S.commentBody);
  if (!b) return fail(ctx, 422, "body is required");
  const [a] = await q.articleIdBySlug(ctx.params.slug);
  if (!a) return fail(ctx, 404, "article not found");
  const [row] = await q.insertComment(a.id, ctx.state.viewer, b.comment.body);
  send(ctx, 201, { comment: commentOf(row, false) });
});

router.delete("/api/articles/:slug/comments/:id", required, async (ctx) => {
  const { slug, id } = ctx.params;
  if (parseUint(id) == null) return fail(ctx, 404, "comment not found");
  const [row] = await q.commentAuthor(id, slug);
  if (!row) return fail(ctx, 404, "comment not found");
  if (row.author_id !== ctx.state.viewer) return fail(ctx, 403, "not the author");
  await q.deleteComment(id);
  ctx.response.status = 204;
});

router.get("/api/tags", async (ctx) => {
  send(ctx, 200, { tags: (await q.tags()).map((r) => r.name) });
});

const app = new Application<State>();

// Error handling middleware, as the Oak docs show: catch, log, answer with the JSON error shape.
app.use(async (ctx, next) => {
  try {
    await next();
  } catch (err) {
    console.error(err);
    fail(ctx, 500, "internal error");
  }
});
app.use(router.routes());
app.use(router.allowedMethods());
app.use((ctx) => fail(ctx, 404, "not found"));

// app.fetch is typed as a Cloudflare Worker handler (request, env, ctx); `deno serve` calls it with (request, info).
export default { fetch: app.fetch };
