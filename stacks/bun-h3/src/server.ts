// Conduit on H3 v2 (served by h3's serve(), i.e. srvx on Bun.serve): readValidatedBody / getValidatedQuery with zod,
// per-route auth middleware, HTTPError + the app's onError. One process; cluster.ts starts one per core.
import { H3, HTTPError, serve, readValidatedBody, getValidatedQuery, getRouterParam, type H3Event } from "h3";
import { SignJWT, jwtVerify } from "jose";
import * as db from "./db";
import * as f from "./format";
import * as s from "./schemas";

const key = new TextEncoder().encode(process.env.JWT_SECRET!);
const issue = (id: string) =>
  new SignJWT({}).setProtectedHeader({ alg: "HS256" }).setSubject(String(id)).setIssuedAt().setExpirationTime("30d").sign(key);

const fail = (status: number, message: string) => new HTTPError({ status, message });
const invalid = () => ({ status: 422, message: "invalid request" }); // validation failure -> 422
const body = <T extends Parameters<typeof readValidatedBody>[1]>(e: H3Event, schema: T) =>
  readValidatedBody(e, schema, { onError: invalid });
const query = <T extends Parameters<typeof getValidatedQuery>[1]>(e: H3Event, schema: T) =>
  getValidatedQuery(e, schema, { onError: invalid });
const created = (e: H3Event, v: unknown) => { e.res.status = 201; return v; };
const noContent = () => new Response(null, { status: 204 });

declare module "h3" {
  interface H3EventContext { viewer: number; token: string }
}

// Authorization: Token <jwt> (jose; h3 has no JWT helper).
async function verify(e: H3Event, h: string) {
  if (!h.startsWith("Token ")) throw fail(401, "unauthorized");
  const token = h.slice(6);
  try {
    const { payload } = await jwtVerify(token, key, { algorithms: ["HS256"], requiredClaims: ["exp"] });
    e.context.viewer = f.viewerFromSub(payload.sub);
  } catch {
    e.context.viewer = 0;
  }
  if (e.context.viewer === 0) throw fail(401, "unauthorized");
  e.context.token = token;
}
const requireAuth = { middleware: [async (e: H3Event) => { await verify(e, e.req.headers.get("authorization") ?? ""); }] };
const optionalAuth = {
  middleware: [async (e: H3Event) => {
    const h = e.req.headers.get("authorization");
    if (h === null) e.context.viewer = 0;
    else await verify(e, h);
  }],
};

const app = new H3({
  onError(error) {
    // Malformed JSON is HTTPError(400) from readBody: Conduit wants 422.
    const status = error.status === 400 ? 422 : error.status;
    if (status >= 500) console.error(error.cause ?? error);
    return Response.json(f.errors(status >= 500 ? "internal error" : error.message), { status });
  },
});

const param = (e: H3Event, name: string) => getRouterParam(e, name, { decode: true })!;

// ---------- users ----------

app.post("/api/users", async (e) => {
  const { user } = await body(e, s.register);
  if (f.tooLong(user.password)) throw fail(422, "password is too long");
  const hash = await f.hashPassword(user.password);
  let u;
  try { u = await db.insertUser(user.username, user.email, hash); } catch (err) {
    if (db.isUniqueViolation(err)) throw fail(422, "username or email is already taken");
    throw err;
  }
  return created(e, { user: f.user(u, await issue(u.id)) });
});

app.post("/api/users/login", async (e) => {
  const { user } = await body(e, s.login);
  const u = await db.userByEmail(user.email);
  if (!u || !(await f.verifyPassword(user.password, u.password_hash))) throw fail(401, "invalid email or password");
  return { user: f.user(u, await issue(u.id)) };
});

app.get("/api/user", async (e) => {
  const u = await db.userById(e.context.viewer);
  if (!u) throw fail(401, "unauthorized");
  return { user: f.user(u, e.context.token) };
}, requireAuth);

app.put("/api/user", async (e) => {
  const { user: b } = await body(e, s.updateUser);
  if (b.password != null && f.tooLong(b.password)) throw fail(422, "password is too long");
  const hash = b.password == null ? null : await f.hashPassword(b.password);
  let u;
  try {
    u = await db.updateUser(e.context.viewer, b.email ?? null, b.username ?? null, hash, b.bio ?? null, b.image ?? null);
  } catch (err) {
    if (db.isUniqueViolation(err)) throw fail(422, "username or email is already taken");
    throw err;
  }
  if (!u) throw fail(401, "unauthorized");
  return { user: f.user(u, e.context.token) };
}, requireAuth);

// ---------- profiles ----------

app.get("/api/profiles/:username", async (e) => {
  const p = await db.profile(e.context.viewer, param(e, "username"));
  if (!p) throw fail(404, "profile not found");
  return { profile: f.profile(p) };
}, optionalAuth);

app.post("/api/profiles/:username/follow", async (e) => {
  const u = await db.userByUsername(param(e, "username"));
  if (!u) throw fail(404, "profile not found");
  await db.follow(e.context.viewer, u.id);
  return { profile: f.profile(u, true) };
}, requireAuth);

