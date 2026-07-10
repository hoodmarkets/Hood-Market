import type { Express, Request, Response } from 'express';
import { getAddress } from 'viem';
import {
  getBuyerRewardStatus,
  processBuyerRewardShares,
} from '../lib/fractionBuyerRewards.js';
import { getDeploymentByTokenAddress } from '../lib/deploymentCatalog.js';
import { webDeployCorsHeaders } from '../lib/webDeployCors.js';

function parseTokenParam(raw: string): `0x${string}` | null {
  const trimmed = raw.trim();
  if (!/^0x[0-9a-fA-F]{40}$/.test(trimmed)) return null;
  try {
    return getAddress(trimmed) as `0x${string}`;
  } catch {
    return null;
  }
}

function applyCors(req: Request, res: Response): void {
  const h = webDeployCorsHeaders(req.headers.origin);
  for (const [k, v] of Object.entries(h)) res.setHeader(k, v);
}

/**
 * Public buyer-reward endpoints — scan pool swaps and issue escrowed Holder NFT shares
 * to first unique buyers (v0.6+ launches only).
 */
export function registerFractionBuyerRewardRoutes(app: Express): void {
  for (const path of [
    '/api/deployments/:tokenAddress/buyer-rewards-status',
    '/api/deployments/:tokenAddress/process-buyer-rewards',
  ]) {
    app.options(path, (req, res) => {
      applyCors(req, res);
      res.status(204).end();
    });
  }

  app.get('/api/deployments/:tokenAddress/buyer-rewards-status', async (req: Request, res: Response) => {
    applyCors(req, res);
    const tokenAddress = parseTokenParam(
      typeof req.params.tokenAddress === 'string' ? req.params.tokenAddress : '',
    );
    if (!tokenAddress) {
      res.status(400).json({ error: 'tokenAddress must be a valid 0x contract address.' });
      return;
    }

    try {
      const row = await getDeploymentByTokenAddress(tokenAddress);
      if (!row) {
        res.status(404).json({ error: 'Token not found in hoodmarkets catalog.' });
        return;
      }

      const status = await getBuyerRewardStatus(tokenAddress);
      res.json(status);
    } catch (e) {
      res.status(500).json({
        error: e instanceof Error ? e.message : 'Failed to read buyer reward status.',
      });
    }
  });

  app.post('/api/deployments/:tokenAddress/process-buyer-rewards', async (req: Request, res: Response) => {
    applyCors(req, res);
    const tokenAddress = parseTokenParam(
      typeof req.params.tokenAddress === 'string' ? req.params.tokenAddress : '',
    );
    if (!tokenAddress) {
      res.status(400).json({ error: 'tokenAddress must be a valid 0x contract address.' });
      return;
    }

    try {
      const row = await getDeploymentByTokenAddress(tokenAddress);
      if (!row) {
        res.status(404).json({ error: 'Token not found in hoodmarkets catalog.' });
        return;
      }

      const fromBlock =
        typeof req.body?.fromBlock === 'string' || typeof req.body?.fromBlock === 'number'
          ? BigInt(req.body.fromBlock)
          : row.blockNumber
            ? BigInt(row.blockNumber)
            : undefined;

      const result = await processBuyerRewardShares(tokenAddress, { fromBlock });
      const status = await getBuyerRewardStatus(tokenAddress);
      res.json({ ...result, status });
    } catch (e) {
      res.status(500).json({
        error: e instanceof Error ? e.message : 'Failed to process buyer rewards.',
      });
    }
  });
}
