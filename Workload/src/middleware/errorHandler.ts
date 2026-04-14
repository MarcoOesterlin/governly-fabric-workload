import type { ErrorRequestHandler } from 'express';

export const errorHandler: ErrorRequestHandler = (err, _req, res, _next) => {
  console.error('Unhandled error:', err);
  res.status((err as { status?: number }).status ?? 500).json({
    error: (err as Error).message ?? 'Internal server error',
    ...(process.env.NODE_ENV !== 'production' && { stack: (err as Error).stack }),
  });
};
