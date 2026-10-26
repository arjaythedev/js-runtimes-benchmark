// Conduit on Bun.serve with its built-in `routes` (no framework). One process; cluster.ts starts one per core.
import { SignJWT, jwtVerify } from "jose";
import * as db from "./db";
import * as f from "./format";

const key = new TextEncoder().encode(process.env.JWT_SECRET!);

const json = (body: unknown, status = 200) => Response.json(body, { status });
const fail = (status: number, msg: string) => json(f.errors(msg), status);
const noContent = () => new Response(null, { status: 204 });

const issue = (id: string | number) =>
  new SignJWT({}).setProtectedHeader({ alg: "HS256" }).setSubject(String(id)).setIssuedAt().setExpirationTime("30d").sign(key);

type Auth = { viewer: number; token: string };

// Authorization: Token <jwt>. Returns null for a missing header, or a 401 Response for a bad one.
async function authenticate(req: Request): Promise<Auth | Response | null> {
  const h = req.headers.get("authorization");
  if (h === null) return null;
  if (!h.startsWith("Token ")) return fail(401, "unauthorized");
  const token = h.slice(6);
  try {
    const { payload } = await jwtVerify(token, key, { algorithms: ["HS256"], requiredClaims: ["exp"] });
    const viewer = f.viewerFromSub(payload.sub);
    if (viewer === 0) return fail(401, "unauthorized");
    return { viewer, token };
  } catch {
    return fail(401, "unauthorized");
  }
}

// Route wrappers: required gives 401 without a token; optional gives viewer 0.
type Handler<P> = (req: Bun.BunRequest<any> & { params: P }, auth: Auth) => Promise<Response>;
const required = <P>(h: Handler<P>) => async (req: any) => {
  const a = await authenticate(req);
  if (a === null) return fail(401, "unauthorized");
  if (a instanceof Response) return a;
  return h(req, a);
};
const optional = <P>(h: Handler<P>) => async (req: any) => {
  const a = await authenticate(req);
  if (a instanceof Response) return a;
  return h(req, a ?? { viewer: 0, token: "" });
};

// ---------- request body validation (hand-written; no framework) ----------

class BadBody extends Error {}
type Obj = Record<string, unknown>;
const isObj = (x: unknown): x is Obj => typeof x === "object" && x !== null && !Array.isArray(x);

async function wrapper(req: Request, k: string): Promise<Obj> {
  let top: unknown;
  try { top = await req.json(); } catch { throw new BadBody(); }
  if (!isObj(top) || !isObj(top[k])) throw new BadBody();
  return top[k] as Obj;
}
function opt(m: Obj, k: string, nonEmpty: boolean): string | null {
  const v = m[k];
  if (v === undefined || v === null) return null;
  if (typeof v !== "string" || (nonEmpty && v === "")) throw new BadBody();
  return v;
}
function req(m: Obj, k: string): string {
  const v = opt(m, k, true);
  if (v === null) throw new BadBody();
  return v;
}
// Runs a body parser; a BadBody becomes 422.
async function body<T>(fn: () => Promise<T>): Promise<T | Response> {
  try { return await fn(); } catch (e) { if (e instanceof BadBody) return fail(422, "invalid body"); throw e; }
}

// ---------- handlers ----------

async function articleList(req: Request, viewer: number, isFeed: boolean) {
  const q = new URL(req.url).searchParams;
  const p = f.page(q.get("limit"), q.get("offset"));
  if (!p) return fail(422, "invalid limit or offset");
  let rows, count;
  if (isFeed) {
    rows = await db.feed(viewer, p.limit, p.offset); count = await db.countFeed(viewer);
  } else if (q.get("tag")) {
    const v = q.get("tag")!; rows = await db.listByTag(viewer, p.limit, p.offset, v); count = await db.countByTag(v);
  } else if (q.get("author")) {
    const v = q.get("author")!; rows = await db.listByAuthor(viewer, p.limit, p.offset, v); count = await db.countByAuthor(v);
  } else if (q.get("favorited")) {
    const v = q.get("favorited")!; rows = await db.listByFavorited(viewer, p.limit, p.offset, v); count = await db.countByFavorited(v);
  } else {
    rows = await db.listArticles(viewer, p.limit, p.offset); count = await db.countArticles();
  }
  return json({ articles: rows.map((r: any) => f.article(r, false)), articlesCount: count });
}