app.delete("/api/profiles/:username/follow", async (e) => {
  const u = await db.userByUsername(param(e, "username"));
  if (!u) throw fail(404, "profile not found");
  await db.unfollow(e.context.viewer, u.id);
  return { profile: f.profile(u, false) };
}, requireAuth);

// ---------- articles ----------

app.get("/api/articles", async (e) => {
  const q = await query(e, s.listQuery);
  const v = e.context.viewer;
  let rows, count;
  if (q.tag) { rows = await db.listByTag(v, q.limit, q.offset, q.tag); count = await db.countByTag(q.tag); }
  else if (q.author) { rows = await db.listByAuthor(v, q.limit, q.offset, q.author); count = await db.countByAuthor(q.author); }
  else if (q.favorited) { rows = await db.listByFavorited(v, q.limit, q.offset, q.favorited); count = await db.countByFavorited(q.favorited); }
  else { rows = await db.listArticles(v, q.limit, q.offset); count = await db.countArticles(); }
  return { articles: rows.map((r: any) => f.article(r, false)), articlesCount: count };
}, optionalAuth);

app.get("/api/articles/feed", async (e) => {
  const q = await query(e, s.feedQuery);
  const rows = await db.feed(e.context.viewer, q.limit, q.offset);
  return { articles: rows.map((r: any) => f.article(r, false)), articlesCount: await db.countFeed(e.context.viewer) };
}, requireAuth);

app.post("/api/articles", async (e) => {
  const { article: b } = await body(e, s.createArticle);
  const id = await db.createArticle(e.context.viewer, b.title, b.description, b.body, b.tagList ?? []);
  return created(e, { article: f.article(await db.articleById(e.context.viewer, id), true) });
}, requireAuth);

app.get("/api/articles/:slug", async (e) => {
  const row = await db.articleBySlug(e.context.viewer, param(e, "slug"));
  if (!row) throw fail(404, "article not found");
  return { article: f.article(row, true) };
}, optionalAuth);

app.put("/api/articles/:slug", async (e) => {
  const { article: b } = await body(e, s.updateArticle);
  const a = await db.articleOwner(param(e, "slug"));
  if (!a) throw fail(404, "article not found");
  if (Number(a.author_id) !== e.context.viewer) throw fail(403, "forbidden");
  await db.updateArticle(a.id, b.title ?? null, b.description ?? null, b.body ?? null);
  return { article: f.article(await db.articleById(e.context.viewer, a.id), true) };
}, requireAuth);

app.delete("/api/articles/:slug", async (e) => {
  const a = await db.articleOwner(param(e, "slug"));
  if (!a) throw fail(404, "article not found");
  if (Number(a.author_id) !== e.context.viewer) throw fail(403, "forbidden");
  await db.deleteArticle(a.id);
  return noContent();
}, requireAuth);

// ---------- favorites ----------

app.post("/api/articles/:slug/favorite", async (e) => {
  const id = await db.articleId(param(e, "slug"));
  if (!id) throw fail(404, "article not found");
  await db.favorite(e.context.viewer, id);
  return { article: f.article(await db.articleById(e.context.viewer, id), true) };
}, requireAuth);

app.delete("/api/articles/:slug/favorite", async (e) => {
  const id = await db.articleId(param(e, "slug"));
  if (!id) throw fail(404, "article not found");
  await db.unfavorite(e.context.viewer, id);
  return { article: f.article(await db.articleById(e.context.viewer, id), true) };
}, requireAuth);

// ---------- comments ----------

app.get("/api/articles/:slug/comments", async (e) => {
  const id = await db.articleId(param(e, "slug"));
  if (!id) throw fail(404, "article not found");
  const rows = await db.comments(e.context.viewer, id);
  return { comments: rows.map((r: any) => f.comment(r)) };
}, optionalAuth);

app.post("/api/articles/:slug/comments", async (e) => {
  const { comment } = await body(e, s.createComment);
  const id = await db.articleId(param(e, "slug"));
  if (!id) throw fail(404, "article not found");
  return created(e, { comment: f.comment(await db.insertComment(id, e.context.viewer, comment.body), false) });
}, requireAuth);

app.delete("/api/articles/:slug/comments/:id", async (e) => {
  const cid = param(e, "id");
  if (!f.isId(cid)) throw fail(404, "comment not found");
  const author = await db.commentAuthor(cid, param(e, "slug"));
  if (author === undefined) throw fail(404, "comment not found");
  if (Number(author) !== e.context.viewer) throw fail(403, "forbidden");
  await db.deleteComment(cid);
  return noContent();
}, requireAuth);

// ---------- tags ----------

app.get("/api/tags", async () => ({ tags: await db.tags() }));

serve(app, {
  hostname: process.env.HOST,
  port: Number(process.env.PORT),
  reusePort: true,
  silent: true,
  bun: { idleTimeout: 75, development: false },
});
