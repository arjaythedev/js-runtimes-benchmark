import { createParamDecorator, ExecutionContext } from '@nestjs/common';
import { Reflector } from '@nestjs/core';

export type AuthMode = 'required' | 'optional' | 'none';

// @Auth('optional') / @Auth('none') on a handler or controller; the global AuthGuard defaults to 'required'.
export const Auth = Reflector.createDecorator<AuthMode>();

export interface AuthedRequest {
  viewer: number;
  token: string;
}

// The viewer's user id (0 when anonymous) and the token the request presented.
export const Viewer = createParamDecorator((_: unknown, ctx: ExecutionContext) =>
  ctx.switchToHttp().getRequest<AuthedRequest>().viewer ?? 0,
);
export const Token = createParamDecorator((_: unknown, ctx: ExecutionContext) =>
  ctx.switchToHttp().getRequest<AuthedRequest>().token ?? '',
);
