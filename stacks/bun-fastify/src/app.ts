// Conduit on Fastify 5 (Bun's node:http): JSON Schema on every route (Ajv), @fastify/jwt, auth as an onRequest
// hook, errors from setErrorHandler.
import Fastify, { type FastifyReply, type FastifyRequest } from "fastify";
import fastifyJwt from "@fastify/jwt";
import * as db from "./db";
import * as f from "./format";

declare module "@fastify/jwt" {
  interface FastifyJWT { payload: { sub: string }; user: { sub?: unknown } }
}
declare module "fastify" {
  interface FastifyRequest { viewer: number; token: string }
}

const app = Fastify({
  // Fastify's default is 72 s; the workload's think time is up to 70 s and the brief asks for >= 75 s.
  keepAliveTimeout: 75_000,
  // Fastify's Ajv coerces types by default (123 -> "123", null -> ""), which would accept the wrong JSON types
  // the API must reject with 422. Everything else in Fastify's Ajv config stays default.
  ajv: { customOptions: { coerceTypes: false } },
});
app.server.headersTimeout = 76_000;

// The Conduit scheme is `Token <jwt>`; @fastify/jwt reads only `Bearer` unless given extractToken.
app.register(fastifyJwt, {
  secret: process.env.JWT_SECRET!,
  sign: { algorithm: "HS256", expiresIn: "30d" },
  verify: {
    algorithms: ["HS256"],
    requiredClaims: ["exp"],
    extractToken: (req: FastifyRequest) => req.headers.authorization?.startsWith("Token ") ? req.headers.authorization.slice(6) : undefined,
  },
});

app.decorateRequest("viewer", 0);
app.decorateRequest("token", "");

const fail = (reply: FastifyReply, status: number, msg: string) => reply.code(status).send(f.errors(msg));

async function check(req: FastifyRequest, reply: FastifyReply) {
  try {
    const payload = await req.jwtVerify<{ sub?: unknown }>();
    req.viewer = f.viewerFromSub(payload.sub);
  } catch {
    req.viewer = 0;
  }
  if (req.viewer === 0) return fail(reply, 401, "unauthorized");
  req.token = req.headers.authorization!.slice(6);
}
const requireAuth = async (req: FastifyRequest, reply: FastifyReply) => check(req, reply);
const optionalAuth = async (req: FastifyRequest, reply: FastifyReply) => {
  if (req.headers.authorization !== undefined) return check(req, reply);
};

// ---------- JSON Schemas ----------

const str = { type: "string", minLength: 1 } as const;
const optStr = { type: ["string", "null"], minLength: 1 } as const; // absent or null: unchanged
const optText = { type: ["string", "null"] } as const;
const digits = { type: "string", pattern: "^[0-9]+$" } as const;
const wrap = (k: string, props: Record<string, unknown>, required: string[] = []) => ({
  type: "object", required: [k],
  properties: { [k]: { type: "object", required, properties: props } },
});

const S = {
  register: wrap("user", { username: str, email: str, password: str }, ["username", "email", "password"]),
  login: wrap("user", { email: str, password: str }, ["email", "password"]),
  updateUser: wrap("user", { email: optStr, username: optStr, password: optStr, bio: optText, image: optText }),
  createArticle: wrap("article", {
    title: str, description: str, body: str, tagList: { type: ["array", "null"], items: str },
  }, ["title", "description", "body"]),
  updateArticle: wrap("article", { title: optStr, description: optStr, body: optStr }),
  createComment: wrap("comment", { body: str }, ["body"]),
  listQuery: {
    type: "object",
    properties: { limit: digits, offset: digits, tag: { type: "string" }, author: { type: "string" }, favorited: { type: "string" } },
  },
  feedQuery: { type: "object", properties: { limit: digits, offset: digits } },
};

type Q = { limit?: string; offset?: string; tag?: string; author?: string; favorited?: string };
type P = { slug: string; username: string; id: string };
type B = any;

// ---------- users ----------

app.post<{ Body: B }>("/api/users", { schema: { body: S.register } }, async (req, reply) => {
  const { user } = req.body;
  if (f.tooLong(user.password)) return fail(reply, 422, "password is too long");
  const hash = await f.hashPassword(user.password);
  let u;
  try { u = await db.insertUser(user.username, user.email, hash); } catch (e) {
    if (db.isUniqueViolation(e)) return fail(reply, 422, "username or email is already taken");
    throw e;
  }
  return reply.code(201).send({ user: f.user(u, app.jwt.sign({ sub: String(u.id) })) });
});

