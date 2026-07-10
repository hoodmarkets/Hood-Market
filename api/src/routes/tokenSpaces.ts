import type { Express, Request, Response } from 'express';
import { getAddress } from 'viem';
import { getDeploymentByTokenAddress } from '../lib/deploymentCatalog.js';
import { insertTokenSpacePost, listTokenSpacePosts } from '../lib/hoodSocialDb.js';
import { readTokenHolderStatus } from '../lib/robinhoodHolder.js';
import { fetchPrivyUserRecordById } from '../lib/privy.js';
import { verifyWebSessionBearer } from '../lib/webSessionAuth.js';
import { privyUserOwnsWallet } from '../lib/privyWallets.js';
import { webDeployCorsHeadersRead } from '../lib/webDeployCors.js';
import { config } from '../config.js';

function setCors(req: Request, res: Response): void {
  const h = webDeployCorsHeadersRead(req.headers.origin);
  for (const [k, v] of Object.entries(h)) res.setHeader(k, v);
}

function parseTokenParam(raw: string): string | null {
  const t = raw.trim();
  if (!/^0x[a-fA-F0-9]{40}$/.test(t)) return null;
  try {
    return getAddress(t);
  } catch {
    return null;
  }
}

export function registerTokenSpaceRoutes(app: Express): void {
  app.options('/api/token-spaces/:token/posts', (req, res) => {
    setCors(req, res);
    res.status(204).end();
  });

  app.options('/api/token-spaces/:token/holder', (req, res) => {
    setCors(req, res);
    res.status(204).end();
  });

  app.get('/api/token-spaces/:token/posts', async (req: Request, res: Response) => {
    setCors(req, res);
    const token = parseTokenParam(typeof req.params.token === 'string' ? req.params.token : '');
    if (!token) {
      res.status(400).json({ error: 'Invalid token address.' });
      return;
    }

    try {
      const catalog = await getDeploymentByTokenAddress(token);
      if (!catalog) {
        res.status(404).json({ error: 'Token not found in hood.markets catalog.' });
        return;
      }
      const rawLimit = req.query.limit;
      const limit = typeof rawLimit === 'string' ? Number.parseInt(rawLimit, 10) : 50;
      const posts = await listTokenSpacePosts(token, Number.isFinite(limit) ? limit : 50, 0);
      res.json({ tokenAddress: token, posts });
    } catch {
      res.status(500).json({ error: 'Failed to load posts.' });
    }
  });

  app.get('/api/token-spaces/:token/holder', async (req: Request, res: Response) => {
    setCors(req, res);
    const token = parseTokenParam(typeof req.params.token === 'string' ? req.params.token : '');
    const wallet =
      typeof req.query.wallet === 'string' ? req.query.wallet.trim() : '';
    if (!token || !/^0x[a-fA-F0-9]{40}$/.test(wallet)) {
      res.status(400).json({ error: 'token and wallet query params required.' });
      return;
    }

    try {
      const status = await readTokenHolderStatus(token, wallet);
      res.json({
        tokenAddress: token,
        walletAddress: getAddress(wallet),
        holds: status.holds,
        balance: status.balance,
      });
    } catch {
      res.status(500).json({ error: 'Failed to check holder status.' });
    }
  });

  app.post('/api/token-spaces/:token/posts', async (req: Request, res: Response) => {
    setCors(req, res);
    const token = parseTokenParam(typeof req.params.token === 'string' ? req.params.token : '');
    if (!token) {
      res.status(400).json({ error: 'Invalid token address.' });
      return;
    }

    if (!config.privy.enabled) {
      res.status(503).json({ error: 'Privy is not configured on the server.' });
      return;
    }

    const body = typeof req.body?.body === 'string' ? req.body.body.trim() : '';
    const walletAddress =
      typeof req.body?.walletAddress === 'string' ? req.body.walletAddress.trim() : '';

    if (!body) {
      res.status(400).json({ error: 'Post body is required.' });
      return;
    }
    if (!/^0x[a-fA-F0-9]{40}$/.test(walletAddress)) {
      res.status(400).json({ error: 'walletAddress must be a valid 0x address.' });
      return;
    }

    try {
      const catalog = await getDeploymentByTokenAddress(token);
      if (!catalog) {
        res.status(404).json({ error: 'Token not found in hood.markets catalog.' });
        return;
      }

      const session = await verifyWebSessionBearer(req.headers.authorization);
      if (session.kind === 'wallet') {
        if (session.walletAddress.toLowerCase() !== walletAddress.toLowerCase()) {
          res.status(403).json({ error: 'Wallet does not match your signed-in session.' });
          return;
        }
      } else {
        const userRecord = await fetchPrivyUserRecordById(session.userId);
        if (!privyUserOwnsWallet(userRecord, walletAddress)) {
          res.status(403).json({ error: 'Wallet is not linked to your signed-in account.' });
          return;
        }
      }

      const holder = await readTokenHolderStatus(token, walletAddress);
      if (!holder.holds) {
        res.status(403).json({ error: 'Only token holders can post in this space.' });
        return;
      }

      const id = await insertTokenSpacePost(token, walletAddress, body);
      res.json({
        ok: true,
        post: {
          id,
          tokenAddress: token,
          walletAddress: getAddress(walletAddress),
          body: body.slice(0, 2000),
          createdAt: new Date().toISOString(),
        },
      });
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : 'Post failed';
      const status = /authorization|bearer|privy/i.test(msg)
        ? 401
        : /holder|wallet is not|empty/i.test(msg)
          ? 403
          : /invalid|required/i.test(msg)
            ? 400
            : 500;
      res.status(status).json({ error: msg });
    }
  });
}
