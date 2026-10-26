import { Elysia } from 'elysia';

// Thrown by handlers for 401/403/404/422; rendered by the onError hook below.
export class HttpError extends Error {
  constructor(
    public status: number,
    message: string,
  ) {
    super(message);
  }
}

const body = (message: string) => ({ errors: { body: [message] } });

// Every error leaves as RealWorld's {"errors": {"body": [...]}} shape.
export const errors = new Elysia({ name: 'errors' })
  .error({ HttpError })
  .onError({ as: 'global' }, ({ code, error, set }) => {
    switch (code) {
      case 'HttpError':
        set.status = error.status;
        return body(error.message);
      case 'VALIDATION':
      case 'PARSE':
        set.status = 422;
        return body('invalid request');
      case 'NOT_FOUND':
        set.status = 404;
        return body('not found');
      default:
        console.error(error);
        set.status = 500;
        return body('internal error');
    }
  });
