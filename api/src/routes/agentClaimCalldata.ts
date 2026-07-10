import type { Express, Request, Response } from 'express';
import { createPublicClient, encodeFunctionData, http } from 'viem';
import { config } from '../config.js';
import { resolveAgentClaimDeployment } from '../lib/claimDeploymentAuth.js';
import { BASE_WETH } from '../lib/liquidFactoryDeploy.js';
import {
  isV3CatalogDeployment,
  resolveV3ClaimTarget,
} from '../lib/hoodmarketsV3Fees.js';
import { robinhood, ROBINHOOD_CHAIN_ID } from '../lib/robinhoodChain.js';
import { webDeployCorsHeaders } from '../lib/webDeployCors.js';
import { readAgentCaptchaToken, verifyAgentCaptchaJwt } from '../lib/agentCaptchaVerify.js';

/** V4 fee locker — claim WETH after pool collect */
const FEE_LOCKER_CLAIM_ABI = [
  {
    type: 'function',
    name: 'claim',
    inputs: [
      { name: 'feeOwner', type: 'address' },
      { name: 'token', type: 'address' },
    ],
    outputs: [],
    stateMutability: 'nonpayable',
  },
] as const;

interface ClaimBody {
  tokenAddress?: string;
  tokenSymbol?: string;
  tokenName?: string;
  feeRecipient?: string;
  agentCaptchaJwt?: string;
}

/**
 * Returns unsigned tx calldata so the agent can broadcast claim with their own wallet.
 * V3 simple launches → Holder NFT `claimTradingFees()` (one tx pays all share holders).
 * V4 pro launches → fee locker claim(feeOwner, WETH) after pool collect.
 */
export function registerAgentClaimCalldataRoutes(app: Express): void {
  app.options('/api/agent/claim-calldata', (req, res) => {
    const h = webDeployCorsHeaders(req.headers.origin);
    for (const [k, v] of Object.entries(h)) res.setHeader(k, v);
    res.status(204).end();
  });

  app.post('/api/agent/claim-calldata', async (req: Request, res: Response) => {
    const h = webDeployCorsHeaders(req.headers.origin);
    for (const [k, v] of Object.entries(h)) res.setHeader(k, v);

    try {
      const body = req.body as ClaimBody;
      const captchaJwt = readAgentCaptchaToken(req.headers as any, body);
      if (!captchaJwt) {
        res.status(400).json({
          error:
            'Missing agent captcha JWT (X-Agent-Captcha-JWT or agentCaptchaJwt). Solve haiku challenge first.',
        });
        return;
      }

      let captchaPayload;
      try {
        captchaPayload = await verifyAgentCaptchaJwt(captchaJwt);
      } catch (e: unknown) {
        const msg = e instanceof Error ? e.message : String(e);
        res.status(401).json({ error: msg });
        return;
      }

      const walletFromCaptcha = captchaPayload.walletAddress;

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

      const token = resolved.tokenAddress as `0x${string}`;
      const isV3 = isV3CatalogDeployment(resolved.row);

      if (isV3) {
        const publicClient = createPublicClient({
          chain: robinhood,
          transport: http(config.chainRpcUrl),
        });
        const target = await resolveV3ClaimTarget(token, publicClient);
        res.json({
          ok: true,
          chainId: ROBINHOOD_CHAIN_ID,
          to: target.to,
          data: target.data,
          value: '0x0',
          feeRecipient: walletFromCaptcha,
          tokenAddress: token,
          feeModel: 'v3',
          launchType: 'simple',
          hint: target.usesFraction
            ? 'Simple (V3) launch: call claimTradingFees() on the Holder NFT contract. One tx pulls pool fees and pays every share holder pro-rata. Prefer POST /api/agent/claim so hood.markets pays gas.'
            : 'Simple (V3) legacy launch: call HoodMarketsV3.claimRewards(token). Prefer POST /api/agent/claim so hood.markets pays gas.',
        });
        return;
      }

      const claimAsset = BASE_WETH;
      const data = encodeFunctionData({
        abi: FEE_LOCKER_CLAIM_ABI,
        functionName: 'claim',
        args: [walletFromCaptcha as `0x${string}`, claimAsset],
      });

      res.json({
        ok: true,
        chainId: ROBINHOOD_CHAIN_ID,
        to: config.liquid.feeLocker,
        data,
        value: '0x0',
        feeRecipient: walletFromCaptcha,
        tokenAddress: token,
        claimAsset,
        feeModel: 'v4',
        launchType: 'pro',
        hint:
          'Pro (V4) launch: collect pool fees into the locker first, then claim WETH from the fee locker. Prefer POST /api/agent/claim so hood.markets pays gas.',
      });
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : 'Claim calldata failed';
      const status =
        /invalid|signature|jwt|captcha|missing/i.test(msg) && !/deploy/i.test(msg) ? 401 : 400;
      res.status(status).json({ error: msg });
    }
  });
}
