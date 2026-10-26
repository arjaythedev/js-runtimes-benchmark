import { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import { sValidator } from "@hono/standard-validator";
import bcrypt from "bcrypt";
import type { Pool } from "pg";
import { createAuth, type AuthEnv } from "./auth.ts";
import { SQL, articleJson, commentJson, profileJson, userJson } from "./db.ts";
import * as schema from "./schemas.ts";

const BCRYPT_COST = 10;
const fail = (status: 401 | 403 | 404 | 422, message: string): never => {
  throw new HTTPException(status, { message });
};

// Validation failures are 422 with the API's error shape (the validator's default is a 400).
const validate = <T extends "json" | "query", S extends Parameters<typeof sValidator>[1]>(target: T, s: S) =>
  sValidator(target, s, (result, c) => {
    if (!result.success) return c.json({ errors: { body: result.error.map((i) => i.message) } }, 422);
  });

export function createApp(pool: Pool, secret: string) {
  const { requireAuth, optionalAuth, issue } = createAuth(secret);
  const app = new Hono<AuthEnv>();

  // ---- helpers ----

  async function one(text: string, values: unknown[], notFound = "not found") {
    const { rows } = await pool.query(text, values);
    if (rows.length === 0) fail(404, notFound);
    return rows[0];
  }
  const fullArticle = async (viewer: string, id: string) => ({ article: articleJson(await one(SQL.articleById, [viewer, id])) });
  async function ownArticleId(slug: string, viewer: string): Promise<string> {
    const a = await one(SQL.articleOwner, [slug], "article not found");
    if (a.author_id !== viewer) fail(403, "not the author");
    return a.id;
  }
  async function articleList(page: string, count: string, pageArgs: unknown[], countArgs: unknown[]) {
    const p = await pool.query(page, pageArgs);
    const c = await pool.query(count, countArgs);
    return { articles: p.rows.map(articleJson), articlesCount: Number(c.rows[0].count) };
  }
  async function uniqueOr422<T>(work: Promise<T>): Promise<T> {
    try {
      return await work;
    } catch (e) {
      if ((e as { code?: string }).code === "23505") fail(422, "username or email is already taken");
      throw e;
    }
  }

  // ---- users ----

  app.post("/api/users", validate("json", schema.registerBody), async (c) => {
    const { username, email, password } = c.req.valid("json").user;
    const hash = await bcrypt.hash(password, BCRYPT_COST);
    const { rows } = await uniqueOr422(pool.query(SQL.insertUser, [username, email, hash]));
    return c.json({ user: userJson(rows[0], await issue(rows[0].id)) }, 201);
  });

  app.post("/api/users/login", validate("json", schema.loginBody), async (c) => {
    const { email, password } = c.req.valid("json").user;
    const { rows } = await pool.query(SQL.userByEmail, [email]);
    if (rows.length === 0 || !(await bcrypt.compare(password, rows[0].password_hash)))
      fail(401, "invalid email or password");
    return c.json({ user: userJson(rows[0], await issue(rows[0].id)) });
  });

  app.get("/api/user", requireAuth, async (c) => {
    const { rows } = await pool.query(SQL.userById, [c.var.viewer]);
    if (rows.length === 0) fail(401, "user not found");
    return c.json({ user: userJson(rows[0], c.var.token) });
  });

  app.put("/api/user", requireAuth, validate("json", schema.updateUserBody), async (c) => {
    const u = c.req.valid("json").user;
    const hash = u.password ? await bcrypt.hash(u.password, BCRYPT_COST) : null;
    const { rows } = await uniqueOr422(
      pool.query(SQL.updateUser, [c.var.viewer, u.email ?? null, u.username ?? null, hash, u.bio ?? null, u.image ?? null]),
    );
    if (rows.length === 0) fail(401, "user not found");
    return c.json({ user: userJson(rows[0], c.var.token) });
  });

  // ---- profiles ----

  app.get("/api/profiles/:username", optionalAuth, async (c) => {
    const p = await one(SQL.profile, [c.var.viewer, c.req.param("username")], "profile not found");
    return c.json({ profile: profileJson(p, p.following) });
  });

  for (const [method, on] of [["post", true], ["delete", false]] as const) {
    app[method]("/api/profiles/:username/follow", requireAuth, async (c) => {
      const u = await one(SQL.userByUsername, [c.req.param("username")], "profile not found");
      await pool.query(on ? SQL.follow : SQL.unfollow, [c.var.viewer, u.id]);
      return c.json({ profile: profileJson(u, on) });
    });
  }

  // ---- articles ----

  app.get("/api/articles", optionalAuth, validate("query", schema.listQuery), async (c) => {
    const q = c.req.valid("query");
    const page = [c.var.viewer, q.limit, q.offset];
    // Only the first non-empty filter in the order tag, author, favorited applies.
    if (q.tag) return c.json(await articleList(SQL.listByTag, SQL.countByTag, [...page, q.tag], [q.tag]));
    if (q.author) return c.json(await articleList(SQL.listByAuthor, SQL.countByAuthor, [...page, q.author], [q.author]));
    if (q.favorited)
      return c.json(await articleList(SQL.listByFavorited, SQL.countByFavorited, [...page, q.favorited], [q.favorited]));
    return c.json(await articleList(SQL.listAll, SQL.countAll, page, []));
  });

  app.get("/api/articles/feed", requireAuth, validate("query", schema.pageQuery), async (c) => {
    const q = c.req.valid("query");
    const v = c.var.viewer;
    return c.json(await articleList(SQL.listFeed, SQL.countFeed, [v, q.limit, q.offset], [v]));
  });

  app.get("/api/articles/:slug", optionalAuth, async (c) => {
    const a = await one(SQL.articleBySlug, [c.var.viewer, c.req.param("slug")], "article not found");
    return c.json({ article: articleJson(a) });
  });

  app.post("/api/articles", requireAuth, validate("json", schema.createArticleBody), async (c) => {
    const a = c.req.valid("json").article;
    const v = c.var.viewer;
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
    return c.json(await fullArticle(v, id), 201);
  });

  app.put("/api/articles/:slug", requireAuth, validate("json", schema.updateArticleBody), async (c) => {
    const a = c.req.valid("json").article;
    const v = c.var.viewer;
    const id = await ownArticleId(c.req.param("slug"), v);
    await pool.query(SQL.updateArticle, [id, a.title ?? null, a.description ?? null, a.body ?? null]);
    return c.json(await fullArticle(v, id));
  });

  app.delete("/api/articles/:slug", requireAuth, async (c) => {
    const id = await ownArticleId(c.req.param("slug"), c.var.viewer);
    await pool.query(SQL.deleteArticle, [id]);
    return c.body(null, 204);
  });

  // ---- favorites ----

  for (const [method, on] of [["post", true], ["delete", false]] as const) {
    app[method]("/api/articles/:slug/favorite", requireAuth, async (c) => {
      const v = c.var.viewer;
      const { id } = await one(SQL.articleIdBySlug, [c.req.param("slug")], "article not found");
      await pool.query(on ? SQL.favorite : SQL.unfavorite, [v, id]);
      return c.json(await fullArticle(v, id));
    });
  }

  // ---- comments ----

  app.get("/api/articles/:slug/comments", optionalAuth, async (c) => {
    const { id } = await one(SQL.articleIdBySlug, [c.req.param("slug")], "article not found");
    const { rows } = await pool.query(SQL.listComments, [c.var.viewer, id]);
    return c.json({ comments: rows.map(commentJson) });
  });

  app.post("/api/articles/:slug/comments", requireAuth, validate("json", schema.createCommentBody), async (c) => {
    const { body } = c.req.valid("json").comment;
    const { id } = await one(SQL.articleIdBySlug, [c.req.param("slug")], "article not found");
    const { rows } = await pool.query(SQL.insertComment, [id, c.var.viewer, body]);
    return c.json({ comment: commentJson(rows[0]) }, 201);
  });

  app.delete("/api/articles/:slug/comments/:id", requireAuth, async (c) => {
    const cid = c.req.param("id");
    if (!/^\d{1,18}$/.test(cid)) fail(404, "comment not found");
    const row = await one(SQL.commentAuthor, [cid, c.req.param("slug")], "comment not found");
    if (row.author_id !== c.var.viewer) fail(403, "not the author");
    await pool.query(SQL.deleteComment, [cid]);
    return c.body(null, 204);
  });

  // ---- tags ----

  app.get("/api/tags", async (c) => {
    const { rows } = await pool.query(SQL.tags);
    return c.json({ tags: rows.map((r) => r.name as string) });
  });

  // ---- 404 and errors ----

  app.notFound((c) => c.json({ errors: { body: ["not found"] } }, 404));

  app.onError((err, c) => {
    if (err instanceof HTTPException) {
      // The json validator throws a 400 for a malformed or empty JSON body; this API calls that a 422.
      const status = err.status === 400 ? 422 : err.status;
      return c.json({ errors: { body: [err.message] } }, status);
    }
    console.error(err);
    return c.json({ errors: { body: ["internal error"] } }, 500);
  });

  return app;
}
