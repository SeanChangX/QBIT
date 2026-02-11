// ---------------------------------------------------------------------------
//  Global error-handling middleware
// ---------------------------------------------------------------------------

import { Request, Response, NextFunction } from 'express';
import logger from '../logger';
import { isProduction } from '../config';

// eslint-disable-next-line @typescript-eslint/no-unused-vars
export function errorHandler(err: Error, _req: Request, res: Response, _next: NextFunction): void {
  logger.error({ err, stack: err.stack }, 'Unhandled error');

  if (res.headersSent) return;

  const status = (err as unknown as Record<string, unknown>).status as number || 500;

  if (isProduction) {
    res.status(status).json({ error: 'Internal server error' });
  } else {
    res.status(status).json({ error: err.message, stack: err.stack });
  }
}
