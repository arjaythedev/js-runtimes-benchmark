// Conduit on plain Deno: `export default { fetch }` for `deno serve --parallel`, routing with URLPattern.
import bcrypt from "bcrypt";
import type { z } from "zod";
import { authOf, signToken } from "./auth.ts";
import { connect, type Filter, isUniqueViolation, queries } from "./db.ts";
import { articleOf, BCRYPT_COST, commentOf, errorBody, pageOf, parseUint, profileOf, userOf } from "./format.ts";
import * as S from "./schemas.ts";

const workers = Number(Deno.env.get("DENO_JOBS")) || navigator.hardwareConcurrency;
const q = queries(connect(workers));

type Auth = { viewer: number; token: string };
type Params = Record<string, string | undefined>;
type Handler = (req: Request, p: Params, a: Auth, url: URL) => Promise<Response>;

const json = (body: unknown, status = 200) => Response.json(body, { status });
const fail = (status: number, msg: string) => json(errorBody(msg), status);
const noContent = () => new Response(null, { status: 204 });

// Body -> validated object, or null (malformed JSON, empty body, wrong shape) which the handler turns into a 422.
async function bodyOf<T extends z.ZodType>(req: Request, schema: T): Promise<z.infer<T> | null> {
  let raw: unknown;
  try {
    raw = await req.json();
  } catch {
    return null;
  }
  const r = schema.safeParse(raw);
  return r.success ? r.data : null;
}

// ---------- handlers ----------

const register: Handler = async (req) => {
  const b = await bodyOf(req, S.registerBody);
  if (!b) return fail(422, "username, email and password are required");
  const { username, email, password } = b.user;
  const hash = await bcrypt.hash(password, BCRYPT_COST);
  try {
    const [u] = await q.insertUser(username, email, hash);
    return json({ user: userOf(u, await signToken(u.id)) }, 201);
  } catch (e) {
    if (isUniqueViolation(e)) return fail(422, "username or email is already taken");
    throw e;
  }
};

const login: Handler = async (req) => {
  const b = await bodyOf(req, S.loginBody);
  if (!b) return fail(422, "email and password are required");
  const [u] = await q.userByEmail(b.user.email);
  if (!u || !(await bcrypt.compare(b.user.password, u.password_hash))) return fail(401, "invalid email or password");
  return json({ user: userOf(u, await signToken(u.id)) });
};

const currentUser: Handler = async (_req, _p, a) => {
  const [u] = await q.userById(a.viewer);
  if (!u) return fail(401, "unauthorized");
  return json({ user: userOf(u, a.token) });
};

const updateUser: Handler = async (req, _p, a) => {
  const b = await bodyOf(req, S.updateUserBody);
  if (!b) return fail(422, "invalid user fields");
  const f = b.user;
  const hash = f.password != null ? await bcrypt.hash(f.password, BCRYPT_COST) : null;
  try {
    const [u] = await q.updateUser(a.viewer, f.email ?? null, f.username ?? null, hash, f.bio ?? null, f.image ?? null);
    if (!u) return fail(401, "unauthorized");
    return json({ user: userOf(u, a.token) });
  } catch (e) {
    if (isUniqueViolation(e)) return fail(422, "username or email is already taken");
    throw e;
  }
};

const getProfile: Handler = async (_req, p, a) => {
  const [u] = await q.profile(a.viewer, p.username!);
  if (!u) return fail(404, "profile not found");
  return json({ profile: profileOf(u, u.following) });
};

const follow = (on: boolean): Handler => async (_req, p, a) => {
  const [u] = await q.userByUsername(p.username!);
  if (!u) return fail(404, "profile not found");
  await (on ? q.follow(a.viewer, u.id) : q.unfollow(a.viewer, u.id));
  return json({ profile: profileOf(u, on) });
};

const listArticles: Handler = async (_req, _p, a, url) => {
  const sp = url.searchParams;
  const page = pageOf(sp.get("limit"), sp.get("offset"));
  if (!page) return fail(422, "limit must be 1-100 and offset >= 0");
  // Only the first non-empty filter in the order tag, author, favorited applies.
  let filter: Filter = null;
  for (const kind of ["tag", "author", "favorited"] as const) {
    const value = sp.get(kind);
    if (value) { filter = { kind, value }; break; }
  }
  const rows = await q.listPage(a.viewer, page.limit, page.offset, filter);
  const [{ count }] = await q.listCount(filter);
  return json({ articles: rows.map(articleOf), articlesCount: count });
};

const feed: Handler = async (_req, _p, a, url) => {
  const page = pageOf(url.searchParams.get("limit"), url.searchParams.get("offset"));
  if (!page) return fail(422, "limit must be 1-100 and offset >= 0");
  const rows = await q.feedPage(a.viewer, page.limit, page.offset);
  const [{ count }] = await q.feedCount(a.viewer);
  return json({ articles: rows.map(articleOf), articlesCount: count });
};

const fullArticle = async (viewer: number, id: number, status: number) => {
  const [r] = await q.articleById(viewer, id);
  return r ? json({ article: articleOf(r) }, status) : fail(404, "article not found");
};

const getArticle: Handler = async (_req, p, a) => {
  const [r] = await q.articleBySlug(a.viewer, p.slug!);
  return r ? json({ article: articleOf(r) }) : fail(404, "article not found");
};

