// Request bodies (zod 4). Objects strip unknown keys; absent or null optional fields mean "unchanged".
import { z } from "zod";
import { bcryptOk } from "./format.ts";

const req = z.string().min(1);
const opt = z.string().min(1).nullish();
const password = z.string().min(1).refine(bcryptOk, "password is longer than 72 bytes");

export const registerBody = z.object({ user: z.object({ username: req, email: req, password }) });
export const loginBody = z.object({ user: z.object({ email: req, password: req }) });
export const updateUserBody = z.object({
  user: z.object({ email: opt, username: opt, password: password.nullish(), bio: z.string().nullish(), image: z.string().nullish() }),
});
export const createArticleBody = z.object({
  article: z.object({ title: req, description: req, body: req, tagList: z.array(req).nullish() }),
});
export const updateArticleBody = z.object({ article: z.object({ title: opt, description: opt, body: opt }) });
export const commentBody = z.object({ comment: z.object({ body: req }) });
