// JWT HS256 with jose (no framework, so the common library). Header scheme is "Token <jwt>".
import { SignJWT, jwtVerify } from "jose";

export function createJwt(secret: string) {
  const key = new TextEncoder().encode(secret);
  return {
    sign: (userId: string) =>
      new SignJWT({})
        .setProtectedHeader({ alg: "HS256" })
        .setSubject(userId)
        .setIssuedAt()
        .setExpirationTime("30d")
        .sign(key),

    // Returns the user id (decimal string) or null if the token is invalid or expired.
    async verify(token: string): Promise<string | null> {
      try {
        const { payload } = await jwtVerify(token, key, { algorithms: ["HS256"], requiredClaims: ["exp"] });
        return typeof payload.sub === "string" && /^[1-9]\d{0,18}$/.test(payload.sub) ? payload.sub : null;
      } catch {
        return null;
      }
    },
  };
}
export type Jwt = ReturnType<typeof createJwt>;
