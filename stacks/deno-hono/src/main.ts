// Conduit on Hono 4 (npm:hono) for `deno serve --parallel` (`export default app`; Hono apps expose `fetch`).
import { sValidator } from "@hono/standard-validator";
import bcrypt from "bcrypt";
import { Hono, type Context } from "hono";
import { createMiddleware } from "hono/factory";
import { HTTPException } from "hono/http-exception";
import { sign, verify } from "hono/jwt";
import type { z } from "zod";
import { connect, type Filter, isUniqueViolation, queries } from "./db.ts";
import { articleOf, BCRYPT_COST, commentOf, errorBody, pageOf, parseUint, profileOf, TOKEN_TTL, userOf } from "./format.ts";
import * as S from "./schemas.ts";

const workers = Number(Deno.env.get("DENO_JOBS")) || navigator.hardwareConcurrency;
const q = queries(connect(workers));
const secret = Deno.env.get("JWT_SECRET")!;

type Env = { Variables: { viewer: number; token: string } };
const fail = (c: Context, status: 401 | 403 | 404 | 422, msg: string) => c.json(errorBody(msg), status);

// ---------- auth (hono/jwt helpers; the built-in jwt() middleware only accepts the `Bearer` scheme) ----------

const signToken = (id: number) => {
  const now = Math.floor(Date.now() / 1000);
  return sign({ sub: String(id), iat: now, exp: now + TOKEN_TTL }, secret, "HS256");
};

async function viewerOf(header: string | undefined): Promise<{ viewer: number; token: string } | null> {
  if (!header?.startsWith("Token ")) return null;
  const token = header.slice(6);
  try {
    const p = await verify(token, secret, "HS256");
    // hono/jwt checks exp only when present; the spec requires it.
    if (typeof p.exp !== "number" || typeof p.sub !== "string" || !/^[0-9]+$/.test(p.sub)) return null;
    const viewer = Number(p.sub);
    return viewer > 0 ? { viewer, token } : null;
  } catch {
    return null;
  }
}

// required: a missing or invalid token gives 401. optional: no header is anonymous, an invalid one is 401.
const auth = (required: boolean) =>
  createMiddleware<Env>(async (c, next) => {
    const header = c.req.header("Authorization");
    if (header === undefined && !required) {
      c.set("viewer", 0);
      c.set("token", "");
      return next();
    }
    const v = await viewerOf(header);
    if (!v) return fail(c, 401, "unauthorized");
    c.set("viewer", v.viewer);
    c.set("token", v.token);
    await next();
  });
const required = auth(true), optional = auth(false);

// JSON body validation with zod through Standard Schema; any failure is a 422.
const body = <T extends z.ZodType>(schema: T, msg: string) =>
  sValidator("json", schema, (result, c) => {
    if (!result.success) return c.json(errorBody(msg), 422);
  });

const page = (c: Context) => pageOf(c.req.query("limit"), c.req.query("offset"));

// ---------- app ----------

const app = new Hono<Env>();

app.post("/api/users", body(S.registerBody, "username, email and password are required"), async (c) => {
  const { username, email, password } = c.req.valid("json").user;
  const hash = await bcrypt.hash(password, BCRYPT_COST);
  try {
    const [u] = await q.insertUser(username, email, hash);
    return c.json({ user: userOf(u, await signToken(u.id)) }, 201);
  } catch (e) {
    if (isUniqueViolation(e)) return fail(c, 422, "username or email is already taken");
    throw e;
  }
});

app.post("/api/users/login", body(S.loginBody, "email and password are required"), async (c) => {
  const { email, password } = c.req.valid("json").user;
  const [u] = await q.userByEmail(email);
  if (!u || !(await bcrypt.compare(password, u.password_hash))) return fail(c, 401, "invalid email or password");
  return c.json({ user: userOf(u, await signToken(u.id)) });
});

app.get("/api/user", required, async (c) => {
  const [u] = await q.userById(c.var.viewer);
  if (!u) return fail(c, 401, "unauthorized");
  return c.json({ user: userOf(u, c.var.token) });
});

app.put("/api/user", required, body(S.updateUserBody, "invalid user fields"), async (c) => {
  const f = c.req.valid("json").user;
  const hash = f.password != null ? await bcrypt.hash(f.password, BCRYPT_COST) : null;
  try {
    const [u] = await q.updateUser(c.var.viewer, f.email ?? null, f.username ?? null, hash, f.bio ?? null, f.image ?? null);
    if (!u) return fail(c, 401, "unauthorized");
    return c.json({ user: userOf(u, c.var.token) });
  } catch (e) {
    if (isUniqueViolation(e)) return fail(c, 422, "username or email is already taken");
    throw e;
  }
});

app.get("/api/profiles/:username", optional, async (c) => {
  const [u] = await q.profile(c.var.viewer, c.req.param("username"));
  if (!u) return fail(c, 404, "profile not found");
  return c.json({ profile: profileOf(u, u.following) });
});

const follow = (on: boolean) => async (c: Context<Env>) => {
  const [u] = await q.userByUsername(c.req.param("username")!);
  if (!u) return fail(c, 404, "profile not found");
  await (on ? q.follow(c.var.viewer, u.id) : q.unfollow(c.var.viewer, u.id));
  return c.json({ profile: profileOf(u, on) });
};
app.post("/api/profiles/:username/follow", required, follow(true));
app.delete("/api/profiles/:username/follow", required, follow(false));

