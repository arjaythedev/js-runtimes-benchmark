// JWT HS256 with jose: `Authorization: Token <jwt>`, claims {sub: "<id>", iat, exp: +30 days}.
import process from "node:process";
import { jwtVerify, SignJWT } from "jose";
import { TOKEN_TTL } from "./format.ts";

const key = new TextEncoder().encode(process.env.JWT_SECRET!);

export const signToken = (id: number) =>
  new SignJWT({}).setProtectedHeader({ alg: "HS256" }).setSubject(String(id))
    .setIssuedAt().setExpirationTime(`${TOKEN_TTL}s`).sign(key);

// present: the header was sent; viewer > 0: a valid token for that user id.
export async function authOf(header: string | null): Promise<{ present: boolean; viewer: number; token: string }> {
  if (!header) return { present: false, viewer: 0, token: "" };
  if (!header.startsWith("Token ")) return { present: true, viewer: 0, token: "" };
  const token = header.slice(6);
  try {
    const { payload } = await jwtVerify(token, key, { algorithms: ["HS256"], requiredClaims: ["exp"] });
    if (typeof payload.sub !== "string" || !/^[0-9]+$/.test(payload.sub)) return { present: true, viewer: 0, token: "" };
    const viewer = Number(payload.sub);
    return viewer > 0 ? { present: true, viewer, token } : { present: true, viewer: 0, token: "" };
  } catch {
    return { present: true, viewer: 0, token: "" };
  }
}
