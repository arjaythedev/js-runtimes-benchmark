// Conduit on Express 5 (Bun's node:http): express.json(), zod validation middleware, jose for JWT (Express has no
// official JWT helper), async handlers whose rejections Express 5 forwards to the error middleware.
import express, { type NextFunction, type Request, type Response } from "express";
import { SignJWT, jwtVerify } from "jose";
import type { z } from "zod";
import * as db from "./db";
import * as f from "./format";
import * as s from "./schemas";

const key = new TextEncoder().encode(process.env.JWT_SECRET!);
const issue = (id: string) =>
  new SignJWT({}).setProtectedHeader({ alg: "HS256" }).setSubject(String(id)).setIssuedAt().setExpirationTime("30d").sign(key);

declare global {
  namespace Express {
    interface Locals { viewer: number; token: string; body: any; query: any }
  }
}

const fail = (res: Response, status: number, msg: string) => res.status(status).json(f.errors(msg));

// ---------- middleware ----------

async function verify(h: string): Promise<number> {
  if (!h.startsWith("Token ")) return 0;
  try {
    const { payload } = await jwtVerify(h.slice(6), key, { algorithms: ["HS256"], requiredClaims: ["exp"] });
    return f.viewerFromSub(payload.sub);
  } catch {
    return 0;
  }
}
const auth = (required: boolean) => async (req: Request, res: Response, next: NextFunction) => {
  const h = req.headers.authorization;
  if (h === undefined) {
    if (required) return fail(res, 401, "unauthorized");
    res.locals.viewer = 0;
    return next();
  }
  const viewer = await verify(h);
  if (viewer === 0) return fail(res, 401, "unauthorized");
  res.locals.viewer = viewer;
  res.locals.token = h.slice(6);
  next();
};
const requireAuth = auth(true);
const optionalAuth = auth(false);

// zod validation; the parsed value goes to res.locals (Express 5's req.query is a read-only getter).
const validate = (where: "body" | "query", schema: z.ZodType) => (req: Request, res: Response, next: NextFunction) => {
  const r = schema.safeParse(req[where]);
  if (!r.success) return fail(res, 422, "invalid " + where);
  res.locals[where] = r.data;
  next();
};

// ---------- app ----------

const app = express();
app.use(express.json());

app.post("/api/users", validate("body", s.register), async (req, res) => {
  const { user } = res.locals.body as z.infer<typeof s.register>;
  if (f.tooLong(user.password)) return fail(res, 422, "password is too long");
  const hash = await f.hashPassword(user.password);
  let u;
  try { u = await db.insertUser(user.username, user.email, hash); } catch (e) {
    if (db.isUniqueViolation(e)) return fail(res, 422, "username or email is already taken");
    throw e;
  }
  res.status(201).json({ user: f.user(u, await issue(u.id)) });
});

app.post("/api/users/login", validate("body", s.login), async (req, res) => {
  const { user } = res.locals.body as z.infer<typeof s.login>;
  const u = await db.userByEmail(user.email);
  if (!u || !(await f.verifyPassword(user.password, u.password_hash))) return fail(res, 401, "invalid email or password");
  res.json({ user: f.user(u, await issue(u.id)) });
});

app.get("/api/user", requireAuth, async (req, res) => {
  const u = await db.userById(res.locals.viewer);
  if (!u) return fail(res, 401, "unauthorized");
  res.json({ user: f.user(u, res.locals.token) });
});

app.put("/api/user", requireAuth, validate("body", s.updateUser), async (req, res) => {
  const { user: b } = res.locals.body as z.infer<typeof s.updateUser>;
  if (b.password != null && f.tooLong(b.password)) return fail(res, 422, "password is too long");
  const hash = b.password == null ? null : await f.hashPassword(b.password);
  let u;
  try {
    u = await db.updateUser(res.locals.viewer, b.email ?? null, b.username ?? null, hash, b.bio ?? null, b.image ?? null);
  } catch (e) {
    if (db.isUniqueViolation(e)) return fail(res, 422, "username or email is already taken");
    throw e;
  }
  if (!u) return fail(res, 401, "unauthorized");
  res.json({ user: f.user(u, res.locals.token) });
});

// ---------- profiles ----------

app.get("/api/profiles/:username", optionalAuth, async (req, res) => {
  const p = await db.profile(res.locals.viewer, req.params.username!);
  if (!p) return fail(res, 404, "profile not found");
  res.json({ profile: f.profile(p) });
});

app.post("/api/profiles/:username/follow", requireAuth, async (req, res) => {
  const u = await db.userByUsername(req.params.username!);
  if (!u) return fail(res, 404, "profile not found");
  await db.follow(res.locals.viewer, u.id);
  res.json({ profile: f.profile(u, true) });
});

app.delete("/api/profiles/:username/follow", requireAuth, async (req, res) => {
  const u = await db.userByUsername(req.params.username!);
  if (!u) return fail(res, 404, "profile not found");
  await db.unfollow(res.locals.viewer, u.id);
  res.json({ profile: f.profile(u, false) });
});

// ---------- articles ----------

