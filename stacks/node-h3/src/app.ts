import { H3, HTTPError, getRouterParam, getValidatedQuery, noContent, readValidatedBody, type H3Event, type Middleware } from "h3";
import bcrypt from "bcrypt";
import type { Pool } from "pg";
import { createJwt } from "./auth.ts";
import { SQL, articleJson, commentJson, profileJson, userJson } from "./db.ts";
import * as schema from "./schemas.ts";

declare module "h3" {
  interface H3EventContext {
    viewer: string; // "0" when anonymous
    token: string;
  }
}

const BCRYPT_COST = 10;
const fail = (status: number, message: string): never => {
  throw new HTTPError({ status, message });
};
// Validation failures are 422 in this API (h3's default is 400).
const invalid = { onError: () => ({ status: 422, message: "validation failed" }) };
const param = (event: H3Event, name: string) => getRouterParam(event, name, { decode: true }) as string;

export function createApp(pool: Pool, secret: string) {
  const jwt = createJwt(secret);

  const app = new H3({
    silent: true,
    onError(error) {
      // readBody throws a 400 for a malformed JSON body; this API calls that a 422.
      const status = error.status === 400 ? 422 : error.status;
      if (status >= 500) console.error(error.cause ?? error);
      const message = status >= 500 ? "internal error" : error.message;
      return new Response(JSON.stringify({ errors: { body: [message] } }), {
        status,
        headers: { "content-type": "application/json" },
      });
    },
  });

  // ---- auth middleware ----

  const auth = (required: boolean): Middleware => async (event) => {
    const header = event.req.headers.get("authorization");
    event.context.viewer = "0";
    event.context.token = "";
    if (header === null) {
      if (required) fail(401, "authentication required");
      return;
    }
    const token = header.startsWith("Token ") ? header.slice(6) : "";
    const id = token && (await jwt.verify(token));
    if (!id) fail(401, "invalid token");
    event.context.viewer = id as string;
    event.context.token = token;
  };
  const requireAuth = { middleware: [auth(true)] };
  const optionalAuth = { middleware: [auth(false)] };

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

  app.post("/api/users", async (event) => {
    const { username, email, password } = (await readValidatedBody(event, schema.registerBody, invalid)).user;
    const hash = await bcrypt.hash(password, BCRYPT_COST);
    const { rows } = await uniqueOr422(pool.query(SQL.insertUser, [username, email, hash]));
    event.res.status = 201;
    return { user: userJson(rows[0], await jwt.sign(rows[0].id)) };
  });

  app.post("/api/users/login", async (event) => {
    const { email, password } = (await readValidatedBody(event, schema.loginBody, invalid)).user;
    const { rows } = await pool.query(SQL.userByEmail, [email]);
    if (rows.length === 0 || !(await bcrypt.compare(password, rows[0].password_hash)))
      fail(401, "invalid email or password");
    return { user: userJson(rows[0], await jwt.sign(rows[0].id)) };
  });

  app.get("/api/user", async (event) => {
    const { rows } = await pool.query(SQL.userById, [event.context.viewer]);
    if (rows.length === 0) fail(401, "user not found");
    return { user: userJson(rows[0], event.context.token) };
  }, requireAuth);

  app.put("/api/user", async (event) => {
    const u = (await readValidatedBody(event, schema.updateUserBody, invalid)).user;
    const hash = u.password ? await bcrypt.hash(u.password, BCRYPT_COST) : null;
    const { rows } = await uniqueOr422(
      pool.query(SQL.updateUser, [event.context.viewer, u.email ?? null, u.username ?? null, hash, u.bio ?? null, u.image ?? null]),
    );
    if (rows.length === 0) fail(401, "user not found");
    return { user: userJson(rows[0], event.context.token) };
  }, requireAuth);

  // ---- profiles ----

  app.get("/api/profiles/:username", async (event) => {
    const p = await one(SQL.profile, [event.context.viewer, param(event, "username")], "profile not found");
    return { profile: profileJson(p, p.following) };
  }, optionalAuth);

  for (const [method, on] of [["POST", true], ["DELETE", false]] as const) {
    app.on(method, "/api/profiles/:username/follow", async (event) => {
      const u = await one(SQL.userByUsername, [param(event, "username")], "profile not found");
      await pool.query(on ? SQL.follow : SQL.unfollow, [event.context.viewer, u.id]);
      return { profile: profileJson(u, on) };
    }, requireAuth);
  }

  // ---- articles ----

  app.get("/api/articles", async (event) => {
    const q = await getValidatedQuery(event, schema.listQuery, invalid);
    const page = [event.context.viewer, q.limit, q.offset];
    // Only the first non-empty filter in the order tag, author, favorited applies.
    if (q.tag) return articleList(SQL.listByTag, SQL.countByTag, [...page, q.tag], [q.tag]);
    if (q.author) return articleList(SQL.listByAuthor, SQL.countByAuthor, [...page, q.author], [q.author]);
    if (q.favorited) return articleList(SQL.listByFavorited, SQL.countByFavorited, [...page, q.favorited], [q.favorited]);
    return articleList(SQL.listAll, SQL.countAll, page, []);
  }, optionalAuth);

  app.get("/api/articles/feed", async (event) => {
    const q = await getValidatedQuery(event, schema.pageQuery, invalid);
    const v = event.context.viewer;
    return articleList(SQL.listFeed, SQL.countFeed, [v, q.limit, q.offset], [v]);
  }, requireAuth);

  app.get("/api/articles/:slug", async (event) => {
    const a = await one(SQL.articleBySlug, [event.context.viewer, param(event, "slug")], "article not found");
    return { article: articleJson(a) };
  }, optionalAuth);

  app.post("/api/articles", async (event) => {
    const a = (await readValidatedBody(event, schema.createArticleBody, invalid)).article;
    const v = event.context.viewer;
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
    event.res.status = 201;
    return fullArticle(v, id);
  }, requireAuth);

  app.put("/api/articles/:slug", async (event) => {
    const a = (await readValidatedBody(event, schema.updateArticleBody, invalid)).article;
    const v = event.context.viewer;
    const id = await ownArticleId(param(event, "slug"), v);
    await pool.query(SQL.updateArticle, [id, a.title ?? null, a.description ?? null, a.body ?? null]);
    return fullArticle(v, id);
  }, requireAuth);

  app.delete("/api/articles/:slug", async (event) => {
    const id = await ownArticleId(param(event, "slug"), event.context.viewer);
    await pool.query(SQL.deleteArticle, [id]);
    return noContent();
  }, requireAuth);

  // ---- favorites ----

  for (const [method, on] of [["POST", true], ["DELETE", false]] as const) {
    app.on(method, "/api/articles/:slug/favorite", async (event) => {
      const v = event.context.viewer;
      const { id } = await one(SQL.articleIdBySlug, [param(event, "slug")], "article not found");
      await pool.query(on ? SQL.favorite : SQL.unfavorite, [v, id]);
      return fullArticle(v, id);
    }, requireAuth);
  }

  // ---- comments ----

  app.get("/api/articles/:slug/comments", async (event) => {
    const { id } = await one(SQL.articleIdBySlug, [param(event, "slug")], "article not found");
    const { rows } = await pool.query(SQL.listComments, [event.context.viewer, id]);
    return { comments: rows.map(commentJson) };
  }, optionalAuth);

  app.post("/api/articles/:slug/comments", async (event) => {
    const { body } = (await readValidatedBody(event, schema.createCommentBody, invalid)).comment;
    const { id } = await one(SQL.articleIdBySlug, [param(event, "slug")], "article not found");
    const { rows } = await pool.query(SQL.insertComment, [id, event.context.viewer, body]);
    event.res.status = 201;
    return { comment: commentJson(rows[0]) };
  }, requireAuth);

  app.delete("/api/articles/:slug/comments/:id", async (event) => {
    const cid = param(event, "id");
    if (!/^\d{1,18}$/.test(cid)) fail(404, "comment not found");
    const c = await one(SQL.commentAuthor, [cid, param(event, "slug")], "comment not found");
    if (c.author_id !== event.context.viewer) fail(403, "not the author");
    await pool.query(SQL.deleteComment, [cid]);
    return noContent();
  }, requireAuth);

  // ---- tags ----

  app.get("/api/tags", async () => {
    const { rows } = await pool.query(SQL.tags);
    return { tags: rows.map((r) => r.name as string) };
  });

  return app;
}
