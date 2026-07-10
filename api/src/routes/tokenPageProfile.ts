import type { Express, Request, Response } from 'express';
import { getDeploymentByTokenAddress } from '../lib/deploymentCatalog.js';
import {
  loadTokenPageProfileView,
  updateTokenPageProfileForWallet,
  verifyTokenPageForWallet,
} from '../lib/tokenPageProfile.js';
import { verifyWebSessionBearer } from '../lib/webSessionAuth.js';
import { webDeployCorsHeadersRead } from '../lib/webDeployCors.js';

function parseToken(raw: string): string | null {
  const t = raw.trim();
  if (!/^0x[a-fA-F0-9]{40}$/.test(t)) return null;
  return t;
}

function setCorsRead(req: Request, res: Response): void {
  const h = webDeployCorsHeadersRead(req.headers.origin);
  for (const [k, v] of Object.entries(h)) res.setHeader(k, v);
}

function profileBodyFromRequest(body: unknown) {
  const b = body && typeof body === 'object' ? (body as Record<string, unknown>) : {};
  return {
    description: typeof b.description === 'string' ? b.description : undefined,
    websiteUrl: typeof b.websiteUrl === 'string' ? b.websiteUrl : undefined,
    xUrl: typeof b.xUrl === 'string' ? b.xUrl : undefined,
    telegramUrl: typeof b.telegramUrl === 'string' ? b.telegramUrl : undefined,
    discordUrl: typeof b.discordUrl === 'string' ? b.discordUrl : undefined,
    githubUrl: typeof b.githubUrl === 'string' ? b.githubUrl : undefined,
    customLinks: Array.isArray(b.customLinks) ? b.customLinks : undefined,
    imageUrl: typeof b.imageUrl === 'string' ? b.imageUrl : undefined,
    bannerUrl: typeof b.bannerUrl === 'string' ? b.bannerUrl : undefined,
    useDexIcon: typeof b.useDexIcon === 'boolean' ? b.useDexIcon : undefined,
    useDexBanner: typeof b.useDexBanner === 'boolean' ? b.useDexBanner : undefined,
    useDexLinks: typeof b.useDexLinks === 'boolean' ? b.useDexLinks : undefined,
    importDexBranding: b.importDexBranding === true,
  };
}

export function registerTokenPageProfileRoutes(app: Express): void {
  app.options('/api/tokens/:token/profile', (req, res) => {
    setCorsRead(req, res);
    res.status(204).end();
  });

  app.get('/api/tokens/:token/profile', async (req: Request, res: Response) => {
    setCorsRead(req, res);
    const token = parseToken(typeof req.params.token === 'string' ? req.params.token : '');
    if (!token) {
      res.status(400).json({ error: 'Invalid token address.' });
      return;
    }

    try {
      const row = await getDeploymentByTokenAddress(token);
      if (!row) {
        res.status(404).json({ error: 'Token not found in hood.markets catalog.' });
        return;
      }
      const wallet =
        typeof req.query.wallet === 'string' ? req.query.wallet.trim() : '';
      const profile = await loadTokenPageProfileView(row, wallet);
      res.json({ ok: true, profile });
    } catch {
      res.status(500).json({ error: 'Failed to load token profile.' });
    }
  });

  app.patch('/api/tokens/:token/profile', async (req: Request, res: Response) => {
    setCorsRead(req, res);
    const token = parseToken(typeof req.params.token === 'string' ? req.params.token : '');
    if (!token) {
      res.status(400).json({ error: 'Invalid token address.' });
      return;
    }

    const walletAddress =
      typeof req.body?.walletAddress === 'string' ? req.body.walletAddress.trim() : '';
    if (!/^0x[a-fA-F0-9]{40}$/.test(walletAddress)) {
      res.status(400).json({ error: 'walletAddress must be a valid 0x address.' });
      return;
    }

    try {
      const session = await verifyWebSessionBearer(req.headers.authorization);
      if (session.kind !== 'wallet' || session.walletAddress.toLowerCase() !== walletAddress.toLowerCase()) {
        res.status(403).json({ error: 'Sign in with the admin wallet to edit this token page.' });
        return;
      }

      const row = await getDeploymentByTokenAddress(token);
      if (!row) {
        res.status(404).json({ error: 'Token not found in hood.markets catalog.' });
        return;
      }

      const result = await updateTokenPageProfileForWallet(row, {
        walletAddress,
        ...profileBodyFromRequest(req.body),
      });
      if (!result.ok) {
        res.status(result.status).json({ error: result.error });
        return;
      }
      res.json({ ok: true, profile: result.profile });
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : 'Profile update failed';
      const status = /authorization|bearer/i.test(msg) ? 401 : 500;
      res.status(status).json({ error: msg });
    }
  });

  app.options('/api/tokens/:token/verify', (req, res) => {
    setCorsRead(req, res);
    res.status(204).end();
  });

  app.post('/api/tokens/:token/verify', async (req: Request, res: Response) => {
    setCorsRead(req, res);
    const token = parseToken(typeof req.params.token === 'string' ? req.params.token : '');
    if (!token) {
      res.status(400).json({ error: 'Invalid token address.' });
      return;
    }

    const walletAddress =
      typeof req.body?.walletAddress === 'string' ? req.body.walletAddress.trim() : '';
    if (!/^0x[a-fA-F0-9]{40}$/.test(walletAddress)) {
      res.status(400).json({ error: 'walletAddress must be a valid 0x address.' });
      return;
    }

    try {
      const session = await verifyWebSessionBearer(req.headers.authorization);
      if (session.kind !== 'wallet' || session.walletAddress.toLowerCase() !== walletAddress.toLowerCase()) {
        res.status(403).json({ error: 'Sign in with the fee recipient wallet to verify.' });
        return;
      }

      const row = await getDeploymentByTokenAddress(token);
      if (!row) {
        res.status(404).json({ error: 'Token not found in hood.markets catalog.' });
        return;
      }

      const result = await verifyTokenPageForWallet(row, walletAddress);
      if (!result.ok) {
        res.status(result.status).json({ error: result.error });
        return;
      }
      res.json({ ok: true, profile: result.profile, replyHint: result.replyHint });
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : 'Verification failed';
      const status = /authorization|bearer/i.test(msg) ? 401 : 500;
      res.status(status).json({ error: msg });
    }
  });
}
