import type { Express, Request, Response } from 'express';
import { logger } from '../logger.js';
import type { NeynarClient } from '../neynar.js';
import { resolveDeploySourceFromUrl } from '../lib/resolveDeploySource.js';
import { webDeployCorsHeaders } from '../lib/webDeployCors.js';

export function registerResolveSourceRoutes(app: Express, neynar: NeynarClient): void {
  app.options('/api/resolve-source', (req, res) => {
    const h = webDeployCorsHeaders(req.headers.origin);
    for (const [k, v] of Object.entries(h)) res.setHeader(k, v);
    res.status(204).end();
  });

  app.post('/api/resolve-source', async (req: Request, res: Response) => {
    const h = webDeployCorsHeaders(req.headers.origin);
    for (const [k, v] of Object.entries(h)) res.setHeader(k, v);

    try {
      const url = typeof req.body?.url === 'string' ? req.body.url.trim() : '';
      if (!url || url.length > 2048) {
        res.status(400).json({ error: 'Provide a valid url (max 2048 chars).' });
        return;
      }

      const result = await resolveDeploySourceFromUrl(url, neynar);
      if (!result) {
        res.status(404).json({ error: 'Unsupported or unrecognized URL.' });
        return;
      }
      res.json(result);
    } catch (e: any) {
      const msg = e?.message || 'Failed to resolve URL.';
      logger.warn('resolve-source failed', { error: msg });
      res.status(400).json({ error: msg });
    }
  });
}
