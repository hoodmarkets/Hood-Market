import type { Express, Request, Response } from 'express';
import { webDeployCorsHeaders } from '../lib/webDeployCors.js';

/**
 * Pull accrued LP / pool fees into the fee locker — disabled; users sign from their wallet.
 */
export function registerMyDeploymentsCollectPoolRoutes(app: Express): void {
  app.options('/api/my-deployments/collect-pool-fees', (req, res) => {
    const h = webDeployCorsHeaders(req.headers.origin);
    for (const [k, v] of Object.entries(h)) res.setHeader(k, v);
    res.status(204).end();
  });

  app.post('/api/my-deployments/collect-pool-fees', async (req: Request, res: Response) => {
    const h = webDeployCorsHeaders(req.headers.origin);
    for (const [k, v] of Object.entries(h)) res.setHeader(k, v);
    res.status(410).json({
      error: 'Server-side collect is disabled. Connect a wallet on hood.markets and sign the transaction.',
    });
  });
}
