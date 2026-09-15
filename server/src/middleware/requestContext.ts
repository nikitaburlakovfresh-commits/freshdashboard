import { Request, Response, NextFunction } from 'express';
import { randomUUID as uuidv4 } from 'crypto';

export interface RequestContext {
  requestId: string;
}

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      ctx: RequestContext;
    }
  }
}

// Every response gets a server-generated request_id (echoed as X-Request-ID)
// and no-store per contract §6 ("All responses include X-Request-ID and
// Cache-Control:no-store").
export function requestContext(req: Request, res: Response, next: NextFunction) {
  const requestId = uuidv4();
  req.ctx = { requestId };
  res.setHeader('X-Request-ID', requestId);
  res.setHeader('Cache-Control', 'no-store');
  next();
}
