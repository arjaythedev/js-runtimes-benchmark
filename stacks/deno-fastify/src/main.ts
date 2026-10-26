// Conduit on Fastify 5 (npm:fastify) running on Deno's Node compatibility layer.
// Multicore the Node way: node:cluster, one worker per os.availableParallelism(), no restart of dead workers.
import cluster from "node:cluster";
import os from "node:os";
import process from "node:process";
import Fastify, { type FastifyReply, type FastifyRequest } from "fastify";
import fastifyJwt from "@fastify/jwt";
import bcrypt from "bcrypt";
import { connect, type Filter, isUniqueViolation, queries } from "./db.ts";
import { articleOf, BCRYPT_COST, bcryptOk, commentOf, errorBody, pageOf, parseUint, profileOf, userOf } from "./format.ts";
import * as s from "./schemas.ts";

declare module "@fastify/jwt" {
  interface FastifyJWT {
    payload: { sub: string };
    user: { sub: unknown; iat: number; exp: number };
  }
}
declare module "fastify" {
  interface FastifyRequest {
    viewer: number; // 0 when anonymous
    token: string;
  }
}

class HttpError extends Error {
  constructor(public statusCode: number, message: string) {
    super(message);
  }
}

type Body<K extends string, T> = { [k in K]: T };
type Opt = string | null | undefined;
type Page = { limit?: string; offset?: string };

const workers = os.availableParallelism();

if (cluster.isPrimary) {
  for (let i = 0; i < workers; i++) cluster.fork();
  // No restart-on-crash: a worker that dies stays dead.
  cluster.on("exit", (worker, code, signal) => console.error(`worker ${worker.process.pid} exited (${signal ?? code})`));
} else {
  await buildApp().listen({ host: process.env.HOST!, port: Number(process.env.PORT) });
}

