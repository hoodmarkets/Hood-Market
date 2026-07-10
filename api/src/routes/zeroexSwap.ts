import type { Express, Request, Response } from 'express';
import { config } from '../config.js';
import { logger } from '../logger.js';
import { webDeployCorsHeadersSwap0x } from '../lib/webDeployCors.js';

const ZEROX_BASE = 'https://api.0x.org';

/** Only Robinhood Chain mainnet — avoids using the launcher as an open cross-chain proxy. */
const ALLOWED_CHAIN_IDS = new Set(['4663']);

const PRICE_PARAMS = new Set([
  'chainId',
  'buyToken',
  'sellToken',
  'sellAmount',
  'buyAmount',
  'taker',
  'txOrigin',
  'recipient',
  'swapFeeRecipient',
  'swapFeeBps',
  'swapFeeToken',
  'tradeSurplusRecipient',
  'tradeSurplusMaxBps',
  'gasPrice',
  'slippageBps',
  'excludedSources',
  'sellEntireBalance',
  'wrapUnwrapMode',
]);

function buildForwardedQuery(req: Request): URLSearchParams | null {
  const out = new URLSearchParams();
  const q = req.query;
  for (const key of PRICE_PARAMS) {
    const v = q[key];
    if (v === undefined) continue;
    if (typeof v === 'string') {
      out.set(key, v);
    } else if (Array.isArray(v) && typeof v[0] === 'string') {
      out.set(key, v[0]);
    }
  }
  const chainId = out.get('chainId');
  if (!chainId || !ALLOWED_CHAIN_IDS.has(chainId)) {
    return null;
  }
  return out;
}

async function proxy0x(
  path: '/swap/allowance-holder/price' | '/swap/allowance-holder/quote',
  req: Request,
  res: Response,
): Promise<void> {
  const origin = req.headers.origin;
  const cors = webDeployCorsHeadersSwap0x(typeof origin === 'string' ? origin : undefined);
  Object.entries(cors).forEach(([k, v]) => res.setHeader(k, v));

  if (!config.zeroX.enabled) {
    res.status(503).json({ error: '0x Swap API is not configured (set ZEROX_API_KEY on the server).' });
    return;
  }

  const qs = buildForwardedQuery(req);
  if (!qs) {
    res.status(400).json({ error: 'Invalid or missing chainId (only Robinhood 4663 is allowed).' });
    return;
  }

  const url = `${ZEROX_BASE}${path}?${qs.toString()}`;
  try {
    const upstream = await fetch(url, {
      headers: {
        '0x-api-key': config.zeroX.apiKey,
        '0x-version': 'v2',
      },
    });
    const text = await upstream.text();
    res.status(upstream.status);
    const ct = upstream.headers.get('content-type');
    if (ct?.includes('application/json')) {
      res.type('application/json').send(text);
    } else {
      res.type('text/plain').send(text);
    }
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : '0x proxy failed';
    logger.warn('0x proxy error:', msg);
    res.status(502).json({ error: msg });
  }
}

export function registerZeroExSwapRoutes(app: Express): void {
  app.options('/api/swap/0x/price', (req, res) => {
    const origin = req.headers.origin;
    const cors = webDeployCorsHeadersSwap0x(typeof origin === 'string' ? origin : undefined);
    res.status(204);
    Object.entries(cors).forEach(([k, v]) => res.setHeader(k, v));
    res.end();
  });
  app.options('/api/swap/0x/quote', (req, res) => {
    const origin = req.headers.origin;
    const cors = webDeployCorsHeadersSwap0x(typeof origin === 'string' ? origin : undefined);
    res.status(204);
    Object.entries(cors).forEach(([k, v]) => res.setHeader(k, v));
    res.end();
  });

  app.get('/api/swap/0x/price', (req, res) => {
    void proxy0x('/swap/allowance-holder/price', req, res);
  });
  app.get('/api/swap/0x/quote', (req, res) => {
    void proxy0x('/swap/allowance-holder/quote', req, res);
  });
}
