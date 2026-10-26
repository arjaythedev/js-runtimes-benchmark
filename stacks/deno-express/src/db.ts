// postgres.js (npm:postgres) client and the reference SQL from SPEC.md, written as postgres.js tagged templates
// (each ${value} becomes a $n parameter; nested sql`` fragments are inlined). Statements are prepared (the default).
import process from "node:process";
import postgres from "postgres";

export type Filter = { kind: "tag" | "author" | "favorited"; value: string } | null;

// Every cluster worker opens its own pool; the total across them stays <= 90.
export function connect(workers: number) {
  const sql = postgres(process.env.DATABASE_URL!, {
    max: Math.max(1, Math.floor(90 / workers)),
    // int8 (ids, count(*)) arrives as a string by default; every value in this schema fits a JS number.
    types: { bigint: { to: 20, from: [20], serialize: (x: number) => String(x), parse: (x: string) => Number(x) } },
    onnotice: () => {},
  });
  return sql;
}

export type Sql = ReturnType<typeof connect>;

export function queries(sql: Sql) {
  const listSelect = (viewer: number) => sql`
SELECT a.id, a.slug, a.title, a.description, a.created_at, a.updated_at,
       ARRAY(SELECT t.name FROM article_tags at JOIN tags t ON t.id = at.tag_id
              WHERE at.article_id = a.id ORDER BY t.name) AS tag_list,
       (SELECT count(*) FROM favorites f WHERE f.article_id = a.id) AS favorites_count,
       EXISTS (SELECT 1 FROM favorites f WHERE f.article_id = a.id AND f.user_id = ${viewer}) AS favorited,
       u.username, u.bio, u.image,
       EXISTS (SELECT 1 FROM follows fo WHERE fo.follower_id = ${viewer} AND fo.followee_id = a.author_id) AS following
  FROM articles a
  JOIN users u ON u.id = a.author_id`;

  const fullSelect = (viewer: number) => sql`
SELECT a.id, a.slug, a.title, a.description, a.body, a.created_at, a.updated_at,
       ARRAY(SELECT t.name FROM article_tags at JOIN tags t ON t.id = at.tag_id
              WHERE at.article_id = a.id ORDER BY t.name) AS tag_list,
       (SELECT count(*) FROM favorites f WHERE f.article_id = a.id) AS favorites_count,
       EXISTS (SELECT 1 FROM favorites f WHERE f.article_id = a.id AND f.user_id = ${viewer}) AS favorited,
       u.username, u.bio, u.image,
       EXISTS (SELECT 1 FROM follows fo WHERE fo.follower_id = ${viewer} AND fo.followee_id = a.author_id) AS following
  FROM articles a
  JOIN users u ON u.id = a.author_id`;

  const slugify = (x: string) => sql`trim(both '-' from lower(regexp_replace(${x}::text, '[^A-Za-z0-9]+', '-', 'g')))`;

  return {
    // ---------- users ----------
    insertUser: (username: string, email: string, hash: string) => sql`
INSERT INTO users (username, email, password_hash) VALUES (${username}, ${email}, ${hash})
RETURNING id, username, email, bio, image`,

    userByEmail: (email: string) => sql`
SELECT id, username, email, bio, image, password_hash FROM users WHERE email = ${email}`,

    userById: (id: number) => sql`SELECT id, username, email, bio, image FROM users WHERE id = ${id}`,

    updateUser: (id: number, email: string | null, username: string | null, hash: string | null,
                 bio: string | null, image: string | null) => sql`
UPDATE users SET email = COALESCE(${email}, email), username = COALESCE(${username}, username),
                 password_hash = COALESCE(${hash}, password_hash), bio = COALESCE(${bio}, bio), image = COALESCE(${image}, image)
 WHERE id = ${id}
RETURNING id, username, email, bio, image`,

    // ---------- profiles ----------
    profile: (viewer: number, username: string) => sql`
SELECT u.id, u.username, u.bio, u.image,
       EXISTS (SELECT 1 FROM follows fo WHERE fo.follower_id = ${viewer} AND fo.followee_id = u.id) AS following
  FROM users u WHERE u.username = ${username}`,

    userByUsername: (username: string) => sql`SELECT id, username, bio, image FROM users WHERE username = ${username}`,

    follow: (viewer: number, id: number) => sql`
INSERT INTO follows (follower_id, followee_id) VALUES (${viewer}, ${id}) ON CONFLICT DO NOTHING`,

    unfollow: (viewer: number, id: number) => sql`DELETE FROM follows WHERE follower_id = ${viewer} AND followee_id = ${id}`,

    // ---------- article lists: the page, then the capped count ----------
    listPage: (viewer: number, limit: number, offset: number, filter: Filter) => {
      if (!filter) return sql`${listSelect(viewer)} ORDER BY a.id DESC LIMIT ${limit} OFFSET ${offset}`;
      switch (filter.kind) {
        case "tag": return sql`${listSelect(viewer)} WHERE a.id IN (SELECT at.article_id FROM article_tags at WHERE at.tag_id = (SELECT t.id FROM tags t WHERE t.name = ${filter.value}) ORDER BY at.article_id DESC LIMIT ${limit} OFFSET ${offset}) ORDER BY a.id DESC`;
        case "author": return sql`${listSelect(viewer)} WHERE a.author_id = (SELECT au.id FROM users au WHERE au.username = ${filter.value}) ORDER BY a.id DESC LIMIT ${limit} OFFSET ${offset}`;
        case "favorited": return sql`${listSelect(viewer)} WHERE a.id IN (SELECT f.article_id FROM favorites f WHERE f.user_id = (SELECT fu.id FROM users fu WHERE fu.username = ${filter.value}) ORDER BY f.article_id DESC LIMIT ${limit} OFFSET ${offset}) ORDER BY a.id DESC`;
      }
    },

    listCount: (filter: Filter) => {
      if (!filter) return sql`SELECT count(*) FROM (SELECT 1 FROM articles a LIMIT 1000) s`;
      switch (filter.kind) {
        case "tag": return sql`SELECT count(*) FROM (SELECT 1 FROM article_tags at WHERE at.tag_id = (SELECT t.id FROM tags t WHERE t.name = ${filter.value}) LIMIT 1000) s`;
        case "author": return sql`SELECT count(*) FROM (SELECT 1 FROM articles a WHERE a.author_id = (SELECT u.id FROM users u WHERE u.username = ${filter.value}) LIMIT 1000) s`;
        case "favorited": return sql`SELECT count(*) FROM (SELECT 1 FROM favorites f WHERE f.user_id = (SELECT fu.id FROM users fu WHERE fu.username = ${filter.value}) LIMIT 1000) s`;
      }
    },

    feedPage: (viewer: number, limit: number, offset: number) => sql`
${listSelect(viewer)} WHERE a.id IN (SELECT x.id FROM follows fo CROSS JOIN LATERAL
    (SELECT a2.id FROM articles a2 WHERE a2.author_id = fo.followee_id ORDER BY a2.id DESC LIMIT (${limit}::int + ${offset}::int)) x
  WHERE fo.follower_id = ${viewer} ORDER BY x.id DESC LIMIT ${limit} OFFSET ${offset}) ORDER BY a.id DESC`,

    feedCount: (viewer: number) => sql`
SELECT count(*) FROM (SELECT 1 FROM articles a WHERE a.author_id IN (SELECT fo.followee_id FROM follows fo WHERE fo.follower_id = ${viewer}) LIMIT 1000) s`,

    // ---------- single articles ----------
    articleBySlug: (viewer: number, slug: string) => sql`${fullSelect(viewer)} WHERE a.slug = ${slug}`,
    articleById: (viewer: number, id: number) => sql`${fullSelect(viewer)} WHERE a.id = ${id}`,

    createArticle: (viewer: number, title: string, description: string, body: string, tags: string[]) =>
      sql.begin(async (tx) => {
        const [{ id }] = await tx`
INSERT INTO articles (id, slug, author_id, title, description, body)
SELECT n.id, ${slugify(title)} || '-' || n.id, ${viewer}, ${title}, ${description}, ${body}
  FROM (SELECT nextval(pg_get_serial_sequence('articles', 'id')) AS id) n
RETURNING id`;
        if (tags.length > 0) {
          await tx`INSERT INTO tags (name) SELECT DISTINCT unnest(${tags}::text[]) ON CONFLICT (name) DO NOTHING`;
          await tx`INSERT INTO article_tags (article_id, tag_id) SELECT ${id}, t.id FROM tags t WHERE t.name = ANY(${tags}::text[])`;
        }
        return id as number;
      }),

    articleOwner: (slug: string) => sql`SELECT id, author_id FROM articles WHERE slug = ${slug}`,

    updateArticle: (id: number, title: string | null, description: string | null, body: string | null) => sql`
UPDATE articles SET title = COALESCE(${title}, title), description = COALESCE(${description}, description), body = COALESCE(${body}, body),
       slug = CASE WHEN ${title}::text IS NULL THEN slug ELSE ${slugify(title!)} || '-' || id END,
       updated_at = now()
 WHERE id = ${id}`,

    deleteArticle: (id: number) => sql`DELETE FROM articles WHERE id = ${id}`,

    articleIdBySlug: (slug: string) => sql`SELECT id FROM articles WHERE slug = ${slug}`,

    favorite: (viewer: number, id: number) => sql`
INSERT INTO favorites (user_id, article_id) VALUES (${viewer}, ${id}) ON CONFLICT DO NOTHING`,

    unfavorite: (viewer: number, id: number) => sql`DELETE FROM favorites WHERE user_id = ${viewer} AND article_id = ${id}`,

    // ---------- comments ----------
    comments: (viewer: number, articleId: number) => sql`
SELECT c.id, c.body, c.created_at, c.updated_at, u.username, u.bio, u.image,
       EXISTS (SELECT 1 FROM follows fo WHERE fo.follower_id = ${viewer} AND fo.followee_id = c.author_id) AS following
  FROM comments c JOIN users u ON u.id = c.author_id
 WHERE c.article_id = ${articleId}
 ORDER BY c.created_at DESC, c.id DESC
 LIMIT 100`,

    insertComment: (articleId: number, viewer: number, body: string) => sql`
WITH c AS (INSERT INTO comments (article_id, author_id, body) VALUES (${articleId}, ${viewer}, ${body})
           RETURNING id, body, created_at, updated_at, author_id)
SELECT c.id, c.body, c.created_at, c.updated_at, u.username, u.bio, u.image
  FROM c JOIN users u ON u.id = c.author_id`,

    commentAuthor: (id: string, slug: string) => sql`
SELECT c.author_id FROM comments c JOIN articles a ON a.id = c.article_id
 WHERE c.id = ${id} AND a.slug = ${slug}`,

    deleteComment: (id: string) => sql`DELETE FROM comments WHERE id = ${id}`,

    // ---------- tags ----------
    tags: () => sql`SELECT name FROM tags ORDER BY name`,
  };
}

export type Queries = ReturnType<typeof queries>;

export const isUniqueViolation = (e: unknown) => (e as { code?: string })?.code === "23505";