function buildApp() {
  const q = queries(connect(workers));

  const app = Fastify({
    logger: false,
    // Users idle up to ~70 s between pages on one keep-alive connection (Fastify's default is 72 s).
    keepAliveTimeout: 75_000,
    http: { headersTimeout: 76_000 },
    ajv: {
      // Fastify's default coerceTypes: 'array' would turn {"username": 123} into "123"; the API must reject it.
      customOptions: { coerceTypes: false },
    },
  });

  app.register(fastifyJwt, {
    secret: process.env.JWT_SECRET!,
    sign: { algorithm: "HS256", expiresIn: "30d" },
    verify: {
      algorithms: ["HS256"],
      requiredClaims: ["exp"],
      // RealWorld uses "Authorization: Token <jwt>", not Bearer.
      extractToken: (req: FastifyRequest) => {
        const h = req.headers.authorization;
        return h?.startsWith("Token ") ? h.slice(6) : undefined;
      },
    },
  });

  app.decorateRequest("viewer", 0);
  app.decorateRequest("token", "");

  // ---- auth hooks ----
  async function verify(req: FastifyRequest) {
    try {
      const { sub } = await req.jwtVerify<{ sub: unknown }>();
      if (typeof sub !== "string" || !/^[0-9]+$/.test(sub) || Number(sub) <= 0) throw new Error("bad sub");
      req.viewer = Number(sub);
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
  const paging = (p: Page) => {
    const page = pageOf(p.limit, p.offset);
    if (!page) throw new HttpError(422, "limit must be 1-100 and offset >= 0");
    return page;
  };
  const checkPassword = (p: Opt) => {
    if (p != null && !bcryptOk(p)) throw new HttpError(422, "password is longer than 72 bytes");
  };
  async function uniqueOr422<T>(work: Promise<T>): Promise<T> {
    try {
      return await work;
    } catch (e) {
      if (isUniqueViolation(e)) throw new HttpError(422, "username or email is already taken");
      throw e;
    }
  }
  async function fullArticle(viewer: number, id: number) {
    const [r] = await q.articleById(viewer, id);
    if (!r) throw new HttpError(404, "article not found");
    return { article: articleOf(r) };
  }
  async function ownArticleId(slug: string, viewer: number) {
    const [a] = await q.articleOwner(slug);
    if (!a) throw new HttpError(404, "article not found");
    if (a.author_id !== viewer) throw new HttpError(403, "not the author");
    return a.id as number;
  }
  async function articleIdBySlug(slug: string) {
    const [a] = await q.articleIdBySlug(slug);
    if (!a) throw new HttpError(404, "article not found");
    return a.id as number;
  }

  // ---- users ----
  app.post<{ Body: Body<"user", { username: string; email: string; password: string }> }>(
    "/api/users",
    { schema: { body: s.registerBody, response: { 201: s.userResponse } } },
    async (req, reply) => {
      const { username, email, password } = req.body.user;
      checkPassword(password);
      const hash = await bcrypt.hash(password, BCRYPT_COST);
      const [u] = await uniqueOr422(q.insertUser(username, email, hash));
      reply.code(201);
      return { user: userOf(u, app.jwt.sign({ sub: String(u.id) })) };
    },
  );

  app.post<{ Body: Body<"user", { email: string; password: string }> }>(
    "/api/users/login",
    { schema: { body: s.loginBody, response: { 200: s.userResponse } } },
    async (req) => {
      const { email, password } = req.body.user;
      const [u] = await q.userByEmail(email);
      if (!u || !(await bcrypt.compare(password, u.password_hash))) throw new HttpError(401, "invalid email or password");
      return { user: userOf(u, app.jwt.sign({ sub: String(u.id) })) };
    },
  );

  app.get("/api/user", { onRequest: requireAuth, schema: { response: { 200: s.userResponse } } }, async (req) => {
    const [u] = await q.userById(req.viewer);
    if (!u) throw new HttpError(401, "user not found");
    return { user: userOf(u, req.token) };
  });

  app.put<{ Body: Body<"user", { email?: Opt; username?: Opt; password?: Opt; bio?: Opt; image?: Opt }> }>(
    "/api/user",
    { onRequest: requireAuth, schema: { body: s.updateUserBody, response: { 200: s.userResponse } } },
    async (req) => {
      const f = req.body.user;
      checkPassword(f.password);
      const hash = f.password != null ? await bcrypt.hash(f.password, BCRYPT_COST) : null;
      const [u] = await uniqueOr422(
        q.updateUser(req.viewer, f.email ?? null, f.username ?? null, hash, f.bio ?? null, f.image ?? null),
      );
      if (!u) throw new HttpError(401, "user not found");
      return { user: userOf(u, req.token) };
    },
  );

  // ---- profiles ----
  type UserParams = { Params: { username: string } };
  app.get<UserParams>(
    "/api/profiles/:username",
    { onRequest: optionalAuth, schema: { response: { 200: s.profileResponse } } },
    async (req) => {
      const [p] = await q.profile(req.viewer, req.params.username);
      if (!p) throw new HttpError(404, "profile not found");
      return { profile: profileOf(p, p.following) };
    },
  );
  for (const [method, on] of [["POST", true], ["DELETE", false]] as const) {
    app.route<UserParams>({
      method,
      url: "/api/profiles/:username/follow",
      onRequest: requireAuth,
      schema: { response: { 200: s.profileResponse } },
      handler: async (req) => {
        const [u] = await q.userByUsername(req.params.username);
        if (!u) throw new HttpError(404, "profile not found");
        await (on ? q.follow(req.viewer, u.id) : q.unfollow(req.viewer, u.id));
        return { profile: profileOf(u, on) };
      },
    });
  }

  // ---- articles ----
  app.get<{ Querystring: Page & { tag?: string; author?: string; favorited?: string } }>(
    "/api/articles",
    { onRequest: optionalAuth, schema: { querystring: s.listQuery, response: { 200: s.articlesResponse } } },
    async (req) => {
      const { limit, offset } = paging(req.query);
      // Only the first non-empty filter in the order tag, author, favorited applies.
      let filter: Filter = null;
      for (const kind of ["tag", "author", "favorited"] as const) {
        const value = req.query[kind];
        if (value) { filter = { kind, value }; break; }
      }
      const rows = await q.listPage(req.viewer, limit, offset, filter);
      const [{ count }] = await q.listCount(filter);
      return { articles: rows.map(articleOf), articlesCount: count };
    },
  );

  app.get<{ Querystring: Page }>(
    "/api/articles/feed",
    { onRequest: requireAuth, schema: { querystring: s.pageQuery, response: { 200: s.articlesResponse } } },
    async (req) => {
      const { limit, offset } = paging(req.query);
      const rows = await q.feedPage(req.viewer, limit, offset);
      const [{ count }] = await q.feedCount(req.viewer);
      return { articles: rows.map(articleOf), articlesCount: count };
    },
  );

  type SlugParams = { Params: { slug: string } };
  app.get<SlugParams>(
    "/api/articles/:slug",
    { onRequest: optionalAuth, schema: { response: { 200: s.articleResponse } } },
    async (req) => {
      const [r] = await q.articleBySlug(req.viewer, req.params.slug);
      if (!r) throw new HttpError(404, "article not found");
      return { article: articleOf(r) };
    },
  );

  app.post<{ Body: Body<"article", { title: string; description: string; body: string; tagList?: string[] | null }> }>(
    "/api/articles",
    { onRequest: requireAuth, schema: { body: s.createArticleBody, response: { 201: s.articleResponse } } },
    async (req, reply) => {
      const a = req.body.article;
      const id = await q.createArticle(req.viewer, a.title, a.description, a.body, a.tagList ?? []);
      const res = await fullArticle(req.viewer, id);
      reply.code(201);
      return res;
    },
  );

  app.put<SlugParams & { Body: Body<"article", { title?: Opt; description?: Opt; body?: Opt }> }>(
    "/api/articles/:slug",
    { onRequest: requireAuth, schema: { body: s.updateArticleBody, response: { 200: s.articleResponse } } },
    async (req) => {
      const a = req.body.article;
      const id = await ownArticleId(req.params.slug, req.viewer);
      await q.updateArticle(id, a.title ?? null, a.description ?? null, a.body ?? null);
      return fullArticle(req.viewer, id);
    },
  );

  app.delete<SlugParams>("/api/articles/:slug", { onRequest: requireAuth }, async (req, reply) => {
    const id = await ownArticleId(req.params.slug, req.viewer);
    await q.deleteArticle(id);
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
        const id = await articleIdBySlug(req.params.slug);
        await (on ? q.favorite(req.viewer, id) : q.unfavorite(req.viewer, id));
        return fullArticle(req.viewer, id);
      },
    });
  }

  // ---- comments ----
  app.get<SlugParams>(
    "/api/articles/:slug/comments",
    { onRequest: optionalAuth, schema: { response: { 200: s.commentsResponse } } },
    async (req) => {
      const id = await articleIdBySlug(req.params.slug);
      const rows = await q.comments(req.viewer, id);
      return { comments: rows.map((r) => commentOf(r, r.following)) };
    },
  );

  app.post<SlugParams & { Body: Body<"comment", { body: string }> }>(
    "/api/articles/:slug/comments",
    { onRequest: requireAuth, schema: { body: s.createCommentBody, response: { 201: s.commentResponse } } },
    async (req, reply) => {
      const id = await articleIdBySlug(req.params.slug);
      const [row] = await q.insertComment(id, req.viewer, req.body.comment.body);
      reply.code(201);
      return { comment: commentOf(row, false) };
    },
  );

  app.delete<{ Params: { slug: string; id: string } }>(
    "/api/articles/:slug/comments/:id",
    { onRequest: requireAuth },
    async (req, reply) => {
      const cid = req.params.id;
      if (parseUint(cid) == null) throw new HttpError(404, "comment not found");
      const [c] = await q.commentAuthor(cid, req.params.slug);
      if (!c) throw new HttpError(404, "comment not found");
      if (c.author_id !== req.viewer) throw new HttpError(403, "not the author");
      await q.deleteComment(cid);
      return reply.code(204).send();
    },
  );

  // ---- tags ----
  app.get("/api/tags", { schema: { response: { 200: s.tagsResponse } } }, async () => {
    return { tags: (await q.tags()).map((r) => r.name) };
  });

  app.setNotFoundHandler((_req, reply) => {
    reply.code(404).send(errorBody("not found"));
  });

  const VALIDATION_CODES = new Set(["FST_ERR_CTP_INVALID_JSON_BODY", "FST_ERR_CTP_EMPTY_JSON_BODY"]);
  app.setErrorHandler((err: Error & { statusCode?: number; code?: string; validation?: unknown }, _req, reply: FastifyReply) => {
    let status = err.statusCode ?? 500;
    let message = err.message;
    // Schema validation failures and unparseable JSON bodies are 422 in this API (Fastify's default is 400).
    if (err.validation || (err.code && VALIDATION_CODES.has(err.code))) status = 422;
    if (status >= 500) {
      console.error(err);
      message = "internal error";
    }
    reply.code(status).send(errorBody(message));
  });

  return app;
}
