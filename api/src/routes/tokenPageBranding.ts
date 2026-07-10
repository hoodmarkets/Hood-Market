import type { Express, Request, Response } from 'express';
import { getDeploymentByTokenAddress } from '../lib/deploymentCatalog.js';
import { importDexBrandingForToken, loadDexBrandingView } from '../lib/importDexBranding.js';
import { webDeployCorsHeaders, webDeployCorsHeadersRead } from '../lib/webDeployCors.js';
import { verifyWebSessionBearer } from '../lib/webSessionAuth.js';

function parseToken(raw: string): string | null {
  const t = raw.trim();
  if (!/^0x[a-fA-F0-9]{40}$/.test(t)) return null;
  return t;
}

function setCorsRead(req: Request, res: Response): void {
  const h = webDeployCorsHeadersRead(req.headers.origin);
  for (const [k, v] of Object.entries(h)) res.setHeader(k, v);
}

function setCorsWrite(req: Request, res: Response): void {
  const h = webDeployCorsHeaders(req.headers.origin);
  for (const [k, v] of Object.entries(h)) res.setHeader(k, v);
}

export function registerTokenPageBrandingRoutes(app: Express): void {
  app.options('/api/tokens/:token/dex-branding', (req, res) => {
    setCorsRead(req, res);
    res.status(204).end();
  });

  app.get('/api/tokens/:token/dex-branding', async (req: Request, res: Response) => {
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
      res.json(await loadDexBrandingView(row, wallet));
    } catch {
      res.status(500).json({ error: 'Failed to load Dex branding.' });
    }
  });

  app.options('/api/tokens/:token/import-dex-branding', (req, res) => {
    setCorsWrite(req, res);
    res.status(204).end();
  });

  app.post('/api/tokens/:token/import-dex-branding', async (req: Request, res: Response) => {
    setCorsWrite(req, res);
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
        res.status(403).json({ error: 'Sign in with the admin wallet to import Dex branding.' });
        return;
      }

      const result = await importDexBrandingForToken({ tokenAddress: token, walletAddress });
      if (!result.ok) {
        res.status(result.status).json({
          error: result.error,
          ...(result.enhancedInfoStatus !== undefined
            ? { enhancedInfoStatus: result.enhancedInfoStatus }
            : {}),
          ...(result.adminWallet ? { adminWallet: result.adminWallet, adminRole: result.adminRole } : {}),
        });
        return;
      }

      res.json({
        ok: true,
        imported: result.imported,
        token: result.token,
        dex: result.dex,
      });
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : 'Import failed';
      const status = /authorization|bearer/i.test(msg) ? 401 : 500;
      res.status(status).json({ error: msg });
    }
  });
}
