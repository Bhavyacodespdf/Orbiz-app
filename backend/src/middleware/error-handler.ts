import type { ErrorRequestHandler, RequestHandler } from 'express';
import { ZodError } from 'zod';
import { AppError, notFound } from '../lib/errors.js';

export const notFoundHandler: RequestHandler = (req, _res, next) => {
  next(notFound(`No route for ${req.method} ${req.path}`));
};

/** Every error response has the same shape: { error: { code, message, details? } } */
export const errorHandler: ErrorRequestHandler = (err, req, res, _next) => {
  if (err instanceof AppError) {
    const retryAfter = (err.details as { retryAfterSeconds?: unknown } | undefined)
      ?.retryAfterSeconds;
    if (err.status === 429 && typeof retryAfter === 'number') {
      res.set('Retry-After', String(retryAfter));
    }
    res.status(err.status).json({
      error: { code: err.code, message: err.message, details: err.details },
    });
    return;
  }

  if (err instanceof ZodError) {
    res.status(400).json({
      error: { code: 'VALIDATION_ERROR', message: 'Invalid request', details: err.issues },
    });
    return;
  }

  // express.json() rejects bodies over the size limit or with malformed JSON.
  const status = typeof err?.status === 'number' ? err.status : 500;
  if (status === 413 || status === 400) {
    res.status(status).json({
      error: {
        code: status === 413 ? 'PAYLOAD_TOO_LARGE' : 'BAD_REQUEST',
        message: status === 413 ? 'Request body is too large' : 'Malformed request body',
      },
    });
    return;
  }

  req.log.error({ err }, 'Unhandled error');
  res.status(500).json({ error: { code: 'INTERNAL_ERROR', message: 'Something went wrong' } });
};
