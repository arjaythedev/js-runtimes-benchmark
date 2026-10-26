// JWT with Hono's own helper (hono/jwt). The hono/jwt *middleware* only accepts "Bearer" and has no
// optional mode, so this small middleware reads "Authorization: Token <jwt>" and calls hono/jwt's verify.
import { createMiddleware } from "hono/factory";
import { HTTPException } from "hono/http-exception";
import { sign, verify } from "hono/jwt";

export type AuthEnv = { Variables: { viewer: string; token: string } };

const THIRTY_DAYS = 30 * 24 * 60 * 60;

export function createAuth(secret: string) {
  async function check(header: string): Promise<string> {
    const token = header.startsWith("Token ") ? header.slice(6) : "";
    try {
      const payload = await verify(token, secret, "HS256");
      // hono/jwt checks exp only when present; this API requires it.
      if (typeof payload.exp !== "number") throw new Error("no exp");
      if (typeof payload.sub !== "string" || !/^[1-9]\d{0,18}$/.test(payload.sub)) throw new Error("bad sub");
      return payload.sub;
    } catch {
      throw new HTTPException(401, { message: "invalid token" });
    }
  }
  const middleware = (required: boolean) =>
    createMiddleware<AuthEnv>(async (c, next) => {
      const header = c.req.header("authorization");
      c.set("viewer", "0");
      c.set("token", "");
      if (header === undefined) {
        if (required) throw new HTTPException(401, { message: "authentication required" });
      } else {
        c.set("viewer", await check(header));
        c.set("token", header.slice(6));
      }
      await next();
    });

  return {
    requireAuth: middleware(true),
    optionalAuth: middleware(false),
    issue(userId: string) {
      const now = Math.floor(Date.now() / 1000);
      return sign({ sub: userId, iat: now, exp: now + THIRTY_DAYS }, secret, "HS256");
    },
  };
}