async function ownArticle(slug: string, viewer: number) {
  const a = await db.articleOwner(slug);
  if (!a) return fail(404, "article not found");
  if (Number(a.author_id) !== viewer) return fail(403, "forbidden");
  return a.id as string;
}

const server = Bun.serve({
  hostname: process.env.HOST,
  port: Number(process.env.PORT),
  reusePort: true,
  idleTimeout: 75,
  // H2C=1 (the HTTP/2 side test): Bun.serve's `http2: true` (Bun 1.4.1+), cleartext h2 with prior knowledge.
  ...((process.env.H2C === "1" ? { http2: true } : {}) as {}),
  development: false,
  routes: {
    "/api/users": {
      POST: async (r) => {
        const b = await body(async () => {
          const m = await wrapper(r, "user");
          return { username: req(m, "username"), email: req(m, "email"), password: req(m, "password") };
        });
        if (b instanceof Response) return b;
        if (f.tooLong(b.password)) return fail(422, "password is too long");
        const hash = await f.hashPassword(b.password);
        let u;
        try { u = await db.insertUser(b.username, b.email, hash); } catch (e) {
          if (db.isUniqueViolation(e)) return fail(422, "username or email is already taken");
          throw e;
        }
        return json({ user: f.user(u, await issue(u.id)) }, 201);
      },
    },
    "/api/users/login": {
      POST: async (r) => {
        const b = await body(async () => {
          const m = await wrapper(r, "user");
          return { email: req(m, "email"), password: req(m, "password") };
        });
        if (b instanceof Response) return b;
        const u = await db.userByEmail(b.email);
        if (!u || !(await f.verifyPassword(b.password, u.password_hash))) return fail(401, "invalid email or password");
        return json({ user: f.user(u, await issue(u.id)) });
      },
    },
    "/api/user": {
      GET: required(async (_r, a) => {
        const u = await db.userById(a.viewer);
        if (!u) return fail(401, "unauthorized");
        return json({ user: f.user(u, a.token) });
      }),
      PUT: required(async (r, a) => {
        const b = await body(async () => {
          const m = await wrapper(r, "user");
          return {
            email: opt(m, "email", true), username: opt(m, "username", true), password: opt(m, "password", true),
            bio: opt(m, "bio", false), image: opt(m, "image", false),
          };
        });
        if (b instanceof Response) return b;
        if (b.password !== null && f.tooLong(b.password)) return fail(422, "password is too long");
        const hash = b.password === null ? null : await f.hashPassword(b.password);
        let u;
        try { u = await db.updateUser(a.viewer, b.email, b.username, hash, b.bio, b.image); } catch (e) {
          if (db.isUniqueViolation(e)) return fail(422, "username or email is already taken");
          throw e;
        }
        if (!u) return fail(401, "unauthorized");
        return json({ user: f.user(u, a.token) });
      }),
    },
    "/api/profiles/:username": {
      GET: optional<{ username: string }>(async (r, a) => {
        const p = await db.profile(a.viewer, r.params.username);
        if (!p) return fail(404, "profile not found");
        return json({ profile: f.profile(p) });
      }),
    },
    "/api/profiles/:username/follow": {
      POST: required<{ username: string }>(async (r, a) => {
        const u = await db.userByUsername(r.params.username);
        if (!u) return fail(404, "profile not found");
        await db.follow(a.viewer, u.id);
        return json({ profile: f.profile(u, true) });
      }),
      DELETE: required<{ username: string }>(async (r, a) => {
        const u = await db.userByUsername(r.params.username);
        if (!u) return fail(404, "profile not found");
        await db.unfollow(a.viewer, u.id);
        return json({ profile: f.profile(u, false) });
      }),
    },
    "/api/articles": {
      GET: optional(async (r, a) => articleList(r, a.viewer, false)),
      POST: required(async (r, a) => {
        const b = await body(async () => {
          const m = await wrapper(r, "article");
          const t = m.tagList;
          if (t !== undefined && t !== null && (!Array.isArray(t) || !t.every((x) => typeof x === "string" && x !== "")))
            throw new BadBody();
          return { title: req(m, "title"), description: req(m, "description"), body: req(m, "body"), tagList: (t ?? []) as string[] };
        });
        if (b instanceof Response) return b;
        const id = await db.createArticle(a.viewer, b.title, b.description, b.body, b.tagList);
        return json({ article: f.article(await db.articleById(a.viewer, id), true) }, 201);
      }),
    },
    "/api/articles/feed": {
      GET: required(async (r, a) => articleList(r, a.viewer, true)),
    },
    "/api/articles/:slug": {
      GET: optional<{ slug: string }>(async (r, a) => {
        const row = await db.articleBySlug(a.viewer, r.params.slug);
        if (!row) return fail(404, "article not found");
        return json({ article: f.article(row, true) });
      }),
      PUT: required<{ slug: string }>(async (r, a) => {
        const b = await body(async () => {
          const m = await wrapper(r, "article");
          return { title: opt(m, "title", true), description: opt(m, "description", true), body: opt(m, "body", true) };
        });
        if (b instanceof Response) return b;
        const id = await ownArticle(r.params.slug, a.viewer);
        if (id instanceof Response) return id;
        await db.updateArticle(id, b.title, b.description, b.body);
        return json({ article: f.article(await db.articleById(a.viewer, id), true) });
      }),
      DELETE: required<{ slug: string }>(async (r, a) => {
        const id = await ownArticle(r.params.slug, a.viewer);
        if (id instanceof Response) return id;
        await db.deleteArticle(id);
        return noContent();
      }),
    },
    "/api/articles/:slug/favorite": {
      POST: required<{ slug: string }>(async (r, a) => {
        const id = await db.articleId(r.params.slug);
        if (!id) return fail(404, "article not found");
        await db.favorite(a.viewer, id);
        return json({ article: f.article(await db.articleById(a.viewer, id), true) });
      }),
      DELETE: required<{ slug: string }>(async (r, a) => {
        const id = await db.articleId(r.params.slug);
        if (!id) return fail(404, "article not found");
        await db.unfavorite(a.viewer, id);
        return json({ article: f.article(await db.articleById(a.viewer, id), true) });
      }),
    },
    "/api/articles/:slug/comments": {
      GET: optional<{ slug: string }>(async (r, a) => {
        const id = await db.articleId(r.params.slug);
        if (!id) return fail(404, "article not found");
        const rows = await db.comments(a.viewer, id);
        return json({ comments: rows.map((c: any) => f.comment(c)) });
      }),
      POST: required<{ slug: string }>(async (r, a) => {
        const b = await body(async () => ({ body: req(await wrapper(r, "comment"), "body") }));
        if (b instanceof Response) return b;
        const id = await db.articleId(r.params.slug);
        if (!id) return fail(404, "article not found");
        return json({ comment: f.comment(await db.insertComment(id, a.viewer, b.body), false) }, 201);
      }),
    },
    "/api/articles/:slug/comments/:id": {
      DELETE: required<{ slug: string; id: string }>(async (r, a) => {
        if (!f.isId(r.params.id)) return fail(404, "comment not found");
        const author = await db.commentAuthor(r.params.id, r.params.slug);
        if (author === undefined) return fail(404, "comment not found");
        if (Number(author) !== a.viewer) return fail(403, "forbidden");
        await db.deleteComment(r.params.id);
        return noContent();
      }),
    },
    "/api/tags": {
      GET: async () => json({ tags: await db.tags() }),
    },
  },
  fetch: () => fail(404, "not found"),
  error(e) {
    console.error(e);
    return fail(500, "internal error");
  },
});

void server;
