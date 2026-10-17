/**
 * An error that is safe to show to the client. Anything else that is thrown
 * becomes a generic 500 so internal details never leak.
 */
export class AppError extends Error {
  constructor(
    public readonly status: number,
    public readonly code: string,
    message: string,
    public readonly details?: unknown,
  ) {
    super(message);
    this.name = 'AppError';
  }
}

export const notFound = (message = 'Resource not found') => new AppError(404, 'NOT_FOUND', message);

export const unauthenticated = () =>
  new AppError(401, 'UNAUTHENTICATED', 'You need to sign in to do that.');

export const forbidden = (message = 'You do not have permission to do that.') =>
  new AppError(403, 'FORBIDDEN', message);
