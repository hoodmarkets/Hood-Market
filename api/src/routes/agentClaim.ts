import type { Express, Request, Response } from 'express';
import { resolveAgentClaimDeployment } from '../lib/claimDeploymentAuth.js';
import { claimFeesForDeployment } from '../lib/claimFeesForDeployment.js';
import { markDeploymentFeeClaimed } from '../lib/deploymentCatalog.js';
import { friendlyV3ClaimError } from '../lib/hoodmarketsV3Fees.js';
import { friendlyCollectPoolError } from '../lib/deploymentFeeActions.js';
import { BASE_WETH } from '../lib/liquidFactoryDeploy.js';
import { ROBINHOOD_CHAIN_ID } from '../lib/robinhoodChain.js';
import { webDeployCorsHeaders } from '../lib/webDeployCors.js';
import { resolveAgentWalletAuth } from '../lib/agentWalletDeployAuth.js';
import { agentClaimSuccessAgentFields, agentClaimSuccessReplyHint } from '../lib/agentClaimReplyHint.js';

interface ClaimBody {
  tokenAddress?: string;
  /** Ticker — optional; if no tokenAddress, must uniquely identify one deployment for this fee wallet */
  tokenSymbol?: string;
  /** Full name — optional; use alone only if it uniquely identifies one deployment */
  tokenName?: string;
  agentCaptchaJwt?: string;
  wallet?: string;
  agentFeeRecipient?: string;
}

function friendlyAgentClaimError(feeModel: 'v3' | 'v4', raw: string): string {
  if (feeModel === 'v3') return friendlyV3ClaimError(raw);
  if (/no weth trading fees/i.test(raw)) {
    return (
      'No WETH fees in the locker yet. For Pro (V4) tokens, pool fees must accrue from trading first. ' +
      'Try again after more volume, or claim from the token page on hood.markets.'
    );
  }
  return friendlyCollectPoolError(raw);
}

/**
 * Auto-claim flow for agents (Bankr / X):
 * 1. Agent solves haiku CAPTCHA (gets JWT with walletAddress)
 * 2. Agent calls this endpoint with tokenAddress + JWT
 * 3. Server broadcasts the correct on-chain claim (V3 factory or V4 fee locker)
 */
export function registerAgentClaimRoutes(app: Express): void {
  app.options('/api/agent/claim', (req, res) => {
    const h = webDeployCorsHeaders(req.headers.origin);
    for (const [k, v] of Object.entries(h)) res.setHeader(k, v);
    res.status(204).end();
  });

  app.get('/api/agent/claim', (req: Request, res: Response) => {
    const h = webDeployCorsHeaders(req.headers.origin);
    for (const [k, v] of Object.entries(h)) res.setHeader(k, v);
    res.status(405).json({
      error:
        'Use HTTP POST, not GET. hood.markets broadcasts the claim and pays gas. Send JSON with tokenAddress (0x…) and/or tokenSymbol and/or tokenName to identify your deployment, plus header X-Agent-Captcha-JWT (haiku JWT). Only the recorded fee recipient may claim.',
      method: 'POST',
      path: '/api/agent/claim',
    });
  });

  app.post('/api/agent/claim', async (req: Request, res: Response) => {
    const h = webDeployCorsHeaders(req.headers.origin);
    for (const [k, v] of Object.entries(h)) res.setHeader(k, v);

    try {
      const body = req.body as ClaimBody;
      let walletFromCaptcha: `0x${string}`;
      try {
        const agentAuth = await resolveAgentWalletAuth(req.headers as any, body);
        walletFromCaptcha = agentAuth.walletAddress;
      } catch (e: unknown) {
        const msg = e instanceof Error ? e.message : String(e);
        const status = /requires|missing|invalid/i.test(msg) ? 400 : 401;
        res.status(status).json({ error: msg });
        return;
      }

      const tokenAddressRaw = typeof body.tokenAddress === 'string' ? body.tokenAddress.trim() : '';
      const tokenSymbolRaw = typeof body.tokenSymbol === 'string' ? body.tokenSymbol.trim() : '';
      const tokenNameRaw = typeof body.tokenName === 'string' ? body.tokenName.trim() : '';

      const resolved = await resolveAgentClaimDeployment({
        feeRecipient: walletFromCaptcha,
        tokenAddress: tokenAddressRaw || undefined,
        tokenSymbol: tokenSymbolRaw || undefined,
        tokenName: tokenNameRaw || undefined,
      });
      if (!resolved.ok) {
        res.status(resolved.status).json({ error: resolved.error });
        return;
      }

      const launchedToken = resolved.tokenAddress;
      const claimAsset = BASE_WETH;

      const claimed = await claimFeesForDeployment(resolved.row, launchedToken);
      if (!claimed.ok) {
        res.status(400).json({
          error: friendlyAgentClaimError(claimed.feeModel, claimed.error),
          feeModel: claimed.feeModel,
          feeAmount: '0',
          launchType: claimed.feeModel === 'v3' ? 'simple' : 'pro',
        });
        return;
      }

      const feeAmountEth =
        claimed.feeAmountWei > 0n
          ? (Number(claimed.feeAmountWei) / 1e18).toFixed(6)
          : undefined;
      const claimReplyHint = agentClaimSuccessReplyHint({
        tokenName: resolved.row.tokenName,
        tokenSymbol: resolved.row.tokenSymbol,
        feeRecipientAddress: walletFromCaptcha,
        feeAmountEth: feeAmountEth,
      });

      await markDeploymentFeeClaimed(launchedToken, claimed.txHash);

      res.json({
        ok: true,
        ...agentClaimSuccessAgentFields(claimReplyHint, claimed.txHash),
        chainId: ROBINHOOD_CHAIN_ID,
        txHash: claimed.txHash,
        explorerUrl: claimed.basescanUrl,
        basescanUrl: claimed.basescanUrl,
        feeModel: claimed.feeModel,
        launchType: claimed.feeModel === 'v3' ? 'simple' : 'pro',
        feeAmount: claimed.feeAmountWei.toString(),
        ...(feeAmountEth ? { feeAmountEth } : {}),
        feeOwner: walletFromCaptcha,
        token: launchedToken,
        tokenSymbol: resolved.row.tokenSymbol,
        tokenName: resolved.row.tokenName,
        claimAsset,
        message:
          claimed.feeModel === 'v3'
            ? `V3 swap fees claimed for ${resolved.row.tokenSymbol} — WETH sent to ${walletFromCaptcha}. ${claimed.message}`
            : `Claimed ${feeAmountEth} ETH (WETH) for ${resolved.row.tokenSymbol} to ${walletFromCaptcha}`,
        claimLink: claimed.basescanUrl,
        ...(claimed.collectTxHash ? { collectTxHash: claimed.collectTxHash } : {}),
      });
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : 'Claim failed';
      const status =
        /invalid|signature|jwt|captcha|missing|no fees/i.test(msg) && !/deploy/i.test(msg)
          ? 400
          : 500;
      res.status(status).json({ error: msg });
    }
  });
}
