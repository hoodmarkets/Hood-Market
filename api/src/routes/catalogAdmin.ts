import type { Express, Request, Response } from 'express';
import { getAddress } from 'viem';
import { config } from '../config.js';
import { deleteDeploymentCatalogByTokenAddresses, updateDeploymentCatalogLaunchSource } from '../lib/deploymentCatalog.js';
import { logger } from '../logger.js';
import { webDeployCorsHeaders } from '../lib/webDeployCors.js';

function catalogAdminSecret(): string {
  return (
    process.env.CATALOG_ADMIN_SECRET?.trim() ||
    config.agentCaptcha.jwtSecret?.trim() ||
    ''
  );
}

function isAuthorized(req: Request): boolean {
  const secret = catalogAdminSecret();
  if (!secret) return false;
  const header = req.headers['x-catalog-admin-secret'];
  const provided = typeof header === 'string' ? header.trim() : '';
  return provided.length > 0 && provided === secret;
}

/**
 * Ops routes — delete mistaken / test rows from deployment_catalog (explore, agent API).
 * Auth: header `X-Catalog-Admin-Secret` matching `CATALOG_ADMIN_SECRET` or `AGENT_CAPTCHA_JWT_SECRET`.
 */
export function registerCatalogAdminRoutes(app: Express): void {
  const secret = catalogAdminSecret();
  if (!secret) {
    logger.warn('Catalog admin routes disabled — set CATALOG_ADMIN_SECRET or AGENT_CAPTCHA_JWT_SECRET');
    return;
  }

  app.options('/api/admin/catalog/delete', (req, res) => {
    const h = webDeployCorsHeaders(req.headers.origin);
    for (const [k, v] of Object.entries(h)) res.setHeader(k, v);
    res.status(204).end();
  });

  app.options('/api/admin/catalog/patch-source', (req, res) => {
    const h = webDeployCorsHeaders(req.headers.origin);
    for (const [k, v] of Object.entries(h)) res.setHeader(k, v);
    res.status(204).end();
  });

  app.post('/api/admin/catalog/patch-source', async (req: Request, res: Response) => {
    const h = webDeployCorsHeaders(req.headers.origin);
    for (const [k, v] of Object.entries(h)) res.setHeader(k, v);

    if (!isAuthorized(req)) {
      res.status(401).json({ error: 'Unauthorized' });
      return;
    }

    const rawToken =
      typeof req.body?.tokenAddress === 'string' ? req.body.tokenAddress.trim() : '';
    const rawSource =
      typeof req.body?.sourceUrl === 'string'
        ? req.body.sourceUrl.trim()
        : typeof req.body?.tweetUrl === 'string'
          ? req.body.tweetUrl.trim()
          : '';

    if (!rawToken || !rawSource) {
      res.status(400).json({ error: 'tokenAddress and sourceUrl (or tweetUrl) required' });
      return;
    }

    let tokenAddress: string;
    try {
      tokenAddress = getAddress(rawToken);
    } catch {
      res.status(400).json({ error: 'Invalid tokenAddress' });
      return;
    }

    const updated = await updateDeploymentCatalogLaunchSource(tokenAddress, rawSource);
    if (!updated) {
      res.status(404).json({
        error: 'Token not found in catalog, or sourceUrl already set.',
        tokenAddress,
      });
      return;
    }

    logger.info('Catalog admin patch-source', { tokenAddress, sourceUrl: rawSource });
    res.json({ ok: true, tokenAddress, sourceUrl: rawSource });
  });

  app.post('/api/admin/catalog/delete', async (req: Request, res: Response) => {
    const h = webDeployCorsHeaders(req.headers.origin);
    for (const [k, v] of Object.entries(h)) res.setHeader(k, v);

    if (!isAuthorized(req)) {
      res.status(401).json({ error: 'Unauthorized' });
      return;
    }

    const raw = req.body?.tokenAddresses ?? req.body?.tokenAddress;
    const list: string[] = Array.isArray(raw)
      ? raw.map(String)
      : typeof raw === 'string'
        ? [raw]
        : [];

    const normalized: string[] = [];
    for (const a of list) {
      try {
        normalized.push(getAddress(a.trim()));
      } catch {
        res.status(400).json({ error: `Invalid token address: ${a}` });
        return;
      }
    }

    if (normalized.length === 0) {
      res.status(400).json({ error: 'tokenAddresses (array) or tokenAddress (string) required' });
      return;
    }

    const removed = await deleteDeploymentCatalogByTokenAddresses(normalized);
    logger.info('Catalog admin delete', { removed, tokens: normalized });
    res.json({ ok: true, removed, tokenAddresses: normalized });
  });
}
