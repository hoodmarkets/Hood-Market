import type { Express, Request, Response } from 'express';
import { getAddress } from 'viem';
import { config } from '../config.js';
import { verifyPrivyBearerToken } from '../lib/privyAccessToken.js';
import { verifyWebSessionBearer } from '../lib/webSessionAuth.js';
import {
  getDeploymentByDeployerAndTokenAddress,
  listDeploymentCatalogForUser,
} from '../lib/deploymentCatalog.js';
import { webDeployCorsHeadersRead } from '../lib/webDeployCors.js';

/**
 * Authenticated list of deployments for the current Privy user (matches `deployer_id` in catalog).
 */
export function registerMyDeploymentsRoutes(app: Express): void {
  app.options('/api/my-deployments', (req, res) => {
    const h = webDeployCorsHeadersRead(req.headers.origin);
    for (const [k, v] of Object.entries(h)) res.setHeader(k, v);
    res.status(204).end();
  });

  app.get('/api/my-deployments', async (req: Request, res: Response) => {
    const h = webDeployCorsHeadersRead(req.headers.origin);
    for (const [k, v] of Object.entries(h)) res.setHeader(k, v);

    if (!config.webWallet.enabled && !config.privy.enabled) {
      res.status(503).json({ error: 'Web login is not configured on the server.' });
      return;
    }

    try {
      const session = await verifyWebSessionBearer(req.headers.authorization);
      const userId = session.userId;
      const rawLimit = req.query.limit;
      const rawOffset = req.query.offset;
      const limit =
        typeof rawLimit === 'string' ? Number.parseInt(rawLimit, 10) : 50;
      const offset =
        typeof rawOffset === 'string' ? Number.parseInt(rawOffset, 10) : 0;

      const rawEnsure =
        typeof req.query.tokenAddress === 'string'
          ? req.query.tokenAddress
          : typeof req.query.token === 'string'
            ? req.query.token
            : '';

      // Optional wallet address sent by the frontend — used to surface tokens
      // deployed FOR this user (fee recipient) even when someone else was the deployer.
      const rawWallet =
        typeof req.query.walletAddress === 'string'
          ? req.query.walletAddress.trim()
          : session.kind === 'wallet'
            ? session.walletAddress
            : '';
      let resolvedWallet = '';
      if (/^0x[0-9a-fA-F]{40}$/.test(rawWallet)) {
        try { resolvedWallet = getAddress(rawWallet).toLowerCase(); } catch { /* ignore */ }
      }

      let deployments = await listDeploymentCatalogForUser(
        userId,
        resolvedWallet,
        Number.isFinite(limit) ? limit : 50,
        Number.isFinite(offset) ? offset : 0,
      );

      const trimmed = rawEnsure.trim();
      if (/^0x[a-fA-F0-9]{40}$/.test(trimmed)) {
        const ensured = await getDeploymentByDeployerAndTokenAddress(userId, trimmed);
        if (ensured) {
          const t = ensured.tokenAddress.toLowerCase();
          const has = deployments.some((d) => d.tokenAddress.toLowerCase() === t);
          if (!has) {
            deployments = [{ ...ensured, deployedByViewer: true }, ...deployments];
          }
        }
      }

      res.json({ deployments });
    } catch (e: any) {
      const msg = e?.message || 'Unauthorized';
      const status = /authorization|bearer|access token|privy is not configured/i.test(msg)
        ? 401
        : 500;
      res.status(status).json({ error: msg });
    }
  });
}