const createArticle: Handler = async (req, _p, a) => {
  const b = await bodyOf(req, S.createArticleBody);
  if (!b) return fail(422, "title, description and body are required; tagList must be an array of non-empty strings");
  const { title, description, body, tagList } = b.article;
  const id = await q.createArticle(a.viewer, title, description, body, tagList ?? []);
  return fullArticle(a.viewer, id, 201);
};

const updateArticle: Handler = async (req, p, a) => {
  const b = await bodyOf(req, S.updateArticleBody);
  if (!b) return fail(422, "title, description and body must be non-empty strings");
  const [own] = await q.articleOwner(p.slug!);
  if (!own) return fail(404, "article not found");
  if (own.author_id !== a.viewer) return fail(403, "not the author");
  const f = b.article;
  await q.updateArticle(own.id, f.title ?? null, f.description ?? null, f.body ?? null);
  return fullArticle(a.viewer, own.id, 200);
};

const deleteArticle: Handler = async (_req, p, a) => {
  const [own] = await q.articleOwner(p.slug!);
  if (!own) return fail(404, "article not found");
  if (own.author_id !== a.viewer) return fail(403, "not the author");
  await q.deleteArticle(own.id);
  return noContent();
};

const favorite = (on: boolean): Handler => async (_req, p, a) => {
  const [art] = await q.articleIdBySlug(p.slug!);
  if (!art) return fail(404, "article not found");
  await (on ? q.favorite(a.viewer, art.id) : q.unfavorite(a.viewer, art.id));
  return fullArticle(a.viewer, art.id, 200);
};

const listComments: Handler = async (_req, p, a) => {
  const [art] = await q.articleIdBySlug(p.slug!);
  if (!art) return fail(404, "article not found");
  const rows = await q.comments(a.viewer, art.id);
  return json({ comments: rows.map((r) => commentOf(r, r.following)) });
};

const createComment: Handler = async (req, p, a) => {
  const b = await bodyOf(req, S.commentBody);
  if (!b) return fail(422, "body is required");
  const [art] = await q.articleIdBySlug(p.slug!);
  if (!art) return fail(404, "article not found");
  const [c] = await q.insertComment(art.id, a.viewer, b.comment.body);
  return json({ comment: commentOf(c, false) }, 201);
};

const deleteComment: Handler = async (_req, p, a) => {
  if (parseUint(p.id) == null) return fail(404, "comment not found");
  const [c] = await q.commentAuthor(p.id!, p.slug!);
  if (!c) return fail(404, "comment not found");
  if (c.author_id !== a.viewer) return fail(403, "not the author");
  await q.deleteComment(p.id!);
  return noContent();
};

const tags: Handler = async () => json({ tags: (await q.tags()).map((r) => r.name) });

// ---------- routing ----------

type AuthMode = "none" | "optional" | "required";
const routes: [string, string, AuthMode, Handler][] = [
  ["POST", "/api/users", "none", register],
  ["POST", "/api/users/login", "none", login],
  ["GET", "/api/user", "required", currentUser],
  ["PUT", "/api/user", "required", updateUser],
  ["GET", "/api/profiles/:username", "optional", getProfile],
  ["POST", "/api/profiles/:username/follow", "required", follow(true)],
  ["DELETE", "/api/profiles/:username/follow", "required", follow(false)],
  ["GET", "/api/articles", "optional", listArticles],
  ["GET", "/api/articles/feed", "required", feed],
  ["POST", "/api/articles", "required", createArticle],
  ["GET", "/api/articles/:slug", "optional", getArticle],
  ["PUT", "/api/articles/:slug", "required", updateArticle],
  ["DELETE", "/api/articles/:slug", "required", deleteArticle],
  ["POST", "/api/articles/:slug/favorite", "required", favorite(true)],
  ["DELETE", "/api/articles/:slug/favorite", "required", favorite(false)],
  ["GET", "/api/articles/:slug/comments", "optional", listComments],
  ["POST", "/api/articles/:slug/comments", "required", createComment],
  ["DELETE", "/api/articles/:slug/comments/:id", "required", deleteComment],
  ["GET", "/api/tags", "none", tags],
];
// URLPattern groups are still percent-encoded.
const decoded = (g: Params): Params => {
  const out: Params = {};
  for (const k in g) {
    try { out[k] = g[k] === undefined ? undefined : decodeURIComponent(g[k]!); } catch { out[k] = g[k]; }
  }
  return out;
};
const table = routes.map(([method, pathname, auth, handler]) => ({ method, pattern: new URLPattern({ pathname }), auth, handler }));

export default {
  async fetch(req: Request): Promise<Response> {
    const url = new URL(req.url);
    for (const r of table) {
      if (r.method !== req.method) continue;
      const m = r.pattern.exec({ pathname: url.pathname });
      if (!m) continue;
      try {
        let a: Auth = { viewer: 0, token: "" };
        if (r.auth !== "none") {
          const { present, viewer, token } = await authOf(req.headers.get("authorization"));
          if (viewer === 0 && (present || r.auth === "required")) return fail(401, "unauthorized");
          a = { viewer, token };
        }
        return await r.handler(req, decoded(m.pathname.groups), a, url);
      } catch (e) {
        console.error(e);
        return fail(500, "internal error");
      }
    }
    return fail(404, "not found");
  },
} satisfies Deno.ServeDefaultExport;
