// Conduit on Express 5 (npm:express) running on Deno's Node compatibility layer.
// Multicore the Node way: node:cluster, one worker per os.availableParallelism(), no restart of dead workers.
import cluster from "node:cluster";
import os from "node:os";
import process from "node:process";
// @ts-types="@types/express"
import express, { type ErrorRequestHandler, type NextFunction, type Request, type Response } from "express";
import bcrypt from "bcrypt";
import type { z } from "zod";
import { authOf, signToken } from "./auth.ts";
import { connect, type Filter, isUniqueViolation, queries } from "./db.ts";
import { articleOf, BCRYPT_COST, commentOf, errorBody, pageOf, parseUint, profileOf, userOf } from "./format.ts";
import * as S from "./schemas.ts";

const workers = os.availableParallelism();

if (cluster.isPrimary) {
  for (let i = 0; i < workers; i++) cluster.fork();
} else {
  serve();
}

function serve() {
  const q = queries(connect(workers));

  type Locals = { viewer: number; token: string };
  const fail = (res: Response, status: number, msg: string) => res.status(status).json(errorBody(msg));

  // required: a missing or invalid token gives 401. optional: no header is anonymous, an invalid one is 401.
  const auth = (required: boolean) => async (req: Request, res: Response<unknown, Locals>, next: NextFunction) => {
    const { present, viewer, token } = await authOf(req.get("authorization") ?? null);
    if (viewer === 0 && (present || required)) return fail(res, 401, "unauthorized");
    res.locals.viewer = viewer;
    res.locals.token = token;
    next();
  };
  const required = auth(true), optional = auth(false);

  // zod in the handler: the parsed body, or null (wrong shape) -> 422. Malformed JSON is caught by the error handler.
  const bodyOf = <T extends z.ZodType>(req: Request, schema: T): z.infer<T> | null => {
    const r = schema.safeParse(req.body);
    return r.success ? r.data : null;
  };

  const page = (req: Request) => {
    const one = (v: unknown) => (Array.isArray(v) ? v[0] : v) as string | undefined;
    return pageOf(one(req.query.limit), one(req.query.offset));
  };

  const app = express();
  app.disable("x-powered-by");
  app.set("etag", false);
  app.use(express.json());

  app.post("/api/users", async (req, res: Response<unknown, Locals>) => {
    const b = bodyOf(req, S.registerBody);
    if (!b) return fail(res, 422, "username, email and password are required");
    const { username, email, password } = b.user;
    const hash = await bcrypt.hash(password, BCRYPT_COST);
    try {
      const [u] = await q.insertUser(username, email, hash);
      res.status(201).json({ user: userOf(u, await signToken(u.id)) });
    } catch (e) {
      if (isUniqueViolation(e)) return fail(res, 422, "username or email is already taken");
      throw e;
    }
  });

  app.post("/api/users/login", async (req, res) => {
    const b = bodyOf(req, S.loginBody);
    if (!b) return fail(res, 422, "email and password are required");
    const [u] = await q.userByEmail(b.user.email);
    if (!u || !(await bcrypt.compare(b.user.password, u.password_hash))) return fail(res, 401, "invalid email or password");
    res.json({ user: userOf(u, await signToken(u.id)) });
  });

  app.get("/api/user", required, async (_req, res: Response<unknown, Locals>) => {
    const [u] = await q.userById(res.locals.viewer);
    if (!u) return fail(res, 401, "unauthorized");
    res.json({ user: userOf(u, res.locals.token) });
  });

  app.put("/api/user", required, async (req, res: Response<unknown, Locals>) => {
    const b = bodyOf(req, S.updateUserBody);
    if (!b) return fail(res, 422, "invalid user fields");
    const f = b.user;
    const hash = f.password != null ? await bcrypt.hash(f.password, BCRYPT_COST) : null;
    try {
      const [u] = await q.updateUser(res.locals.viewer, f.email ?? null, f.username ?? null, hash, f.bio ?? null, f.image ?? null);
      if (!u) return fail(res, 401, "unauthorized");
      res.json({ user: userOf(u, res.locals.token) });
    } catch (e) {
      if (isUniqueViolation(e)) return fail(res, 422, "username or email is already taken");
      throw e;
    }
  });

  app.get("/api/profiles/:username", optional, async (req, res: Response<unknown, Locals>) => {
    const [u] = await q.profile(res.locals.viewer, req.params.username as string);
    if (!u) return fail(res, 404, "profile not found");
    res.json({ profile: profileOf(u, u.following) });
  });

  const follow = (on: boolean) => async (req: Request, res: Response<unknown, Locals>) => {
    const [u] = await q.userByUsername(req.params.username as string);
    if (!u) return fail(res, 404, "profile not found");
    await (on ? q.follow(res.locals.viewer, u.id) : q.unfollow(res.locals.viewer, u.id));
    res.json({ profile: profileOf(u, on) });
  };
  app.post("/api/profiles/:username/follow", required, follow(true));
  app.delete("/api/profiles/:username/follow", required, follow(false));

  app.get("/api/articles/feed", required, async (req, res: Response<unknown, Locals>) => {
    const p = page(req);
    if (!p) return fail(res, 422, "limit must be 1-100 and offset >= 0");
    const rows = await q.feedPage(res.locals.viewer, p.limit, p.offset);
    const [{ count }] = await q.feedCount(res.locals.viewer);
    res.json({ articles: rows.map(articleOf), articlesCount: count });
  });

  app.get("/api/articles", optional, async (req, res: Response<unknown, Locals>) => {
    const p = page(req);
    if (!p) return fail(res, 422, "limit must be 1-100 and offset >= 0");
    // Only the first non-empty filter in the order tag, author, favorited applies.
    let filter: Filter = null;
    for (const kind of ["tag", "author", "favorited"] as const) {
      const v = req.query[kind];
      const value = Array.isArray(v) ? v[0] : v;
      if (typeof value === "string" && value) { filter = { kind, value }; break; }
    }
    const rows = await q.listPage(res.locals.viewer, p.limit, p.offset, filter);
    const [{ count }] = await q.listCount(filter);
    res.json({ articles: rows.map(articleOf), articlesCount: count });
  });

  const fullArticle = async (res: Response<unknown, Locals>, id: number, status: number) => {
    const [r] = await q.articleById(res.locals.viewer, id);
    if (!r) return fail(res, 404, "article not found");
    res.status(status).json({ article: articleOf(r) });
  };

  app.post("/api/articles", required, async (req, res: Response<unknown, Locals>) => {
    const b = bodyOf(req, S.createArticleBody);
    if (!b) return fail(res, 422, "title, description and body are required; tagList must be an array of non-empty strings");
    const { title, description, body, tagList } = b.article;
    const id = await q.createArticle(res.locals.viewer, title, description, body, tagList ?? []);
    await fullArticle(res, id, 201);
  });

  app.get("/api/articles/:slug", optional, async (req, res: Response<unknown, Locals>) => {
    const [r] = await q.articleBySlug(res.locals.viewer, req.params.slug as string);
    if (!r) return fail(res, 404, "article not found");
    res.json({ article: articleOf(r) });
  });

  app.put("/api/articles/:slug", required, async (req, res: Response<unknown, Locals>) => {
    const b = bodyOf(req, S.updateArticleBody);
    if (!b) return fail(res, 422, "title, description and body must be non-empty strings");
    const [own] = await q.articleOwner(req.params.slug as string);
    if (!own) return fail(res, 404, "article not found");
    if (own.author_id !== res.locals.viewer) return fail(res, 403, "not the author");
    const f = b.article;
    await q.updateArticle(own.id, f.title ?? null, f.description ?? null, f.body ?? null);
    await fullArticle(res, own.id, 200);
  });

  app.delete("/api/articles/:slug", required, async (req, res: Response<unknown, Locals>) => {
    const [own] = await q.articleOwner(req.params.slug as string);
    if (!own) return fail(res, 404, "article not found");
    if (own.author_id !== res.locals.viewer) return fail(res, 403, "not the author");
    await q.deleteArticle(own.id);
    res.status(204).end();
  });

  const favorite = (on: boolean) => async (req: Request, res: Response<unknown, Locals>) => {
    const [a] = await q.articleIdBySlug(req.params.slug as string);
    if (!a) return fail(res, 404, "article not found");
    await (on ? q.favorite(res.locals.viewer, a.id) : q.unfavorite(res.locals.viewer, a.id));
    await fullArticle(res, a.id, 200);
  };
  app.post("/api/articles/:slug/favorite", required, favorite(true));
  app.delete("/api/articles/:slug/favorite", required, favorite(false));

  app.get("/api/articles/:slug/comments", optional, async (req, res: Response<unknown, Locals>) => {
    const [a] = await q.articleIdBySlug(req.params.slug as string);
    if (!a) return fail(res, 404, "article not found");
    const rows = await q.comments(res.locals.viewer, a.id);
    res.json({ comments: rows.map((r) => commentOf(r, r.following)) });
  });

  app.post("/api/articles/:slug/comments", required, async (req, res: Response<unknown, Locals>) => {
    const b = bodyOf(req, S.commentBody);
    if (!b) return fail(res, 422, "body is required");
    const [a] = await q.articleIdBySlug(req.params.slug as string);
    if (!a) return fail(res, 404, "article not found");
    const [row] = await q.insertComment(a.id, res.locals.viewer, b.comment.body);
    res.status(201).json({ comment: commentOf(row, false) });
  });

  app.delete("/api/articles/:slug/comments/:id", required, async (req, res: Response<unknown, Locals>) => {
    const id = req.params.id as string, slug = req.params.slug as string;
    if (parseUint(id) == null) return fail(res, 404, "comment not found");
    const [row] = await q.commentAuthor(id, slug);
    if (!row) return fail(res, 404, "comment not found");
    if (row.author_id !== res.locals.viewer) return fail(res, 403, "not the author");
    await q.deleteComment(id);
    res.status(204).end();
  });

  app.get("/api/tags", async (_req, res) => {
    res.json({ tags: (await q.tags()).map((r) => r.name) });
  });

  app.use((_req, res) => fail(res, 404, "not found"));

  // Express 5 forwards rejected promises here. body-parser errors (malformed JSON) carry a 4xx status: the spec
  // wants 422 for every bad body.
  const onError: ErrorRequestHandler = (err, _req, res, _next) => {
    if (err?.type === "entity.parse.failed" || (err?.status >= 400 && err?.status < 500)) {
      return fail(res, 422, "malformed request body");
    }
    console.error(err);
    fail(res, 500, "internal error");
  };
  app.use(onError);

  const server = app.listen(Number(process.env.PORT), process.env.HOST!);
  // Node's 5 s keep-alive default is too short for users who think up to 70 s between pages.
  server.keepAliveTimeout = 75_000;
  server.headersTimeout = 76_000;
}
