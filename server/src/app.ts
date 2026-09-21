import express, { Request, Response, NextFunction } from 'express';
import path from 'path';
import fs from 'fs';
import { requestContext } from './middleware/requestContext';
import { authRouter, meRouter } from './routes/auth';
import { workItemsRouter } from './routes/workItems';
import { notificationsRouter } from './routes/notifications';
import { organizationRouter } from './routes/organization';
import { reportBatchesRouter } from './routes/reportBatches';
import { accessRouter } from './routes/access';
import { dailyRouter } from './routes/dailyLogs';
import { reportFactsRouter } from './routes/reportFacts';
import { reportDetailRouter } from './routes/reportDetail';
import { metricsRouter } from './routes/metrics';
import { roleViewRouter } from './routes/roleView';
import { adminSettingsRouter, publicRegistrationRouter } from './routes/adminSettings';
import { ApiError, errorBody } from './util/errors';

export function createApp() {
  const app = express();
  app.disable('x-powered-by');
  // Trust the local proxy only for req.ip in this pilot; no external LB.
  app.set('trust proxy', false);

  app.use(requestContext);
  app.use(
    express.json({
      // Contract ENGINEERING_PILOT.md, DoS/payload row: body <=32KiB,
      // gateway responds 422. Previously mistakenly set to 40kb (silently
      // exceeding the mandated cap) -- fixed to the exact contract value.
      limit: '32kb',
      strict: true,
    }),
  );

  app.use('/api/v1/auth', authRouter);
  app.use('/api/v1/me', meRouter);
  app.use('/api/v1/work-items', workItemsRouter);
  app.use('/api/v1/notifications', notificationsRouter);
  app.use('/api/v1/organization', organizationRouter);
  app.use('/api/v1/report-batches', reportBatchesRouter);
  app.use('/api/v1/access', accessRouter);
  app.use('/api/v1/daily-logs', dailyRouter);
  app.use('/api/v1/report-facts', reportFactsRouter);
  app.use('/api/v1/report-detail', reportDetailRouter);
  app.use('/api/v1/metrics', metricsRouter);
  app.use('/api/v1/view-as', roleViewRouter);
  app.use('/api/v1/registration', publicRegistrationRouter);
  app.use('/api/v1/admin-settings', adminSettingsRouter);

  app.get('/api/v1/healthz', (_req, res) => {
    res.status(200).json({ status: 'ok' });
  });

  // 404 for unknown routes under /api/v1
  app.use('/api/v1', (req: Request, res: Response) => {
    res.status(404).json(errorBody(new ApiError('NOT_FOUND', 'Маршрут не найден.'), req.ctx?.requestId ?? 'unknown'));
  });

  const clientDist = process.env.CLIENT_DIST;
  if (clientDist) {
    const root = path.resolve(clientDist);
    if (!fs.existsSync(path.join(root, 'index.html'))) {
      throw new Error('CLIENT_DIST must contain a built client index.html');
    }
    app.use(express.static(root, { index: false }));
    app.get('*', (_req, res) => {
      res.setHeader('Cache-Control', 'no-store');
      res.sendFile(path.join(root, 'index.html'));
    });
  }

  // Central error handler: malformed JSON -> 422 SCHEMA_MISMATCH; ApiError -> mapped status.
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  app.use((err: any, req: Request, res: Response, _next: NextFunction) => {
    const requestId = req.ctx?.requestId ?? 'unknown';
    if (err instanceof ApiError) {
      res.status(err.status).json(errorBody(err, requestId));
      return;
    }
    if (err?.type === 'entity.parse.failed' || err instanceof SyntaxError) {
      const apiErr = new ApiError('VALIDATION_ERROR', 'Некорректный JSON в теле запроса.', {
        issues: [{ path: 'body', issue: 'malformed JSON' }],
      });
      res.status(422).json(errorBody(apiErr, requestId));
      return;
    }
    // Body exceeding the express.json() limit throws err.type ===
    // 'entity.too.large' (a PayloadTooLargeError from the `raw-body`
    // package), which previously fell through to the generic branch below
    // and returned 503 TEMPORARILY_UNAVAILABLE -- wrong error code for a
    // client mistake, and not the contract-mandated 422. Mapped explicitly.
    if (err?.type === 'entity.too.large' || err?.status === 413) {
      const apiErr = new ApiError('VALIDATION_ERROR', 'Тело запроса превышает допустимый размер (32KiB).', {
        issues: [{ path: 'body', issue: 'payload too large, max 32KiB' }],
      });
      res.status(422).json(errorBody(apiErr, requestId));
      return;
    }
    // eslint-disable-next-line no-console
    if(['/api/v1/report-batches','/api/v1/report-facts','/api/v1/auth','/api/v1/access'].some(p=>req.path.startsWith(p))) {
      // DB/parser failures can contain private workbook values in diagnostics.
      console.error('Sensitive request failed', requestId);
    } else console.error('Unhandled error', err);
    const apiErr = new ApiError('TEMPORARILY_UNAVAILABLE', 'Сервис временно недоступен.', { retry_after_seconds: 5 });
    res.status(503).json(errorBody(apiErr, requestId));
  });

  return app;
}