app.get("/api/articles", optionalAuth, validate("query", s.listQuery), async (req, res) => {
  const q = res.locals.query as z.infer<typeof s.listQuery>;
  const v = res.locals.viewer;
  let rows, count;
  if (q.tag) { rows = await db.listByTag(v, q.limit, q.offset, q.tag); count = await db.countByTag(q.tag); }
  else if (q.author) { rows = await db.listByAuthor(v, q.limit, q.offset, q.author); count = await db.countByAuthor(q.author); }
  else if (q.favorited) { rows = await db.listByFavorited(v, q.limit, q.offset, q.favorited); count = await db.countByFavorited(q.favorited); }
  else { rows = await db.listArticles(v, q.limit, q.offset); count = await db.countArticles(); }
  res.json({ articles: rows.map((r: any) => f.article(r, false)), articlesCount: count });
});

app.get("/api/articles/feed", requireAuth, validate("query", s.feedQuery), async (req, res) => {
  const q = res.locals.query as z.infer<typeof s.feedQuery>;
  const rows = await db.feed(res.locals.viewer, q.limit, q.offset);
  res.json({ articles: rows.map((r: any) => f.article(r, false)), articlesCount: await db.countFeed(res.locals.viewer) });
});

app.post("/api/articles", requireAuth, validate("body", s.createArticle), async (req, res) => {
  const { article: b } = res.locals.body as z.infer<typeof s.createArticle>;
  const id = await db.createArticle(res.locals.viewer, b.title, b.description, b.body, b.tagList ?? []);
  res.status(201).json({ article: f.article(await db.articleById(res.locals.viewer, id), true) });
});

app.get("/api/articles/:slug", optionalAuth, async (req, res) => {
  const row = await db.articleBySlug(res.locals.viewer, req.params.slug!);
  if (!row) return fail(res, 404, "article not found");
  res.json({ article: f.article(row, true) });
});

app.put("/api/articles/:slug", requireAuth, validate("body", s.updateArticle), async (req, res) => {
  const { article: b } = res.locals.body as z.infer<typeof s.updateArticle>;
  const a = await db.articleOwner(req.params.slug!);
  if (!a) return fail(res, 404, "article not found");
  if (Number(a.author_id) !== res.locals.viewer) return fail(res, 403, "forbidden");
  await db.updateArticle(a.id, b.title ?? null, b.description ?? null, b.body ?? null);
  res.json({ article: f.article(await db.articleById(res.locals.viewer, a.id), true) });
});

app.delete("/api/articles/:slug", requireAuth, async (req, res) => {
  const a = await db.articleOwner(req.params.slug!);
  if (!a) return fail(res, 404, "article not found");
  if (Number(a.author_id) !== res.locals.viewer) return fail(res, 403, "forbidden");
  await db.deleteArticle(a.id);
  res.status(204).end();
});

// ---------- favorites ----------

app.post("/api/articles/:slug/favorite", requireAuth, async (req, res) => {
  const id = await db.articleId(req.params.slug!);
  if (!id) return fail(res, 404, "article not found");
  await db.favorite(res.locals.viewer, id);
  res.json({ article: f.article(await db.articleById(res.locals.viewer, id), true) });
});

app.delete("/api/articles/:slug/favorite", requireAuth, async (req, res) => {
  const id = await db.articleId(req.params.slug!);
  if (!id) return fail(res, 404, "article not found");
  await db.unfavorite(res.locals.viewer, id);
  res.json({ article: f.article(await db.articleById(res.locals.viewer, id), true) });
});

// ---------- comments ----------

app.get("/api/articles/:slug/comments", optionalAuth, async (req, res) => {
  const id = await db.articleId(req.params.slug!);
  if (!id) return fail(res, 404, "article not found");
  const rows = await db.comments(res.locals.viewer, id);
  res.json({ comments: rows.map((r: any) => f.comment(r)) });
});

app.post("/api/articles/:slug/comments", requireAuth, validate("body", s.createComment), async (req, res) => {
  const { comment } = res.locals.body as z.infer<typeof s.createComment>;
  const id = await db.articleId(req.params.slug!);
  if (!id) return fail(res, 404, "article not found");
  res.status(201).json({ comment: f.comment(await db.insertComment(id, res.locals.viewer, comment.body), false) });
});

app.delete("/api/articles/:slug/comments/:id", requireAuth, async (req, res) => {
  const cid = req.params.id!;
  if (!f.isId(cid)) return fail(res, 404, "comment not found");
  const author = await db.commentAuthor(cid, req.params.slug!);
  if (author === undefined) return fail(res, 404, "comment not found");
  if (Number(author) !== res.locals.viewer) return fail(res, 403, "forbidden");
  await db.deleteComment(cid);
  res.status(204).end();
});

// ---------- tags ----------

app.get("/api/tags", async (req, res) => {
  res.json({ tags: await db.tags() });
});

// ---------- errors ----------

app.use((req: Request, res: Response) => fail(res, 404, "not found"));
app.use((err: any, req: Request, res: Response, next: NextFunction) => {
  // express.json() parse failures carry status 400: Conduit wants 422.
  if (err?.type === "entity.parse.failed") return fail(res, 422, "invalid body");
  if (typeof err?.status === "number" && err.status < 500) return fail(res, err.status, err.message);
  console.error(err);
  fail(res, 500, "internal error");
});

const server = app.listen(Number(process.env.PORT), process.env.HOST!);
// Node's 5 s default is too short for 70 s think times; headersTimeout must stay above it.
server.keepAliveTimeout = 75_000;
server.headersTimeout = 76_000;
