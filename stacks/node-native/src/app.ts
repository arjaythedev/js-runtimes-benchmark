import type { IncomingMessage, ServerResponse } from "node:http";
import bcrypt from "bcrypt";
import type { Pool } from "pg";
import { createJwt } from "./auth.ts";
import { SQL, articleJson, commentJson, profileJson, userJson } from "./db.ts";
import { HttpError, Router, readJson, send, type Ctx } from "./http.ts";
import * as v from "./validate.ts";

const BCRYPT_COST = 10;
const fail = (status: number, message: string): never => {
  throw new HttpError(status, message);
};

export function createHandler(pool: Pool, secret: string) {
  const jwt = createJwt(secret);
  const r = new Router();

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
    return { status: 200, body: { articles: p.rows.map(articleJson), articlesCount: Number(c.rows[0].count) } };
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

  r.add("POST", "/api/users", "none", async ({ req }) => {
    const u = v.wrapper(await readJson(req), "user");
    const username = v.required(u, "username");
    const email = v.required(u, "email");
    const password = v.password(v.required(u, "password")) as string;
    const hash = await bcrypt.hash(password, BCRYPT_COST);
    const { rows } = await uniqueOr422(pool.query(SQL.insertUser, [username, email, hash]));
    return { status: 201, body: { user: userJson(rows[0], await jwt.sign(rows[0].id)) } };
  });

  r.add("POST", "/api/users/login", "none", async ({ req }) => {
    const u = v.wrapper(await readJson(req), "user");
    const email = v.required(u, "email");
    const password = v.required(u, "password");
    const { rows } = await pool.query(SQL.userByEmail, [email]);
    if (rows.length === 0 || !(await bcrypt.compare(password, rows[0].password_hash)))
      fail(401, "invalid email or password");
    return { status: 200, body: { user: userJson(rows[0], await jwt.sign(rows[0].id)) } };
  });

  r.add("GET", "/api/user", "required", async (c) => {
    const { rows } = await pool.query(SQL.userById, [c.viewer]);
    if (rows.length === 0) fail(401, "user not found");
    return { status: 200, body: { user: userJson(rows[0], c.token) } };
  });

  r.add("PUT", "/api/user", "required", async (c) => {
    const u = v.wrapper(await readJson(c.req), "user");
    const email = v.optional(u, "email", true);
    const username = v.optional(u, "username", true);
    const password = v.password(v.optional(u, "password", true));
    const bio = v.optional(u, "bio", false);
    const image = v.optional(u, "image", false);
    const hash = password ? await bcrypt.hash(password, BCRYPT_COST) : null;
    const { rows } = await uniqueOr422(pool.query(SQL.updateUser, [c.viewer, email, username, hash, bio, image]));
    if (rows.length === 0) fail(401, "user not found");
    return { status: 200, body: { user: userJson(rows[0], c.token) } };
  });

  // ---- profiles ----

  r.add("GET", "/api/profiles/:username", "optional", async (c) => {
    const p = await one(SQL.profile, [c.viewer, c.params.username], "profile not found");
    return { status: 200, body: { profile: profileJson(p, p.following) } };
  });

  for (const [method, on] of [["POST", true], ["DELETE", false]] as const) {
    r.add(method, "/api/profiles/:username/follow", "required", async (c) => {
      const u = await one(SQL.userByUsername, [c.params.username], "profile not found");
      await pool.query(on ? SQL.follow : SQL.unfollow, [c.viewer, u.id]);
      return { status: 200, body: { profile: profileJson(u, on) } };
    });
  }

  // ---- articles ----

  r.add("GET", "/api/articles", "optional", async (c) => {
    const { limit, offset } = v.page(c.query);
    const page = [c.viewer, limit, offset];
    // Only the first non-empty filter in the order tag, author, favorited applies.
    const tag = c.query.get("tag");
    const author = c.query.get("author");
    const favorited = c.query.get("favorited");
    if (tag) return articleList(SQL.listByTag, SQL.countByTag, [...page, tag], [tag]);
    if (author) return articleList(SQL.listByAuthor, SQL.countByAuthor, [...page, author], [author]);
    if (favorited) return articleList(SQL.listByFavorited, SQL.countByFavorited, [...page, favorited], [favorited]);
    return articleList(SQL.listAll, SQL.countAll, page, []);
  });

  r.add("GET", "/api/articles/feed", "required", async (c) => {
    const { limit, offset } = v.page(c.query);
    return articleList(SQL.listFeed, SQL.countFeed, [c.viewer, limit, offset], [c.viewer]);
  });

  r.add("GET", "/api/articles/:slug", "optional", async (c) => {
    const a = await one(SQL.articleBySlug, [c.viewer, c.params.slug], "article not found");
    return { status: 200, body: { article: articleJson(a) } };
  });

  r.add("POST", "/api/articles", "required", async (c) => {
    const a = v.wrapper(await readJson(c.req), "article");
    const title = v.required(a, "title");
    const description = v.required(a, "description");
    const body = v.required(a, "body");
    const tags = v.tagList(a);
    const client = await pool.connect();
    let id: string;
    try {
      await client.query("BEGIN");
      ({ id } = (await client.query(SQL.insertArticle, [c.viewer, title, description, body])).rows[0]);
      if (tags.length > 0) {
        await client.query(SQL.insertTags, [tags]);
        await client.query(SQL.insertArticleTags, [id, tags]);
      }
      await client.query("COMMIT");
    } catch (e) {
      await client.query("ROLLBACK");
      throw e;
    } finally {
      client.release();
    }
    return { status: 201, body: await fullArticle(c.viewer, id) };
  });

  r.add("PUT", "/api/articles/:slug", "required", async (c) => {
    const a = v.wrapper(await readJson(c.req), "article");
    const title = v.optional(a, "title", true);
    const description = v.optional(a, "description", true);
    const body = v.optional(a, "body", true);
    const id = await ownArticleId(c.params.slug, c.viewer);
    await pool.query(SQL.updateArticle, [id, title, description, body]);
    return { status: 200, body: await fullArticle(c.viewer, id) };
  });

  r.add("DELETE", "/api/articles/:slug", "required", async (c) => {
    const id = await ownArticleId(c.params.slug, c.viewer);
    await pool.query(SQL.deleteArticle, [id]);
    return { status: 204 };
  });

  // ---- favorites ----

  for (const [method, on] of [["POST", true], ["DELETE", false]] as const) {
    r.add(method, "/api/articles/:slug/favorite", "required", async (c) => {
      const { id } = await one(SQL.articleIdBySlug, [c.params.slug], "article not found");
      await pool.query(on ? SQL.favorite : SQL.unfavorite, [c.viewer, id]);
      return { status: 200, body: await fullArticle(c.viewer, id) };
    });
  }

  // ---- comments ----

  r.add("GET", "/api/articles/:slug/comments", "optional", async (c) => {
    const { id } = await one(SQL.articleIdBySlug, [c.params.slug], "article not found");
    const { rows } = await pool.query(SQL.listComments, [c.viewer, id]);
    return { status: 200, body: { comments: rows.map(commentJson) } };
  });

  r.add("POST", "/api/articles/:slug/comments", "required", async (c) => {
    const body = v.required(v.wrapper(await readJson(c.req), "comment"), "body");
    const { id } = await one(SQL.articleIdBySlug, [c.params.slug], "article not found");
    const { rows } = await pool.query(SQL.insertComment, [id, c.viewer, body]);
    return { status: 201, body: { comment: commentJson(rows[0]) } };
  });

  r.add("DELETE", "/api/articles/:slug/comments/:id", "required", async (c) => {
    const cid = c.params.id;
    if (!/^\d{1,18}$/.test(cid)) fail(404, "comment not found");
    const row = await one(SQL.commentAuthor, [cid, c.params.slug], "comment not found");
    if (row.author_id !== c.viewer) fail(403, "not the author");
    await pool.query(SQL.deleteComment, [cid]);
    return { status: 204 };
  });

  // ---- tags ----

  r.add("GET", "/api/tags", "none", async () => {
    const { rows } = await pool.query(SQL.tags);
    return { status: 200, body: { tags: rows.map((row) => row.name as string) } };
  });

  // ---- request entry point ----

  async function handle(req: IncomingMessage): Promise<{ status: number; body?: unknown }> {
    const url = new URL(req.url ?? "/", "http://localhost");
    const m = r.match(req.method ?? "GET", url.pathname);
    if (!m) fail(404, "not found");
    const { route, params } = m!;
    const ctx: Ctx = { req, params, query: url.searchParams, viewer: "0", token: "" };
    if (route.auth !== "none") {
      const header = req.headers.authorization;
      if (header === undefined) {
        if (route.auth === "required") fail(401, "authentication required");
      } else {
        const token = header.startsWith("Token ") ? header.slice(6) : "";
        const id = token && (await jwt.verify(token));
        if (!id) fail(401, "invalid token");
        ctx.viewer = id as string;
        ctx.token = token;
      }
    }
    return route.handler(ctx);
  }

  return (req: IncomingMessage, res: ServerResponse) => {
    handle(req).then(
      ({ status, body }) => send(res, status, body),
      (err) => {
        if (err instanceof HttpError) return send(res, err.status, { errors: { body: [err.message] } });
        console.error(err);
        send(res, 500, { errors: { body: ["internal error"] } });
      },
    );
  };
}