app.get("/api/articles/feed", required, async (c) => {
  const p = page(c);
  if (!p) return fail(c, 422, "limit must be 1-100 and offset >= 0");
  const rows = await q.feedPage(c.var.viewer, p.limit, p.offset);
  const [{ count }] = await q.feedCount(c.var.viewer);
  return c.json({ articles: rows.map(articleOf), articlesCount: count });
});

app.get("/api/articles", optional, async (c) => {
  const p = page(c);
  if (!p) return fail(c, 422, "limit must be 1-100 and offset >= 0");
  // Only the first non-empty filter in the order tag, author, favorited applies.
  let filter: Filter = null;
  for (const kind of ["tag", "author", "favorited"] as const) {
    const value = c.req.query(kind);
    if (value) { filter = { kind, value }; break; }
  }
  const rows = await q.listPage(c.var.viewer, p.limit, p.offset, filter);
  const [{ count }] = await q.listCount(filter);
  return c.json({ articles: rows.map(articleOf), articlesCount: count });
});

const fullArticle = async (c: Context<Env>, id: number, status: 200 | 201) => {
  const [r] = await q.articleById(c.var.viewer, id);
  return r ? c.json({ article: articleOf(r) }, status) : fail(c, 404, "article not found");
};

app.post("/api/articles", required,
  body(S.createArticleBody, "title, description and body are required; tagList must be an array of non-empty strings"),
  async (c) => {
    const { title, description, body, tagList } = c.req.valid("json").article;
    const id = await q.createArticle(c.var.viewer, title, description, body, tagList ?? []);
    return fullArticle(c, id, 201);
  });

app.get("/api/articles/:slug", optional, async (c) => {
  const [r] = await q.articleBySlug(c.var.viewer, c.req.param("slug"));
  return r ? c.json({ article: articleOf(r) }) : fail(c, 404, "article not found");
});

app.put("/api/articles/:slug", required, body(S.updateArticleBody, "title, description and body must be non-empty strings"),
  async (c) => {
    const [own] = await q.articleOwner(c.req.param("slug"));
    if (!own) return fail(c, 404, "article not found");
    if (own.author_id !== c.var.viewer) return fail(c, 403, "not the author");
    const f = c.req.valid("json").article;
    await q.updateArticle(own.id, f.title ?? null, f.description ?? null, f.body ?? null);
    return fullArticle(c, own.id, 200);
  });

app.delete("/api/articles/:slug", required, async (c) => {
  const [own] = await q.articleOwner(c.req.param("slug"));
  if (!own) return fail(c, 404, "article not found");
  if (own.author_id !== c.var.viewer) return fail(c, 403, "not the author");
  await q.deleteArticle(own.id);
  return c.body(null, 204);
});

const favorite = (on: boolean) => async (c: Context<Env>) => {
  const [a] = await q.articleIdBySlug(c.req.param("slug")!);
  if (!a) return fail(c, 404, "article not found");
  await (on ? q.favorite(c.var.viewer, a.id) : q.unfavorite(c.var.viewer, a.id));
  return fullArticle(c, a.id, 200);
};
app.post("/api/articles/:slug/favorite", required, favorite(true));
app.delete("/api/articles/:slug/favorite", required, favorite(false));

app.get("/api/articles/:slug/comments", optional, async (c) => {
  const [a] = await q.articleIdBySlug(c.req.param("slug"));
  if (!a) return fail(c, 404, "article not found");
  const rows = await q.comments(c.var.viewer, a.id);
  return c.json({ comments: rows.map((r) => commentOf(r, r.following)) });
});

app.post("/api/articles/:slug/comments", required, body(S.commentBody, "body is required"), async (c) => {
  const [a] = await q.articleIdBySlug(c.req.param("slug"));
  if (!a) return fail(c, 404, "article not found");
  const [row] = await q.insertComment(a.id, c.var.viewer, c.req.valid("json").comment.body);
  return c.json({ comment: commentOf(row, false) }, 201);
});

app.delete("/api/articles/:slug/comments/:id", required, async (c) => {
  const id = c.req.param("id");
  if (parseUint(id) == null) return fail(c, 404, "comment not found");
  const [row] = await q.commentAuthor(id, c.req.param("slug"));
  if (!row) return fail(c, 404, "comment not found");
  if (row.author_id !== c.var.viewer) return fail(c, 403, "not the author");
  await q.deleteComment(id);
  return c.body(null, 204);
});

app.get("/api/tags", async (c) => c.json({ tags: (await q.tags()).map((r) => r.name) }));

app.notFound((c) => fail(c, 404, "not found"));

app.onError((err, c) => {
  // The json validator throws a 400 HTTPException for a malformed body; the spec wants 422.
  if (err instanceof HTTPException && err.status === 400) return fail(c, 422, err.message);
  if (err instanceof HTTPException) return c.json(errorBody(err.message), err.status);
  console.error(err);
  return c.json(errorBody("internal error"), 500);
});

export default app;