app.post<{ Body: B }>("/api/users/login", { schema: { body: S.login } }, async (req, reply) => {
  const { user } = req.body;
  const u = await db.userByEmail(user.email);
  if (!u || !(await f.verifyPassword(user.password, u.password_hash))) return fail(reply, 401, "invalid email or password");
  return { user: f.user(u, app.jwt.sign({ sub: String(u.id) })) };
});

app.get("/api/user", { onRequest: requireAuth }, async (req, reply) => {
  const u = await db.userById(req.viewer);
  if (!u) return fail(reply, 401, "unauthorized");
  return { user: f.user(u, req.token) };
});

app.put<{ Body: B }>("/api/user", { onRequest: requireAuth, schema: { body: S.updateUser } }, async (req, reply) => {
  const b = req.body.user;
  if (b.password != null && f.tooLong(b.password)) return fail(reply, 422, "password is too long");
  const hash = b.password == null ? null : await f.hashPassword(b.password);
  let u;
  try {
    u = await db.updateUser(req.viewer, b.email ?? null, b.username ?? null, hash, b.bio ?? null, b.image ?? null);
  } catch (e) {
    if (db.isUniqueViolation(e)) return fail(reply, 422, "username or email is already taken");
    throw e;
  }
  if (!u) return fail(reply, 401, "unauthorized");
  return { user: f.user(u, req.token) };
});

// ---------- profiles ----------

app.get<{ Params: P }>("/api/profiles/:username", { onRequest: optionalAuth }, async (req, reply) => {
  const p = await db.profile(req.viewer, req.params.username);
  if (!p) return fail(reply, 404, "profile not found");
  return { profile: f.profile(p) };
});

app.post<{ Params: P }>("/api/profiles/:username/follow", { onRequest: requireAuth }, async (req, reply) => {
  const u = await db.userByUsername(req.params.username);
  if (!u) return fail(reply, 404, "profile not found");
  await db.follow(req.viewer, u.id);
  return { profile: f.profile(u, true) };
});

app.delete<{ Params: P }>("/api/profiles/:username/follow", { onRequest: requireAuth }, async (req, reply) => {
  const u = await db.userByUsername(req.params.username);
  if (!u) return fail(reply, 404, "profile not found");
  await db.unfollow(req.viewer, u.id);
  return { profile: f.profile(u, false) };
});

// ---------- articles ----------

app.get<{ Querystring: Q }>("/api/articles", { onRequest: optionalAuth, schema: { querystring: S.listQuery } }, async (req, reply) => {
  const q = req.query;
  const p = f.page(q.limit, q.offset); // range checks on top of the digits-only schema
  if (!p) return fail(reply, 422, "invalid limit or offset");
  const v = req.viewer;
  let rows, count;
  if (q.tag) { rows = await db.listByTag(v, p.limit, p.offset, q.tag); count = await db.countByTag(q.tag); }
  else if (q.author) { rows = await db.listByAuthor(v, p.limit, p.offset, q.author); count = await db.countByAuthor(q.author); }
  else if (q.favorited) { rows = await db.listByFavorited(v, p.limit, p.offset, q.favorited); count = await db.countByFavorited(q.favorited); }
  else { rows = await db.listArticles(v, p.limit, p.offset); count = await db.countArticles(); }
  return { articles: rows.map((r: any) => f.article(r, false)), articlesCount: count };
});

app.get<{ Querystring: Q }>("/api/articles/feed", { onRequest: requireAuth, schema: { querystring: S.feedQuery } }, async (req, reply) => {
  const p = f.page(req.query.limit, req.query.offset);
  if (!p) return fail(reply, 422, "invalid limit or offset");
  const rows = await db.feed(req.viewer, p.limit, p.offset);
  return { articles: rows.map((r: any) => f.article(r, false)), articlesCount: await db.countFeed(req.viewer) };
});

