import express, { type ErrorRequestHandler, type Request, type RequestHandler } from "ultimate-express";
import bcrypt from "bcrypt";
import type { Pool } from "pg";
import type { z } from "zod";
import { createJwt } from "./auth.ts";
import { SQL, articleJson, commentJson, profileJson, userJson } from "./db.ts";
import * as schema from "./schemas.ts";

declare global {
  namespace Express {
    interface Locals {
      viewer: string; // "0" when anonymous
      token: string;
    }
  }
}

class HttpError extends Error {
  status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}
const BCRYPT_COST = 10;

export function createApp(pool: Pool, secret: string) {
  const jwt = createJwt(secret);
  const app = express();
  app.disable("x-powered-by");
  app.disable("etag");
  // ultimate-express: Express 4-style routing needs this to forward rejected async handlers to the error handler.
  app.set("catch async errors", true);
  app.use(express.json());

  // ---- middleware ----

  const auth = (required: boolean): RequestHandler => async (req, res, next) => {
    const header = req.get("authorization");
    res.locals.viewer = "0";
    res.locals.token = "";
    if (header === undefined) {
      if (required) throw new HttpError(401, "authentication required");
      return next();
    }
    const token = header.startsWith("Token ") ? header.slice(6) : "";
    const id = token && (await jwt.verify(token));
    if (!id) throw new HttpError(401, "invalid token");
    res.locals.viewer = id;
    res.locals.token = token;
    next();
  };
  const requireAuth = auth(true);
  const optionalAuth = auth(false);

  // Validates req.body against a zod schema and replaces it with the parsed value.
  const validateBody = (s: z.ZodType): RequestHandler => (req, _res, next) => {
    const r = s.safeParse(req.body);
    if (!r.success) throw new HttpError(422, r.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; "));
    req.body = r.data;
    next();
  };
  function query<T extends z.ZodType>(s: T, req: Request): z.infer<T> {
    const r = s.safeParse(req.query);
    if (!r.success) throw new HttpError(422, "limit must be 1-100 and offset >= 0");
    return r.data;
  }

  // ---- helpers ----

  async function one(text: string, values: unknown[], notFound = "not found") {
    const { rows } = await pool.query(text, values);
    if (rows.length === 0) throw new HttpError(404, notFound);
    return rows[0];
  }
  const fullArticle = async (viewer: string, id: string) =>
    ({ article: articleJson(await one(SQL.articleById, [viewer, id])) });

  async function ownArticleId(slug: string, viewer: string): Promise<string> {
    const a = await one(SQL.articleOwner, [slug], "article not found");
    if (a.author_id !== viewer) throw new HttpError(403, "not the author");
    return a.id;
  }
  async function articleList(page: string, count: string, pageArgs: unknown[], countArgs: unknown[]) {
    const [p, c] = [await pool.query(page, pageArgs), await pool.query(count, countArgs)];
    return { articles: p.rows.map(articleJson), articlesCount: Number(c.rows[0].count) };
  }
  const isUniqueViolation = (e: unknown) => (e as { code?: string }).code === "23505";

  // ---- users ----

  app.post("/api/users", validateBody(schema.registerBody), async (req, res) => {
    const { username, email, password } = (req.body as z.infer<typeof schema.registerBody>).user;
    const hash = await bcrypt.hash(password, BCRYPT_COST);
    try {
      const { rows } = await pool.query(SQL.insertUser, [username, email, hash]);
      res.status(201).json({ user: userJson(rows[0], await jwt.sign(rows[0].id)) });
    } catch (e) {
      if (isUniqueViolation(e)) throw new HttpError(422, "username or email is already taken");
      throw e;
    }
  });

  app.post("/api/users/login", validateBody(schema.loginBody), async (req, res) => {
    const { email, password } = (req.body as z.infer<typeof schema.loginBody>).user;
    const { rows } = await pool.query(SQL.userByEmail, [email]);
    if (rows.length === 0 || !(await bcrypt.compare(password, rows[0].password_hash)))
      throw new HttpError(401, "invalid email or password");
    res.json({ user: userJson(rows[0], await jwt.sign(rows[0].id)) });
  });

  app.get("/api/user", requireAuth, async (_req, res) => {
    const { rows } = await pool.query(SQL.userById, [res.locals.viewer]);
    if (rows.length === 0) throw new HttpError(401, "user not found");
    res.json({ user: userJson(rows[0], res.locals.token) });
  });

  app.put("/api/user", requireAuth, validateBody(schema.updateUserBody), async (req, res) => {
    const u = (req.body as z.infer<typeof schema.updateUserBody>).user;
    const hash = u.password ? await bcrypt.hash(u.password, BCRYPT_COST) : null;
    let rows;
    try {
      ({ rows } = await pool.query(SQL.updateUser, [
        res.locals.viewer, u.email ?? null, u.username ?? null, hash, u.bio ?? null, u.image ?? null,
      ]));
    } catch (e) {
      if (isUniqueViolation(e)) throw new HttpError(422, "username or email is already taken");
      throw e;
    }
    if (rows.length === 0) throw new HttpError(401, "user not found");
    res.json({ user: userJson(rows[0], res.locals.token) });
  });

  // ---- profiles ----

  app.get("/api/profiles/:username", optionalAuth, async (req, res) => {
    const p = await one(SQL.profile, [res.locals.viewer, req.params.username], "profile not found");
    res.json({ profile: profileJson(p, p.following) });
  });

  const follow = (on: boolean): RequestHandler => async (req, res) => {
    const u = await one(SQL.userByUsername, [req.params.username], "profile not found");
    await pool.query(on ? SQL.follow : SQL.unfollow, [res.locals.viewer, u.id]);
    res.json({ profile: profileJson(u, on) });
  };
  app.post("/api/profiles/:username/follow", requireAuth, follow(true));
  app.delete("/api/profiles/:username/follow", requireAuth, follow(false));

  // ---- articles ----

  app.get("/api/articles", optionalAuth, async (req, res) => {
    const q = query(schema.listQuery, req);
    const v = res.locals.viewer;
    const page = [v, q.limit, q.offset];
    // Only the first non-empty filter in the order tag, author, favorited applies.
    if (q.tag) res.json(await articleList(SQL.listByTag, SQL.countByTag, [...page, q.tag], [q.tag]));
    else if (q.author) res.json(await articleList(SQL.listByAuthor, SQL.countByAuthor, [...page, q.author], [q.author]));
    else if (q.favorited)
      res.json(await articleList(SQL.listByFavorited, SQL.countByFavorited, [...page, q.favorited], [q.favorited]));
    else res.json(await articleList(SQL.listAll, SQL.countAll, page, []));
  });

  app.get("/api/articles/feed", requireAuth, async (req, res) => {
    const q = query(schema.pageQuery, req);
    const v = res.locals.viewer;
    res.json(await articleList(SQL.listFeed, SQL.countFeed, [v, q.limit, q.offset], [v]));
  });

  app.get("/api/articles/:slug", optionalAuth, async (req, res) => {
    const a = await one(SQL.articleBySlug, [res.locals.viewer, req.params.slug], "article not found");
    res.json({ article: articleJson(a) });
  });

  app.post("/api/articles", requireAuth, validateBody(schema.createArticleBody), async (req, res) => {
    const a = (req.body as z.infer<typeof schema.createArticleBody>).article;
    const v = res.locals.viewer;
    const client = await pool.connect();
    let id: string;
    try {
      await client.query("BEGIN");
      ({ id } = (await client.query(SQL.insertArticle, [v, a.title, a.description, a.body])).rows[0]);
      if (a.tagList && a.tagList.length > 0) {
        await client.query(SQL.insertTags, [a.tagList]);
        await client.query(SQL.insertArticleTags, [id, a.tagList]);
      }
      await client.query("COMMIT");
    } catch (e) {
      await client.query("ROLLBACK");
      throw e;
    } finally {
      client.release();
    }
    res.status(201).json(await fullArticle(v, id));
  });

  app.put("/api/articles/:slug", requireAuth, validateBody(schema.updateArticleBody), async (req, res) => {
    const a = (req.body as z.infer<typeof schema.updateArticleBody>).article;
    const v = res.locals.viewer;
    const id = await ownArticleId(req.params.slug as string, v);
    await pool.query(SQL.updateArticle, [id, a.title ?? null, a.description ?? null, a.body ?? null]);
    res.json(await fullArticle(v, id));
  });

  app.delete("/api/articles/:slug", requireAuth, async (req, res) => {
    const id = await ownArticleId(req.params.slug as string, res.locals.viewer);
    await pool.query(SQL.deleteArticle, [id]);
    res.status(204).end();
  });

  // ---- favorites ----

  const favorite = (on: boolean): RequestHandler => async (req, res) => {
    const v = res.locals.viewer;
    const { id } = await one(SQL.articleIdBySlug, [req.params.slug], "article not found");
    await pool.query(on ? SQL.favorite : SQL.unfavorite, [v, id]);
    res.json(await fullArticle(v, id));
  };
  app.post("/api/articles/:slug/favorite", requireAuth, favorite(true));
  app.delete("/api/articles/:slug/favorite", requireAuth, favorite(false));

  // ---- comments ----

  app.get("/api/articles/:slug/comments", optionalAuth, async (req, res) => {
    const { id } = await one(SQL.articleIdBySlug, [req.params.slug], "article not found");
    const { rows } = await pool.query(SQL.listComments, [res.locals.viewer, id]);
    res.json({ comments: rows.map(commentJson) });
  });

  app.post("/api/articles/:slug/comments", requireAuth, validateBody(schema.createCommentBody), async (req, res) => {
    const { body } = (req.body as z.infer<typeof schema.createCommentBody>).comment;
    const { id } = await one(SQL.articleIdBySlug, [req.params.slug], "article not found");
    const { rows } = await pool.query(SQL.insertComment, [id, res.locals.viewer, body]);
    res.status(201).json({ comment: commentJson(rows[0]) });
  });

  app.delete("/api/articles/:slug/comments/:id", requireAuth, async (req, res) => {
    const cid = req.params.id as string;
    if (!/^\d{1,18}$/.test(cid)) throw new HttpError(404, "comment not found");
    const c = await one(SQL.commentAuthor, [cid, req.params.slug], "comment not found");
    if (c.author_id !== res.locals.viewer) throw new HttpError(403, "not the author");
    await pool.query(SQL.deleteComment, [cid]);
    res.status(204).end();
  });

  // ---- tags ----

  app.get("/api/tags", async (_req, res) => {
    const { rows } = await pool.query(SQL.tags);
    res.json({ tags: rows.map((r) => r.name) });
  });

  // ---- 404 and errors ----

  app.use((_req, _res, next) => next(new HttpError(404, "not found")));

  const onError: ErrorRequestHandler = (err, _req, res, _next) => {
    let status = 500;
    let message = "internal error";
    if (err instanceof HttpError) [status, message] = [err.status, err.message];
    // express.json(): malformed JSON surfaces as the JSON.parse SyntaxError; a validation failure here.
    else if (err instanceof SyntaxError) [status, message] = [422, "malformed JSON body"];
    else if (typeof err.status === "number" && err.status < 500) [status, message] = [err.status, err.message];
    else console.error(err);
    res.status(status).json({ errors: { body: [message] } });
  };
  app.use(onError);

  return app;
}
