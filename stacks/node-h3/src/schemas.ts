import { z } from "zod";

const required = z.string().min(1);
const optional = z.string().min(1).nullish();
const password = required.refine((p) => Buffer.byteLength(p) <= 72, "password is longer than 72 bytes");

export const registerBody = z.object({ user: z.object({ username: required, email: required, password }) });
export const loginBody = z.object({ user: z.object({ email: required, password: required }) });
export const updateUserBody = z.object({
  user: z.object({
    email: optional,
    username: optional,
    password: password.nullish(),
    bio: z.string().nullish(),
    image: z.string().nullish(),
  }),
});
export const createArticleBody = z.object({
  article: z.object({
    title: required,
    description: required,
    body: required,
    tagList: z.array(required).nullish(),
  }),
});
export const updateArticleBody = z.object({
  article: z.object({ title: optional, description: optional, body: optional }),
});
export const createCommentBody = z.object({ comment: z.object({ body: required }) });

// limit: 1..100 (default 20); offset: >= 0 and fits a bigint (default 0). Digits only.
const MAX_BIGINT = 9223372036854775807n;
export const pageQuery = z.object({
  limit: z.string().regex(/^\d+$/).transform(Number).pipe(z.number().int().min(1).max(100)).default(20),
  offset: z
    .string()
    .refine((s) => /^\d+$/.test(s) && BigInt(s) <= MAX_BIGINT)
    .transform((s) => BigInt(s).toString())
    .default("0"),
});
export const listQuery = pageQuery.extend({
  tag: z.string().optional(),
  author: z.string().optional(),
  favorited: z.string().optional(),
});