app.post<{ Body: B }>("/api/articles", { onRequest: requireAuth, schema: { body: S.createArticle } }, async (req, reply) => {
  const b = req.body.article;
  const id = await db.createArticle(req.viewer, b.title, b.description, b.body, b.tagList ?? []);
  return reply.code(201).send({ article: f.article(await db.articleById(req.viewer, id), true) });
});

app.get<{ Params: P }>("/api/articles/:slug", { onRequest: optionalAuth }, async (req, reply) => {
  const row = await db.articleBySlug(req.viewer, req.params.slug);
  if (!row) return fail(reply, 404, "article not found");
  return { article: f.article(row, true) };
});

app.put<{ Params: P; Body: B }>("/api/articles/:slug", { onRequest: requireAuth, schema: { body: S.updateArticle } }, async (req, reply) => {
  const b = req.body.article;
  const a = await db.articleOwner(req.params.slug);
  if (!a) return fail(reply, 404, "article not found");
  if (Number(a.author_id) !== req.viewer) return fail(reply, 403, "forbidden");
  await db.updateArticle(a.id, b.title ?? null, b.description ?? null, b.body ?? null);
  return { article: f.article(await db.articleById(req.viewer, a.id), true) };
});

app.delete<{ Params: P }>("/api/articles/:slug", { onRequest: requireAuth }, async (req, reply) => {
  const a = await db.articleOwner(req.params.slug);
  if (!a) return fail(reply, 404, "article not found");
  if (Number(a.author_id) !== req.viewer) return fail(reply, 403, "forbidden");
  await db.deleteArticle(a.id);
  return reply.code(204).send();
});

// ---------- favorites ----------

app.post<{ Params: P }>("/api/articles/:slug/favorite", { onRequest: requireAuth }, async (req, reply) => {
  const id = await db.articleId(req.params.slug);
  if (!id) return fail(reply, 404, "article not found");
  await db.favorite(req.viewer, id);
  return { article: f.article(await db.articleById(req.viewer, id), true) };
});

app.delete<{ Params: P }>("/api/articles/:slug/favorite", { onRequest: requireAuth }, async (req, reply) => {
  const id = await db.articleId(req.params.slug);
  if (!id) return fail(reply, 404, "article not found");
  await db.unfavorite(req.viewer, id);
  return { article: f.article(await db.articleById(req.viewer, id), true) };
});

// ---------- comments ----------

app.get<{ Params: P }>("/api/articles/:slug/comments", { onRequest: optionalAuth }, async (req, reply) => {
  const id = await db.articleId(req.params.slug);
  if (!id) return fail(reply, 404, "article not found");
  const rows = await db.comments(req.viewer, id);
  return { comments: rows.map((r: any) => f.comment(r)) };
});

app.post<{ Params: P; Body: B }>("/api/articles/:slug/comments", { onRequest: requireAuth, schema: { body: S.createComment } }, async (req, reply) => {
  const id = await db.articleId(req.params.slug);
  if (!id) return fail(reply, 404, "article not found");
  return reply.code(201).send({ comment: f.comment(await db.insertComment(id, req.viewer, req.body.comment.body), false) });
});

app.delete<{ Params: P }>("/api/articles/:slug/comments/:id", { onRequest: requireAuth }, async (req, reply) => {
  const cid = req.params.id;
  if (!f.isId(cid)) return fail(reply, 404, "comment not found");
  const author = await db.commentAuthor(cid, req.params.slug);
  if (author === undefined) return fail(reply, 404, "comment not found");
  if (Number(author) !== req.viewer) return fail(reply, 403, "forbidden");
  await db.deleteComment(cid);
  return reply.code(204).send();
});

// ---------- tags ----------

app.get("/api/tags", async () => ({ tags: await db.tags() }));

// ---------- errors ----------

app.setNotFoundHandler((req, reply) => fail(reply, 404, "not found"));
app.setErrorHandler((err: any, req, reply) => {
  // Schema failures (err.validation) and unparsable/empty JSON bodies (FST_ERR_CTP_*, 400) are 422 in Conduit.
  if (err.validation || err.code?.startsWith("FST_ERR_CTP_")) return fail(reply, 422, "invalid request");
  if (typeof err.statusCode === "number" && err.statusCode < 500) return fail(reply, err.statusCode, err.message);
  console.error(err);
  return fail(reply, 500, "internal error");
});

await app.listen({ host: process.env.HOST, port: Number(process.env.PORT) });
