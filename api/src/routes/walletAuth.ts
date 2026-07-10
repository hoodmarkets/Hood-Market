import type { Express, Request, Response } from 'express';
import { getAddress, verifyMessage } from 'viem';
import { config } from '../config.js';
import { webDeployCorsHeaders, webDeployCorsHeadersRead } from '../lib/webDeployCors.js';
import { createWebWalletChallenge, consumeWebWalletChallenge } from '../lib/webWalletChallenge.js';
import { issueWebWalletSession } from '../lib/webWalletSession.js';

const BANKR_API = 'https://api.bankr.bot';

function readBankrApiKey(req: Request): string | null {
  const h = req.headers['x-bankr-api-key'] ?? req.headers['X-Bankr-Api-Key'];
  const fromHeader = typeof h === 'string' ? h.trim() : Array.isArray(h) ? h[0]?.trim() : '';
  if (fromHeader) return fromHeader;
  const body = req.body as { apiKey?: string };
  if (typeof body.apiKey === 'string' && body.apiKey.trim()) return body.apiKey.trim();
  return null;
}

async function bankrFetch(path: string, apiKey: string, init: RequestInit = {}): Promise<globalThis.Response> {
  const headers = new Headers(init.headers);
  headers.set('X-API-Key', apiKey);
  if (!headers.has('Content-Type') && init.body) {
    headers.set('Content-Type', 'application/json');
  }
  return fetch(`${BANKR_API}${path}`, { ...init, headers });
}

function extractEvmAddress(payload: unknown): string | null {
  const p = payload as Record<string, unknown>;

  // Prefer wallets[].chain === 'evm' (current /wallet/me format)
  if (Array.isArray(p.wallets)) {
    for (const w of p.wallets) {
      if (w && typeof w === 'object') {
        const wo = w as Record<string, unknown>;
        if (wo.chain === 'evm' && typeof wo.address === 'string') {
          try { return getAddress(wo.address); } catch { /* skip */ }
        }
      }
    }
    // Fallback: any object in wallets with a 0x address
    for (const w of p.wallets) {
      if (w && typeof w === 'object') {
        const wa = (w as Record<string, unknown>).address;
        if (typeof wa === 'string' && /^0x[a-fA-F0-9]{40}$/.test(wa)) {
          try { return getAddress(wa); } catch { /* skip */ }
        }
      }
    }
  }

  // Legacy flat response shapes
  for (const c of [p.address, p.walletAddress, (p.wallet as Record<string, unknown> | undefined)?.address]) {
    if (typeof c === 'string' && /^0x[a-fA-F0-9]{40}$/.test(c)) {
      try { return getAddress(c); } catch { /* skip */ }
    }
  }
  return null;
}

