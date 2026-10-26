import { CanActivate, ExecutionContext, Injectable, UnauthorizedException } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { JwtService } from '@nestjs/jwt';
import { Auth, AuthedRequest } from './auth.decorators.js';

@Injectable()
export class AuthGuard implements CanActivate {
  constructor(
    private readonly jwt: JwtService,
    private readonly reflector: Reflector,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const mode = this.reflector.getAllAndOverride(Auth, [context.getHandler(), context.getClass()]) ?? 'required';
    if (mode === 'none') return true;
    const request = context.switchToHttp().getRequest<AuthedRequest & { headers: Record<string, string | undefined> }>();
    const header = request.headers.authorization;
    if (header === undefined) {
      if (mode === 'optional') {
        request.viewer = 0;
        return true;
      }
      throw new UnauthorizedException('missing token');
    }
    // RealWorld's scheme is "Token <jwt>", not "Bearer".
    const [scheme, token] = header.split(' ');
    if (scheme !== 'Token' || !token) throw new UnauthorizedException('invalid token');
    let payload: { sub?: unknown; exp?: unknown };
    try {
      payload = await this.jwt.verifyAsync(token, { algorithms: ['HS256'] });
    } catch {
      throw new UnauthorizedException('invalid token');
    }
    if (typeof payload.exp !== 'number' || typeof payload.sub !== 'string' || !/^[1-9][0-9]*$/.test(payload.sub)) {
      throw new UnauthorizedException('invalid token');
    }
    request.viewer = Number(payload.sub);
    request.token = token;
    return true;
  }
}
