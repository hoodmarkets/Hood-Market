import type { Express, Request, Response } from 'express';
import { buildFractionMetadataJson } from '../lib/fractionMetadata.js';
import { webDeployCorsHeadersRead } from '../lib/webDeployCors.js';

export function registerFractionMetadataRoutes(app: Express): void {
  app.options('/api/fraction-metadata/:address.json', (req, res) => {
    const h = webDeployCorsHeadersRead(req.headers.origin);
    for (const [k, v] of Object.entries(h)) res.setHeader(k, v);
    res.status(204).end();
  });

  app.get('/api/fraction-metadata/legacy.json', async (_req: Request, res: Response) => {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Cache-Control', 'public, max-age=300');
    res.type('json');
    const body = await buildFractionMetadataJson('', { legacyGeneric: true });
    res.json(body);
  });

  app.get('/api/fraction-metadata/:address.json', async (req: Request, res: Response) => {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Cache-Control', 'public, max-age=300');
    res.type('json');

    const raw = typeof req.params.address === 'string' ? req.params.address.trim() : '';
    if (!/^0x[a-fA-F0-9]{40}$/.test(raw)) {
      res.status(400).json({ error: 'Invalid address.' });
      return;
    }

    try {
      const body = await buildFractionMetadataJson(raw);
      res.json(body);
    } catch {
      res.status(500).json({ error: 'Failed to build fraction metadata.' });
    }
  });
}
