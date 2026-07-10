import type { Express, Request, Response } from 'express';
import { webDeployCorsHeaders } from '../lib/webDeployCors.js';

/**
 * Authenticated claim route — disabled; users sign collect/claim from their wallet.
 */
export function registerMyDeploymentsClaimRoutes(app: Express): void {
  app.options('/api/my-deployments/claim', (req, res) => {
    const h = webDeployCorsHeaders(req.headers.origin);
    for (const [k, v] of Object.entries(h)) res.setHeader(k, v);
    res.status(204).end();
  });

  app.post('/api/my-deployments/claim', async (req: Request, res: Response) => {
    const h = webDeployCorsHeaders(req.headers.origin);
    for (const [k, v] of Object.entries(h)) res.setHeader(k, v);
    res.status(410).json({
      error: 'Server-side claim is disabled. Connect a wallet on hood.markets and sign the transaction.',
    });
  });
}
