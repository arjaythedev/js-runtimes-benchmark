import { jwtVerify, SignJWT } from 'jose';
import { HttpError, type Ctx } from './http.js';

const key = new TextEncoder().encode(process.env.JWT_SECRET);
const TTL = 30 * 24 * 3600;

export function sign(id: number): Promise<string> {
  const now = Math.floor(Date.now() / 1000);
  return new SignJWT({ sub: String(id) }).setProtectedHeader({ alg: 'HS256' }).setIssuedAt(now).setExpirationTime(now + TTL).sign(key);
}

export interface Viewer {
  viewer: number;
  token: string;
}

// 'required': 401 without a valid token. 'optional': viewer 0 without a header, 401 if the header is invalid.
export async function auth(ctx: Ctx, mode: 'required' | 'optional'): Promise<Viewer> {
  const header = ctx.authorization;
  if (header === '') {
    if (mode === 'optional') return { viewer: 0, token: '' };
    throw new HttpError(401, 'missing token');
  }
  // RealWorld's scheme is "Token <jwt>", not "Bearer".
  const [scheme, token] = header.split(' ');
  if (scheme !== 'Token' || !token) throw new HttpError(401, 'invalid token');
  let payload;
  try {
    ({ payload } = await jwtVerify(token, key, { algorithms: ['HS256'], requiredClaims: ['exp'] }));
  } catch {
    throw new HttpError(401, 'invalid token');
  }
  if (typeof payload.sub !== 'string' || !/^[1-9][0-9]*$/.test(payload.sub)) throw new HttpError(401, 'invalid token');
  return { viewer: Number(payload.sub), token };
}
