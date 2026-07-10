import type { Express, Request, Response } from 'express';
import { claimFeesForDeployment } from '../lib/claimFeesForDeployment.js';
import { resolvePermissionlessClaimDeployment } from '../lib/claimDeploymentAuth.js';
import { markDeploymentFeeClaimed } from '../lib/deploymentCatalog.js';
import { friendlyV3ClaimError } from '../lib/hoodmarketsV3Fees.js';
import { friendlyCollectPoolError } from '../lib/deploymentFeeActions.js';
import { agentClaimSuccessAgentFields, agentClaimSuccessReplyHint } from '../lib/agentClaimReplyHint.js';
import { webDeployCorsHeaders } from '../lib/webDeployCors.js';

interface Body {
  tokenAddress?: string;
  tokenSymbol?: string;
}

/**
 * Permissionless fee claim for any hood.markets token — caller does NOT need to be the fee recipient.
 * On-chain, V3 claimRewards is already permissionless; funds always go to the catalog fee recipient.
 * Use when someone on X asks Bankr to "claim fees for EA's token" etc.
 */
export function registerAgentClaimForRecipientRoutes(app: Express): void {
  app.options('/api/agent/claim-for-recipient', (req, res) => {
    const h = webDeployCorsHeaders(req.headers.origin);
    for (const [k, v] of Object.entries(h)) res.setHeader(k, v);
    res.status(204).end();
  });

  app.post('/api/agent/claim-for-recipient', async (req: Request, res: Response) => {
    const h = webDeployCorsHeaders(req.headers.origin);
    for (const [k, v] of Object.entries(h)) res.setHeader(k, v);

    const body = req.body as Body;
    const tokenAddressRaw =
      typeof body.tokenAddress === 'string' ? body.tokenAddress.trim() : '';
    const tokenSymbolRaw =
      typeof body.tokenSymbol === 'string' ? body.tokenSymbol.trim() : '';

    try {
      const resolved = await resolvePermissionlessClaimDeployment({
        tokenAddress: tokenAddressRaw || undefined,
        tokenSymbol: tokenSymbolRaw || undefined,
      });
      if (!resolved.ok) {
        res.status(resolved.status).json({ error: resolved.error });
        return;
      }

      const { row, tokenAddress } = resolved;
      const claimed = await claimFeesForDeployment(row, tokenAddress);
      if (!claimed.ok) {
        const raw = claimed.error;
        const msg =
          claimed.feeModel === 'v3' ? friendlyV3ClaimError(raw) : friendlyCollectPoolError(raw);
        res.status(400).json({
          error: msg,
          feeModel: claimed.feeModel,
          feeRecipientAddress: row.feeRecipientAddress,
        });
        return;
      }

      await markDeploymentFeeClaimed(tokenAddress, claimed.txHash);
      const feeHuman =
        claimed.feeAmountWei > 0n
          ? (Number(claimed.feeAmountWei) / 1e18).toFixed(6)
          : undefined;
      const claimReplyHint = agentClaimSuccessReplyHint({
        tokenName: row.tokenName,
        tokenSymbol: row.tokenSymbol,
        feeRecipientAddress: row.feeRecipientAddress,
        feeAmountEth: feeHuman,
      });

      res.json({
        ok: true,
        ...agentClaimSuccessAgentFields(claimReplyHint, claimed.txHash),
        txHash: claimed.txHash,
        explorerUrl: claimed.basescanUrl,
        basescanUrl: claimed.basescanUrl,
        feeModel: claimed.feeModel,
        launchType: claimed.feeModel === 'v3' ? 'simple' : 'pro',
        tokenAddress,
        tokenName: row.tokenName,
        tokenSymbol: row.tokenSymbol,
        feeRecipientAddress: row.feeRecipientAddress,
        ...(feeHuman ? { feeAmountEth: feeHuman } : {}),
        message:
          claimed.feeModel === 'v3'
            ? `V3 fees claimed for ${row.tokenSymbol}. WETH sent to fee recipient ${row.feeRecipientAddress}. ${claimed.message}`
            : claimed.message,
        tokenPageUrl: `https://hood.markets/?token=${tokenAddress}`,
        ...(claimed.collectTxHash ? { collectTxHash: claimed.collectTxHash } : {}),
      });
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : 'Claim failed';
      res.status(500).json({ error: msg });
    }
  });

  /** GET alias for agents that prefer query params */
  app.get('/api/agent/claim-for-recipient', (req, res) => {
    const h = webDeployCorsHeaders(req.headers.origin);
    for (const [k, v] of Object.entries(h)) res.setHeader(k, v);
    res.status(405).json({
      error:
        'Use POST with JSON { "tokenAddress": "0x…" } and/or { "tokenSymbol": "$TEST" }. No fee-recipient wallet required — funds go to the catalog fee recipient / share holders.',
      method: 'POST',
      path: '/api/agent/claim-for-recipient',
    });
  });
}