export function registerWalletAuthRoutes(app: Express): void {
  app.options('/api/wallet-auth/challenge', (req, res) => {
    const h = webDeployCorsHeadersRead(req.headers.origin);
    for (const [k, v] of Object.entries(h)) res.setHeader(k, v);
    res.status(204).end();
  });

  app.get('/api/wallet-auth/challenge', (req: Request, res: Response) => {
    const h = webDeployCorsHeadersRead(req.headers.origin);
    for (const [k, v] of Object.entries(h)) res.setHeader(k, v);

    if (!config.webWallet.enabled) {
      res.status(503).json({ error: 'Wallet login is not configured on the server.' });
      return;
    }

    const raw =
      typeof req.query.address === 'string'
        ? req.query.address
        : typeof req.query.walletAddress === 'string'
          ? req.query.walletAddress
          : '';
    try {
      const out = createWebWalletChallenge(raw);
      res.json(out);
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : String(e);
      res.status(400).json({ error: msg });
    }
  });

  app.options('/api/wallet-auth/verify', (req, res) => {
    const h = webDeployCorsHeaders(req.headers.origin);
    for (const [k, v] of Object.entries(h)) res.setHeader(k, v);
    res.status(204).end();
  });

  app.post('/api/wallet-auth/verify', async (req: Request, res: Response) => {
    const h = webDeployCorsHeaders(req.headers.origin);
    for (const [k, v] of Object.entries(h)) res.setHeader(k, v);

    if (!config.webWallet.enabled) {
      res.status(503).json({ error: 'Wallet login is not configured on the server.' });
      return;
    }

    const body = req.body as {
      walletAddress?: string;
      message?: string;
      signature?: string;
      walletKind?: string;
    };

    const walletAddress = typeof body.walletAddress === 'string' ? body.walletAddress.trim() : '';
    const message = typeof body.message === 'string' ? body.message : '';
    const signature = typeof body.signature === 'string' ? body.signature.trim() : '';

    if (!walletAddress || !message || !signature) {
      res.status(400).json({ error: 'walletAddress, message, and signature are required.' });
      return;
    }

    try {
      const { walletAddress: addr } = consumeWebWalletChallenge(walletAddress, message);
      const ok = await verifyMessage({
        address: addr,
        message,
        signature: signature as `0x${string}`,
      });
      if (!ok) {
        res.status(401).json({ error: 'Signature does not match wallet address.' });
        return;
      }

      const session = await issueWebWalletSession({
        walletAddress: addr,
        walletKind: body.walletKind,
      });

      res.json({
        ok: true,
        token: session.token,
        expiresAt: session.expiresAt,
        userId: session.userId,
        walletAddress: addr,
        walletKind: body.walletKind?.trim() || 'injected',
      });
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : String(e);
      const status = /challenge|signature|wallet/i.test(msg) ? 401 : 400;
      res.status(status).json({ error: msg });
    }
  });

  /** Proxy Bankr read — API key sent per request, not stored server-side. */
  app.options('/api/bankr/wallet/me', (req, res) => {
    const h = webDeployCorsHeadersRead(req.headers.origin);
    for (const [k, v] of Object.entries(h)) res.setHeader(k, v);
    res.status(204).end();
  });

  app.post('/api/bankr/wallet/me', async (req: Request, res: Response) => {
    const h = webDeployCorsHeadersRead(req.headers.origin);
    for (const [k, v] of Object.entries(h)) res.setHeader(k, v);

    const apiKey = readBankrApiKey(req);
    if (!apiKey) {
      res.status(400).json({ error: 'Bankr API key required (X-Bankr-Api-Key header or apiKey in body).' });
      return;
    }

    try {
      const r = await bankrFetch('/wallet/me', apiKey);
      const data = await r.json().catch(() => ({}));
      if (!r.ok) {
        res.status(r.status).json({
          error: (data as { error?: string }).error || 'Could not load Bankr wallet.',
        });
        return;
      }
      const address = extractEvmAddress(data);
      if (!address) {
        res.status(502).json({ error: 'Bankr response did not include an EVM wallet address.' });
        return;
      }
      res.json({ ok: true, address, raw: data });
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : String(e);
      res.status(502).json({ error: `Bankr API error: ${msg}` });
    }
  });

  /** Proxy Bankr personal_sign for login — key is forwarded, never persisted. */
  app.options('/api/bankr/wallet/sign', (req, res) => {
    const h = webDeployCorsHeaders(req.headers.origin);
    for (const [k, v] of Object.entries(h)) res.setHeader(k, v);
    res.status(204).end();
  });

  app.post('/api/bankr/wallet/sign', async (req: Request, res: Response) => {
    const h = webDeployCorsHeaders(req.headers.origin);
    for (const [k, v] of Object.entries(h)) res.setHeader(k, v);

    const apiKey = readBankrApiKey(req);
    if (!apiKey) {
      res.status(400).json({ error: 'Bankr API key required (X-Bankr-Api-Key header or apiKey in body).' });
      return;
    }

    const body = req.body as { message?: string };
    const message = typeof body.message === 'string' ? body.message : '';
    if (!message.trim()) {
      res.status(400).json({ error: 'message is required.' });
      return;
    }

    try {
      const r = await bankrFetch('/wallet/sign', apiKey, {
        method: 'POST',
        body: JSON.stringify({ signatureType: 'personal_sign', message }),
      });
      const data = (await r.json().catch(() => ({}))) as Record<string, unknown>;
      if (!r.ok) {
        res.status(r.status).json({
          error: (data.error as string) || 'Bankr could not sign the login message.',
        });
        return;
      }
      const signature = typeof data.signature === 'string' ? data.signature : '';
      if (!signature) {
        res.status(502).json({ error: 'Bankr sign response missing signature.' });
        return;
      }
      res.json({ ok: true, signature });
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : String(e);
      res.status(502).json({ error: `Bankr API error: ${msg}` });
    }
  });
}
