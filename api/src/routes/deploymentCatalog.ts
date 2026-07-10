import type { Express, Request, Response } from 'express';
import { getAddress } from 'viem';
import {
  countVisibleDeploymentCatalog,
  enrichDeploymentForPublicApi,
  getDeploymentByTokenAddress,
  listDeploymentCatalog,
  listDeploymentCatalogByDeployerPlatformHandle,
  listDeploymentCatalogByFeeRecipient,
  listSelfFeeTokensForFeeRecipient,
  listThirdPartyFeeTokensForFeeRecipientRollingHours,
  type DeploymentCatalogClaimedFilter,
} from '../lib/deploymentCatalog.js';
import {
  deployRateLimitRollingHours,
  thirdPartyRollingWindowDeployWarnUserMessage,
} from '../lib/selfFeeLimit.js';
import { webDeployCorsHeadersRead } from '../lib/webDeployCors.js';

/**
 * Public read-only list of tokens deployed via this launcher (SQLite-backed).
 * Query: ?limit=100&offset=0&claimed=any|yes|no  (optional — fee claim recorded in catalog)
 * Optional: ?feeRecipient=0x… — only rows where that address receives trading fees (public wallet profile).
 * Optional: ?deployerPlatform=x&deployerHandle=… — rows for that deployer (in-app social profile).
 */
