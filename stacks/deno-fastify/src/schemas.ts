// JSON Schemas for request validation (Ajv) and response serialization (fast-json-stringify).

const str = { type: "string", minLength: 1 } as const;
const optStr = { type: ["string", "null"], minLength: 1 } as const;
const nullableStr = { type: ["string", "null"] } as const;

const wrap = (key: string, properties: object, required: string[] = []) => ({
  type: "object",
  required: [key],
  properties: { [key]: { type: "object", required, properties } },
});

export const registerBody = wrap(
  "user",
  { username: str, email: str, password: { ...str, maxLength: 72 } },
  ["username", "email", "password"],
);
export const loginBody = wrap("user", { email: str, password: str }, ["email", "password"]);
export const updateUserBody = wrap("user", {
  email: optStr,
  username: optStr,
  password: { ...optStr, maxLength: 72 },
  bio: nullableStr,
  image: nullableStr,
});
export const createArticleBody = wrap(
  "article",
  { title: str, description: str, body: str, tagList: { type: ["array", "null"], items: str } },
  ["title", "description", "body"],
);
export const updateArticleBody = wrap("article", { title: optStr, description: optStr, body: optStr });
export const createCommentBody = wrap("comment", { body: str }, ["body"]);

// limit 1..100, offset >= 0, digits only (no sign, no spaces). The offset's bigint range is checked in the handler.
const pageProps = {
  limit: { type: "string", pattern: "^0*([1-9][0-9]?|100)$" },
  offset: { type: "string", pattern: "^[0-9]+$" },
} as const;
export const pageQuery = { type: "object", properties: pageProps } as const;
export const listQuery = {
  type: "object",
  properties: { ...pageProps, tag: { type: "string" }, author: { type: "string" }, favorited: { type: "string" } },
} as const;

// ---- responses ----

const profile = {
  type: "object",
  properties: { username: { type: "string" }, bio: nullableStr, image: nullableStr, following: { type: "boolean" } },
} as const;
const article = {
  type: "object",
  properties: {
    slug: { type: "string" },
    title: { type: "string" },
    description: { type: "string" },
    body: { type: "string" },
    tagList: { type: "array", items: { type: "string" } },
    createdAt: { type: "string" },
    updatedAt: { type: "string" },
    favorited: { type: "boolean" },
    favoritesCount: { type: "integer" },
    author: profile,
  },
} as const;
const comment = {
  type: "object",
  properties: {
    id: { type: "integer" },
    createdAt: { type: "string" },
    updatedAt: { type: "string" },
    body: { type: "string" },
    author: profile,
  },
} as const;
const user = {
  type: "object",
  properties: {
    email: { type: "string" },
    token: { type: "string" },
    username: { type: "string" },
    bio: nullableStr,
    image: nullableStr,
  },
} as const;

const obj = (properties: object) => ({ type: "object", properties }) as const;
export const userResponse = obj({ user });
export const profileResponse = obj({ profile });
export const articleResponse = obj({ article });
export const articlesResponse = obj({ articles: { type: "array", items: article }, articlesCount: { type: "integer" } });
export const commentResponse = obj({ comment });
export const commentsResponse = obj({ comments: { type: "array", items: comment } });
export const tagsResponse = obj({ tags: { type: "array", items: { type: "string" } } });
