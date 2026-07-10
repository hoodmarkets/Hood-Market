import type { Express, Request, Response } from 'express';
import { getAddress } from 'viem';
import { fetchGeckoTokenTrades } from '../lib/geckoTerminalTrades.js';
import { fetchBlockscoutTokenTrades } from '../lib/blockscoutTokenTrades.js';
import { webDeployCorsHeadersRead } from '../lib/webDeployCors.js';

function corsRead(req: Request, res: Response): void {
  const h = webDeployCorsHeadersRead(req.headers.origin);
  for (const [k, v] of Object.entries(h)) res.setHeader(k, v);
}

function parseTokenParam(raw: string): `0x${string}` | null {
  if (!/^0x[a-fA-F0-9]{40}$/.test(raw.trim())) return null;
  try {
    return getAddress(raw.trim());
  } catch {
    return null;
  }
}

export function registerTokenTradesRoutes(app: Express): void {
  app.options('/api/tokens/:tokenAddress/trades', (req, res) => {
    corsRead(req, res);
    res.status(204).end();
  });

  app.get('/api/tokens/:tokenAddress/trades', async (req: Request, res: Response) => {
    corsRead(req, res);

    const tokenAddress = parseTokenParam(
      typeof req.params.tokenAddress === 'string' ? req.params.tokenAddress : '',
    );
    if (!tokenAddress) {
      res.status(400).json({ error: 'tokenAddress must be a valid 0x contract address.' });
      return;
    }

    try {
      const [blockscoutTrades, geckoTrades] = await Promise.all([
        fetchBlockscoutTokenTrades(tokenAddress),
        fetchGeckoTokenTrades(tokenAddress),
      ]);
      const trades = blockscoutTrades.length > 0 ? blockscoutTrades : geckoTrades;
      res.json({ tokenAddress, trades, source: blockscoutTrades.length > 0 ? 'blockscout' : 'gecko' });
    } catch (err: unknown) {
      res.status(502).json({
        error: err instanceof Error ? err.message : 'Failed to load trades',
        trades: [],
      });
    }
  });
}