export function registerDeploymentCatalogRoutes(app: Express): void {
  app.options('/api/deployments', (req, res) => {
    const h = webDeployCorsHeadersRead(req.headers.origin);
    for (const [k, v] of Object.entries(h)) res.setHeader(k, v);
    res.status(204).end();
  });

  app.options('/api/deployments', (req, res) => {
    const h = webDeployCorsHeadersRead(req.headers.origin);
    for (const [k, v] of Object.entries(h)) res.setHeader(k, v);
    res.status(204).end();
  });

  app.options('/api/deployments/:tokenAddress', (req, res) => {
    const h = webDeployCorsHeadersRead(req.headers.origin);
    for (const [k, v] of Object.entries(h)) res.setHeader(k, v);
    res.status(204).end();
  });

  app.options('/api/token-image', (req, res) => {
    const h = webDeployCorsHeadersRead(req.headers.origin);
    for (const [k, v] of Object.entries(h)) res.setHeader(k, v);
    res.status(204).end();
  });

  app.get('/api/token-image', async (req: Request, res: Response) => {
    const h = webDeployCorsHeadersRead(req.headers.origin);
    for (const [k, v] of Object.entries(h)) res.setHeader(k, v);

    const raw = typeof req.query.url === 'string' ? req.query.url.trim() : '';
    if (!raw.startsWith('http://') && !raw.startsWith('https://')) {
      res.status(400).json({ error: 'url must be an http(s) URL.' });
      return;
    }

    try {
      const { resolveDisplayImageUrl } = await import('../lib/resolveDisplayImageUrl.js');
      const imageUrl = await resolveDisplayImageUrl(raw);
      if (!imageUrl) {
        res.status(404).json({ error: 'Could not resolve image URL.' });
        return;
      }
      res.json({ imageUrl });
    } catch {
      res.status(500).json({ error: 'Failed to resolve image URL.' });
    }
  });

  app.get('/api/deployments/:tokenAddress', async (req: Request, res: Response) => {
    const h = webDeployCorsHeadersRead(req.headers.origin);
    for (const [k, v] of Object.entries(h)) res.setHeader(k, v);

    const raw = typeof req.params.tokenAddress === 'string' ? req.params.tokenAddress.trim() : '';
    if (!/^0x[0-9a-fA-F]{40}$/.test(raw)) {
      res.status(400).json({ error: 'tokenAddress must be a valid 0x contract address.' });
      return;
    }
    try {
      getAddress(raw);
    } catch {
      res.status(400).json({ error: 'Invalid token address checksum.' });
      return;
    }

    try {
      const deployment = await enrichDeploymentForPublicApi(
        await getDeploymentByTokenAddress(raw),
      );
      if (!deployment) {
        res.status(404).json({ error: 'Token not found in hoodmarkets catalog.' });
        return;
      }
      res.json({ deployment });
    } catch {
      res.status(500).json({ error: 'Failed to load token.' });
    }
  });

  app.get('/api/deployments', async (req: Request, res: Response) => {
    const h = webDeployCorsHeadersRead(req.headers.origin);
    for (const [k, v] of Object.entries(h)) res.setHeader(k, v);

    const rawLimit = req.query.limit;
    const rawOffset = req.query.offset;
    const rawClaimed = req.query.claimed;
    const limit =
      typeof rawLimit === 'string' ? Number.parseInt(rawLimit, 10) : 100;
    const offset =
      typeof rawOffset === 'string' ? Number.parseInt(rawOffset, 10) : 0;
    let claimed: DeploymentCatalogClaimedFilter = 'any';
    if (typeof rawClaimed === 'string') {
      const c = rawClaimed.trim().toLowerCase();
      if (c === 'yes' || c === 'true' || c === '1') claimed = 'yes';
      else if (c === 'no' || c === 'false' || c === '0') claimed = 'no';
    }

    const rawFeeRecipient =
      typeof req.query.feeRecipient === 'string' ? req.query.feeRecipient.trim() : '';
    const rawDeployerPlatform =
      typeof req.query.deployerPlatform === 'string' ? req.query.deployerPlatform.trim() : '';
    const rawDeployerHandle =
      typeof req.query.deployerHandle === 'string' ? req.query.deployerHandle.trim() : '';

    try {
      if (rawDeployerPlatform && rawDeployerHandle) {
        const deployments = await listDeploymentCatalogByDeployerPlatformHandle(
          rawDeployerPlatform,
          rawDeployerHandle,
          Number.isFinite(limit) ? limit : 100,
          Number.isFinite(offset) ? offset : 0,
          claimed,
        );
        res.json({ deployments });
        return;
      }

      if (rawFeeRecipient) {
        let feeRecipient: string;
        try {
          feeRecipient = getAddress(rawFeeRecipient);
        } catch {
          res.status(400).json({ error: 'feeRecipient must be a valid 0x wallet address.' });
          return;
        }
        const deployments = await listDeploymentCatalogByFeeRecipient(
          feeRecipient,
          Number.isFinite(limit) ? limit : 100,
          Number.isFinite(offset) ? offset : 0,
          claimed,
        );
        res.json({ deployments });
        return;
      }

      const deployments = await listDeploymentCatalog(
        Number.isFinite(limit) ? limit : 100,
        Number.isFinite(offset) ? offset : 0,
        claimed,
      );
      const total = await countVisibleDeploymentCatalog(claimed);
      res.json({ deployments, total });
    } catch {
      res.status(500).json({ error: 'Failed to load deployments.' });
    }
  });

  // Public: look up existing tokens deployed for a given fee recipient wallet address.
  // Used by the frontend to warn deployers before launching another token for someone who already has one.
  app.options('/api/recipient-tokens', (req, res) => {
    const h = webDeployCorsHeadersRead(req.headers.origin);
    for (const [k, v] of Object.entries(h)) res.setHeader(k, v);
    res.status(204).end();
  });

  app.get('/api/recipient-tokens', async (req: Request, res: Response) => {
    const h = webDeployCorsHeadersRead(req.headers.origin);
    for (const [k, v] of Object.entries(h)) res.setHeader(k, v);

    const raw = typeof req.query.address === 'string' ? req.query.address.trim() : '';
    if (!/^0x[0-9a-fA-F]{40}$/.test(raw)) {
      res.status(400).json({ error: 'address must be a valid 0x wallet address.' });
      return;
    }
    let address: string;
    try {
      address = getAddress(raw);
    } catch {
      res.status(400).json({ error: 'Invalid address checksum.' });
      return;
    }
    try {
      const rollingHours = deployRateLimitRollingHours();
      const selfFeeTokens = await listSelfFeeTokensForFeeRecipient(address, 8);
      const thirdPartyRecent =
        rollingHours > 0
          ? await listThirdPartyFeeTokensForFeeRecipientRollingHours(address, rollingHours, 8)
          : [];
      res.json({
        rollingHours,
        selfFeeTokens,
        thirdPartyRecent,
        ...(thirdPartyRecent.length > 0
          ? {
              thirdPartyRollingDeployWarn:
                thirdPartyRollingWindowDeployWarnUserMessage(rollingHours),
            }
          : {}),
      });
    } catch {
      res.status(500).json({ error: 'Failed to look up tokens.' });
    }
  });
}
