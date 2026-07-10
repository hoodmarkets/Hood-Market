import type { Express, Request, Response } from 'express';
import { getAddress } from 'viem';
import { readPendingWethFeesForFeeOwner } from '../lib/deploymentFeeActions.js';
import {
  getDeploymentByTokenAddress,
} from '../lib/deploymentCatalog.js';
import { isV3CatalogDeployment } from '../lib/hoodmarketsV3Fees.js';
import { isHoodmarketsPlatformFeeRecipientLabel } from '../lib/platformFeeRecipient.js';
import { readV3TradingFeePoolStatus } from '../lib/v3TradingFeePoolStatus.js';
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
 * Public fee status for any hood.markets token (read-only).
 * Collect/claim must be signed from the user's wallet — launcher no longer pays gas.
 */
export function registerDeploymentFeeActionRoutes(app: Express): void {
  for (const path of [
    '/api/deployments/:tokenAddress/fee-status',
    '/api/deployments/:tokenAddress/collect-pool-fees',
    '/api/deployments/:tokenAddress/claim-fees',
  ]) {
    app.options(path, (req, res) => {
      applyCors(req, res);
      res.status(204).end();
    });
  }

  app.get('/api/deployments/:tokenAddress/fee-status', async (req: Request, res: Response) => {
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

      const platformFees = isHoodmarketsPlatformFeeRecipientLabel(row.feeRecipientLabel);
      const feeOwner = row.feeRecipientAddress as `0x${string}`;
      const feeModel = isV3CatalogDeployment(row) ? 'v3' : 'v4';

      const pendingWei =
        platformFees || feeModel === 'v3' ? 0n : await readPendingWethFeesForFeeOwner(feeOwner);
      const pendingHuman = Number(pendingWei) / 1e18;

      const v3Pool =
        feeModel === 'v3' ? await readV3TradingFeePoolStatus(tokenAddress) : null;

      res.json({
        feeRecipientAddress: feeOwner,
        platformFees,
        feeModel,
        pendingWethWei: pendingWei.toString(),
        pendingWethHuman: pendingHuman.toFixed(6),
        /** V3 claims are always permissionless — no cooldown; revert only means no new fees to pay. */
        claimAlwaysAvailable: true,
        feeClaimedAt: row.feeClaimedAt?.trim() || undefined,
        feeClaimTxHash: row.feeClaimTxHash?.trim() || undefined,
        v3Pool: v3Pool ?? undefined,
      });
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : 'Failed to load fee status.';
      res.status(500).json({ error: msg });
    }
  });

  app.post('/api/deployments/:tokenAddress/collect-pool-fees', async (req: Request, res: Response) => {
    applyCors(req, res);
    res.status(410).json({
      error: 'Server-side collect is disabled. Connect a wallet on hood.markets and sign the transaction.',
    });
  });

  app.post('/api/deployments/:tokenAddress/claim-fees', async (req: Request, res: Response) => {
    applyCors(req, res);
    res.status(410).json({
      error: 'Server-side claim is disabled. Connect a wallet on hood.markets and sign the transaction.',
    });
  });
}
