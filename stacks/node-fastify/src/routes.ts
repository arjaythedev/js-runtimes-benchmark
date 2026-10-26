import type { FastifyInstance, FastifyRequest } from "fastify";
import bcrypt from "bcrypt";
import type { Pool } from "pg";
import { SQL, articleJson, commentJson, profileJson, userJson } from "./db.ts";
import * as s from "./schemas.ts";

declare module "fastify" {
  interface FastifyRequest {
    viewer: string; // "0" when anonymous
    token: string;
  }
}

class HttpError extends Error {
  statusCode: number;
  constructor(statusCode: number, message: string) {
    super(message);
    this.statusCode = statusCode;
  }
}

const BCRYPT_COST = 10;
const MAX_BIGINT = 9223372036854775807n;

type Body<K extends string, T> = { [k in K]: T };
type Opt = string | null | undefined;
type Page = { limit?: string; offset?: string };

export async function routes(app: FastifyInstance, { pool }: { pool: Pool }) {
  app.decorateRequest("viewer", "0");
  app.decorateRequest("token", "");

  // ---- auth hooks ----

  async function verify(req: FastifyRequest) {
    try {
      const { sub } = await req.jwtVerify<{ sub: unknown }>();
      if (typeof sub !== "string" || !/^[1-9]\d{0,18}$/.test(sub)) throw new Error("bad sub");
      req.viewer = sub;
      req.token = (req.headers.authorization as string).slice(6);
    } catch {
      throw new HttpError(401, "invalid token");
    }
  }
  const requireAuth = async (req: FastifyRequest) => {
    if (req.headers.authorization === undefined) throw new HttpError(401, "authentication required");
    await verify(req);
  };
  const optionalAuth = async (req: FastifyRequest) => {
    if (req.headers.authorization !== undefined) await verify(req);
  };

  // ---- helpers ----

  async function one(text: string, values: unknown[], notFound = "not found") {
    const { rows } = await pool.query(text, values);
    if (rows.length === 0) throw new HttpError(404, notFound);
    return rows[0];
  }
  const fullArticle = async (viewer: string, id: string) => ({ article: articleJson(await one(SQL.articleById, [viewer, id])) });
  async function ownArticleId(slug: string, viewer: string): Promise<string> {
    const a = await one(SQL.articleOwner, [slug], "article not found");
    if (a.author_id !== viewer) throw new HttpError(403, "not the author");
    return a.id;
  }
  async function articleList(page: string, count: string, pageArgs: unknown[], countArgs: unknown[]) {
    const p = await pool.query(page, pageArgs);
    const c = await pool.query(count, countArgs);
    return { articles: p.rows.map(articleJson), articlesCount: Number(c.rows[0].count) };
  }
  function paging(q: Page) {
    const offset = BigInt(q.offset ?? "0");
    if (offset > MAX_BIGINT) throw new HttpError(422, "offset out of range");
    return { limit: Number(q.limit ?? "20"), offset: offset.toString() };
  }
  function checkPassword(p: Opt) {
    if (p != null && Buffer.byteLength(p) > 72) throw new HttpError(422, "password is longer than 72 bytes");
  }
  async function uniqueOr422<T>(work: Promise<T>): Promise<T> {
    try {
      return await work;
    } catch (e) {
      if ((e as { code?: string }).code === "23505") throw new HttpError(422, "username or email is already taken");
      throw e;
    }
  }

  // ---- users ----

  app.post<{ Body: Body<"user", { username: string; email: string; password: string }> }>(
    "/api/users",
    { schema: { body: s.registerBody, response: { 201: s.userResponse } } },
    async (req, reply) => {
      const { username, email, password } = req.body.user;
      checkPassword(password);
      const hash = await bcrypt.hash(password, BCRYPT_COST);
      const { rows } = await uniqueOr422(pool.query(SQL.insertUser, [username, email, hash]));
      reply.code(201);
      return { user: userJson(rows[0], app.jwt.sign({ sub: String(rows[0].id) })) };
    },
  );

  app.post<{ Body: Body<"user", { email: string; password: string }> }>(
    "/api/users/login",
    { schema: { body: s.loginBody, response: { 200: s.userResponse } } },
    async (req) => {
      const { email, password } = req.body.user;
      const { rows } = await pool.query(SQL.userByEmail, [email]);
      if (rows.length === 0 || !(await bcrypt.compare(password, rows[0].password_hash)))
        throw new HttpError(401, "invalid email or password");
      return { user: userJson(rows[0], app.jwt.sign({ sub: String(rows[0].id) })) };
    },
  );

  app.get("/api/user", { onRequest: requireAuth, schema: { response: { 200: s.userResponse } } }, async (req) => {
    const { rows } = await pool.query(SQL.userById, [req.viewer]);
    if (rows.length === 0) throw new HttpError(401, "user not found");
    return { user: userJson(rows[0], req.token) };
  });

  app.put<{ Body: Body<"user", { email?: Opt; username?: Opt; password?: Opt; bio?: Opt; image?: Opt }> }>(
    "/api/user",
    { onRequest: requireAuth, schema: { body: s.updateUserBody, response: { 200: s.userResponse } } },
    async (req) => {
      const u = req.body.user;
      checkPassword(u.password);
      const hash = u.password ? await bcrypt.hash(u.password, BCRYPT_COST) : null;
      const { rows } = await uniqueOr422(
        pool.query(SQL.updateUser, [req.viewer, u.email ?? null, u.username ?? null, hash, u.bio ?? null, u.image ?? null]),
      );
      if (rows.length === 0) throw new HttpError(401, "user not found");
      return { user: userJson(rows[0], req.token) };
    },
  );

  // ---- profiles ----

  type UserParams = { Params: { username: string } };
  app.get<UserParams>(
    "/api/profiles/:username",
    { onRequest: optionalAuth, schema: { response: { 200: s.profileResponse } } },
    async (req) => {
      const p = await one(SQL.profile, [req.viewer, req.params.username], "profile not found");
      return { profile: profileJson(p, p.following) };
    },
  );
  for (const [method, on] of [["POST", true], ["DELETE", false]] as const) {
    app.route<UserParams>({
      method,
      url: "/api/profiles/:username/follow",
      onRequest: requireAuth,
      schema: { response: { 200: s.profileResponse } },
      handler: async (req) => {
        const u = await one(SQL.userByUsername, [req.params.username], "profile not found");
        await pool.query(on ? SQL.follow : SQL.unfollow, [req.viewer, u.id]);
        return { profile: profileJson(u, on) };
      },
    });
  }

  // ---- articles ----

  app.get<{ Querystring: Page & { tag?: string; author?: string; favorited?: string } }>(
    "/api/articles",
    { onRequest: optionalAuth, schema: { querystring: s.listQuery, response: { 200: s.articlesResponse } } },
    async (req) => {
      const q = req.query;
      const { limit, offset } = paging(q);
      const page = [req.viewer, limit, offset];
      // Only the first non-empty filter in the order tag, author, favorited applies.
      if (q.tag) return articleList(SQL.listByTag, SQL.countByTag, [...page, q.tag], [q.tag]);
      if (q.author) return articleList(SQL.listByAuthor, SQL.countByAuthor, [...page, q.author], [q.author]);
      if (q.favorited) return articleList(SQL.listByFavorited, SQL.countByFavorited, [...page, q.favorited], [q.favorited]);
      return articleList(SQL.listAll, SQL.countAll, page, []);
    },
  );

  app.get<{ Querystring: Page }>(
    "/api/articles/feed",
    { onRequest: requireAuth, schema: { querystring: s.pageQuery, response: { 200: s.articlesResponse } } },
    async (req) => {
      const { limit, offset } = paging(req.query);
      return articleList(SQL.listFeed, SQL.countFeed, [req.viewer, limit, offset], [req.viewer]);
    },
  );

  type SlugParams = { Params: { slug: string } };
  app.get<SlugParams>(
    "/api/articles/:slug",
    { onRequest: optionalAuth, schema: { response: { 200: s.articleResponse } } },
    async (req) => ({ article: articleJson(await one(SQL.articleBySlug, [req.viewer, req.params.slug], "article not found")) }),
  );

  app.post<{ Body: Body<"article", { title: string; description: string; body: string; tagList?: string[] | null }> }>(
    "/api/articles",
    { onRequest: requireAuth, schema: { body: s.createArticleBody, response: { 201: s.articleResponse } } },
    async (req, reply) => {
      const a = req.body.article;
      const client = await pool.connect();
      let id: string;
      try {
        await client.query("BEGIN");
        ({ id } = (await client.query(SQL.insertArticle, [req.viewer, a.title, a.description, a.body])).rows[0]);
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
      reply.code(201);
      return fullArticle(req.viewer, id);
    },
  );

  app.put<SlugParams & { Body: Body<"article", { title?: Opt; description?: Opt; body?: Opt }> }>(
    "/api/articles/:slug",
    { onRequest: requireAuth, schema: { body: s.updateArticleBody, response: { 200: s.articleResponse } } },
    async (req) => {
      const a = req.body.article;
      const id = await ownArticleId(req.params.slug, req.viewer);
      await pool.query(SQL.updateArticle, [id, a.title ?? null, a.description ?? null, a.body ?? null]);
      return fullArticle(req.viewer, id);
    },
  );

  app.delete<SlugParams>("/api/articles/:slug", { onRequest: requireAuth }, async (req, reply) => {
    const id = await ownArticleId(req.params.slug, req.viewer);
    await pool.query(SQL.deleteArticle, [id]);
    return reply.code(204).send();
  });

  // ---- favorites ----

  for (const [method, on] of [["POST", true], ["DELETE", false]] as const) {
    app.route<SlugParams>({
      method,
      url: "/api/articles/:slug/favorite",
      onRequest: requireAuth,
      schema: { response: { 200: s.articleResponse } },
      handler: async (req) => {
        const { id } = await one(SQL.articleIdBySlug, [req.params.slug], "article not found");
        await pool.query(on ? SQL.favorite : SQL.unfavorite, [req.viewer, id]);
        return fullArticle(req.viewer, id);
      },
    });
  }

  // ---- comments ----

  app.get<SlugParams>(
    "/api/articles/:slug/comments",
    { onRequest: optionalAuth, schema: { response: { 200: s.commentsResponse } } },
    async (req) => {
      const { id } = await one(SQL.articleIdBySlug, [req.params.slug], "article not found");
      const { rows } = await pool.query(SQL.listComments, [req.viewer, id]);
      return { comments: rows.map(commentJson) };
    },
  );

  app.post<SlugParams & { Body: Body<"comment", { body: string }> }>(
    "/api/articles/:slug/comments",
    { onRequest: requireAuth, schema: { body: s.createCommentBody, response: { 201: s.commentResponse } } },
    async (req, reply) => {
      const { id } = await one(SQL.articleIdBySlug, [req.params.slug], "article not found");
      const { rows } = await pool.query(SQL.insertComment, [id, req.viewer, req.body.comment.body]);
      reply.code(201);
      return { comment: commentJson(rows[0]) };
    },
  );

  app.delete<{ Params: { slug: string; id: string } }>(
    "/api/articles/:slug/comments/:id",
    { onRequest: requireAuth },
    async (req, reply) => {
      const cid = req.params.id;
      if (!/^\d{1,18}$/.test(cid)) throw new HttpError(404, "comment not found");
      const c = await one(SQL.commentAuthor, [cid, req.params.slug], "comment not found");
      if (c.author_id !== req.viewer) throw new HttpError(403, "not the author");
      await pool.query(SQL.deleteComment, [cid]);
      return reply.code(204).send();
    },
  );

  // ---- tags ----

  app.get("/api/tags", { schema: { response: { 200: s.tagsResponse } } }, async () => {
    const { rows } = await pool.query(SQL.tags);
    return { tags: rows.map((r) => r.name) };
  });
}
