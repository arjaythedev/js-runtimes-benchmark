import Koa, { type Context, type Next } from "koa";
import { Router } from "@koa/router";
import { bodyParser } from "@koa/bodyparser";
import bcrypt from "bcrypt";
import type { Pool } from "pg";
import type { z } from "zod";
import { createJwt } from "./auth.ts";
import { SQL, articleJson, commentJson, profileJson, userJson } from "./db.ts";
import * as schema from "./schemas.ts";

type State = { viewer: string; token: string }; // viewer "0" when anonymous
type Ctx = Koa.ParameterizedContext<State>;

const BCRYPT_COST = 10;

// zod in the handler: a failed parse is a 422.
function parse<T extends z.ZodType>(s: T, input: unknown, ctx: Context): z.infer<T> {
  const r = s.safeParse(input);
  if (!r.success) ctx.throw(422, r.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; "));
  return r.data;
}

export function createApp(pool: Pool, secret: string) {
  const jwt = createJwt(secret);
  const app = new Koa<State>();
  const router = new Router<State>({ prefix: "/api" });

  // ---- middleware ----

  // Error handler first, as the Koa docs show: every error becomes {"errors": {"body": [...]}}.
  app.use(async (ctx: Context, next: Next) => {
    try {
      await next();
    } catch (err: any) {
      const status = typeof err.status === "number" ? err.status : 500;
      if (status >= 500) console.error(err);
      ctx.status = status;
      ctx.body = { errors: { body: [status >= 500 || !err.expose ? "internal error" : err.message] } };
    }
  });
  // Malformed JSON is a validation failure (422) in this API, not co-body's 400.
  app.use(bodyParser({ enableTypes: ["json"], onError: (_err, ctx) => ctx.throw(422, "malformed JSON body") }));

  const auth = (required: boolean) => async (ctx: Ctx, next: Next) => {
    const header = ctx.headers.authorization;
    ctx.state.viewer = "0";
    ctx.state.token = "";
    if (header === undefined) {
      if (required) ctx.throw(401, "authentication required");
      return next();
    }
    const token = header.startsWith("Token ") ? header.slice(6) : "";
    const id = token && (await jwt.verify(token));
    if (!id) ctx.throw(401, "invalid token");
    ctx.state.viewer = id;
    ctx.state.token = token;
    await next();
  };
  const requireAuth = auth(true);
  const optionalAuth = auth(false);

  // ---- helpers ----

  async function one(ctx: Context, text: string, values: unknown[], notFound = "not found") {
    const { rows } = await pool.query(text, values);
    if (rows.length === 0) ctx.throw(404, notFound);
    return rows[0];
  }
  const fullArticle = async (ctx: Ctx, id: string) =>
    ({ article: articleJson(await one(ctx, SQL.articleById, [ctx.state.viewer, id])) });
  async function ownArticleId(ctx: Ctx, slug: string): Promise<string> {
    const a = await one(ctx, SQL.articleOwner, [slug], "article not found");
    if (a.author_id !== ctx.state.viewer) ctx.throw(403, "not the author");
    return a.id;
  }
  async function articleList(page: string, count: string, pageArgs: unknown[], countArgs: unknown[]) {
    const p = await pool.query(page, pageArgs);
    const c = await pool.query(count, countArgs);
    return { articles: p.rows.map(articleJson), articlesCount: Number(c.rows[0].count) };
  }
  async function uniqueOr422<T>(ctx: Context, work: Promise<T>): Promise<T> {
    try {
      return await work;
    } catch (e) {
      if ((e as { code?: string }).code === "23505") ctx.throw(422, "username or email is already taken");
      throw e;
    }
  }

  // ---- users ----

  router.post("/users", async (ctx) => {
    const { username, email, password } = parse(schema.registerBody, ctx.request.body, ctx).user;
    const hash = await bcrypt.hash(password, BCRYPT_COST);
    const { rows } = await uniqueOr422(ctx, pool.query(SQL.insertUser, [username, email, hash]));
    ctx.status = 201;
    ctx.body = { user: userJson(rows[0], await jwt.sign(rows[0].id)) };
  });

  router.post("/users/login", async (ctx) => {
    const { email, password } = parse(schema.loginBody, ctx.request.body, ctx).user;
    const { rows } = await pool.query(SQL.userByEmail, [email]);
    if (rows.length === 0 || !(await bcrypt.compare(password, rows[0].password_hash)))
      ctx.throw(401, "invalid email or password");
    ctx.body = { user: userJson(rows[0], await jwt.sign(rows[0].id)) };
  });

  router.get("/user", requireAuth, async (ctx) => {
    const { rows } = await pool.query(SQL.userById, [ctx.state.viewer]);
    if (rows.length === 0) ctx.throw(401, "user not found");
    ctx.body = { user: userJson(rows[0], ctx.state.token) };
  });

  router.put("/user", requireAuth, async (ctx) => {
    const u = parse(schema.updateUserBody, ctx.request.body, ctx).user;
    const hash = u.password ? await bcrypt.hash(u.password, BCRYPT_COST) : null;
    const { rows } = await uniqueOr422(
      ctx,
      pool.query(SQL.updateUser, [ctx.state.viewer, u.email ?? null, u.username ?? null, hash, u.bio ?? null, u.image ?? null]),
    );
    if (rows.length === 0) ctx.throw(401, "user not found");
    ctx.body = { user: userJson(rows[0], ctx.state.token) };
  });

  // ---- profiles ----

  router.get("/profiles/:username", optionalAuth, async (ctx) => {
    const p = await one(ctx, SQL.profile, [ctx.state.viewer, ctx.params.username], "profile not found");
    ctx.body = { profile: profileJson(p, p.following) };
  });

  const follow = (on: boolean) => async (ctx: Ctx & { params: Record<string, string> }) => {
    const u = await one(ctx, SQL.userByUsername, [ctx.params.username], "profile not found");
    await pool.query(on ? SQL.follow : SQL.unfollow, [ctx.state.viewer, u.id]);
    ctx.body = { profile: profileJson(u, on) };
  };
  router.post("/profiles/:username/follow", requireAuth, follow(true));
  router.delete("/profiles/:username/follow", requireAuth, follow(false));

  // ---- articles ----

  router.get("/articles", optionalAuth, async (ctx) => {
    const q = parse(schema.listQuery, ctx.query, ctx);
    const page = [ctx.state.viewer, q.limit, q.offset];
    // Only the first non-empty filter in the order tag, author, favorited applies.
    if (q.tag) ctx.body = await articleList(SQL.listByTag, SQL.countByTag, [...page, q.tag], [q.tag]);
    else if (q.author) ctx.body = await articleList(SQL.listByAuthor, SQL.countByAuthor, [...page, q.author], [q.author]);
    else if (q.favorited)
      ctx.body = await articleList(SQL.listByFavorited, SQL.countByFavorited, [...page, q.favorited], [q.favorited]);
    else ctx.body = await articleList(SQL.listAll, SQL.countAll, page, []);
  });

  router.get("/articles/feed", requireAuth, async (ctx) => {
    const q = parse(schema.pageQuery, ctx.query, ctx);
    const v = ctx.state.viewer;
    ctx.body = await articleList(SQL.listFeed, SQL.countFeed, [v, q.limit, q.offset], [v]);
  });

  router.get("/articles/:slug", optionalAuth, async (ctx) => {
    const a = await one(ctx, SQL.articleBySlug, [ctx.state.viewer, ctx.params.slug], "article not found");
    ctx.body = { article: articleJson(a) };
  });

  router.post("/articles", requireAuth, async (ctx) => {
    const a = parse(schema.createArticleBody, ctx.request.body, ctx).article;
    const client = await pool.connect();
    let id: string;
    try {
      await client.query("BEGIN");
      ({ id } = (await client.query(SQL.insertArticle, [ctx.state.viewer, a.title, a.description, a.body])).rows[0]);
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
    ctx.status = 201;
    ctx.body = await fullArticle(ctx, id);
  });

  router.put("/articles/:slug", requireAuth, async (ctx) => {
    const a = parse(schema.updateArticleBody, ctx.request.body, ctx).article;
    const id = await ownArticleId(ctx, ctx.params.slug);
    await pool.query(SQL.updateArticle, [id, a.title ?? null, a.description ?? null, a.body ?? null]);
    ctx.body = await fullArticle(ctx, id);
  });

  router.delete("/articles/:slug", requireAuth, async (ctx) => {
    const id = await ownArticleId(ctx, ctx.params.slug);
    await pool.query(SQL.deleteArticle, [id]);
    ctx.status = 204;
  });

  // ---- favorites ----

  const favorite = (on: boolean) => async (ctx: Ctx & { params: Record<string, string> }) => {
    const { id } = await one(ctx, SQL.articleIdBySlug, [ctx.params.slug], "article not found");
    await pool.query(on ? SQL.favorite : SQL.unfavorite, [ctx.state.viewer, id]);
    ctx.body = await fullArticle(ctx, id);
  };
  router.post("/articles/:slug/favorite", requireAuth, favorite(true));
  router.delete("/articles/:slug/favorite", requireAuth, favorite(false));

  // ---- comments ----

  router.get("/articles/:slug/comments", optionalAuth, async (ctx) => {
    const { id } = await one(ctx, SQL.articleIdBySlug, [ctx.params.slug], "article not found");
    const { rows } = await pool.query(SQL.listComments, [ctx.state.viewer, id]);
    ctx.body = { comments: rows.map(commentJson) };
  });

  router.post("/articles/:slug/comments", requireAuth, async (ctx) => {
    const { body } = parse(schema.createCommentBody, ctx.request.body, ctx).comment;
    const { id } = await one(ctx, SQL.articleIdBySlug, [ctx.params.slug], "article not found");
    const { rows } = await pool.query(SQL.insertComment, [id, ctx.state.viewer, body]);
    ctx.status = 201;
    ctx.body = { comment: commentJson(rows[0]) };
  });

  router.delete("/articles/:slug/comments/:id", requireAuth, async (ctx) => {
    const cid = ctx.params.id;
    if (!/^\d{1,18}$/.test(cid)) ctx.throw(404, "comment not found");
    const c = await one(ctx, SQL.commentAuthor, [cid, ctx.params.slug], "comment not found");
    if (c.author_id !== ctx.state.viewer) ctx.throw(403, "not the author");
    await pool.query(SQL.deleteComment, [cid]);
    ctx.status = 204;
  });

  // ---- tags ----

  router.get("/tags", async (ctx) => {
    const { rows } = await pool.query(SQL.tags);
    ctx.body = { tags: rows.map((r) => r.name) };
  });

  app.use(router.routes());
  // Unknown routes: JSON 404 through the error handler.
  app.use((ctx) => ctx.throw(404, "not found"));

  return app;
}
