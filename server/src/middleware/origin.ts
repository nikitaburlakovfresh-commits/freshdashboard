import { Request, Response, NextFunction } from 'express';
import { config } from '../config';
import { ApiError } from '../util/errors';

// Contract §7: every unsafe request checks exact Origin allowlist; missing
// or non-matching Origin -> 403 ORIGIN_DENIED. Applies to login too (login
// CSRF via Origin, no session token available yet at that point).
export function requireOrigin(req: Request, _res: Response, next: NextFunction) {
  const origin = req.header('Origin');
  if (!origin || origin !== config.allowedOrigin) {
    return next(new ApiError('ORIGIN_DENIED', 'Недопустимый или отсутствующий Origin.'));
  }
  next();
}
