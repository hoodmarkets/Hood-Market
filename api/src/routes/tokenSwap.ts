import type { Express, Request, Response } from 'express';
import { getAddress } from 'viem';
import { config } from '../config.js';
import { getDeploymentByTokenAddress } from '../lib/deploymentCatalog.js';
import {
  buildHoodmarketsPoolKey,
  wethToTokenZeroForOne,
} from '../lib/hoodmarketsPoolKey.js';
import { readRobinhoodPoolStats } from '../lib/robinhoodV4PoolStats.js';
import { ROBINHOOD_WETH } from '../lib/robinhoodChain.js';
import { webDeployCorsHeadersRead } from '../lib/webDeployCors.js';

const DEFAULT_UNIVERSAL_ROUTER =
  '0x53BF6B0684Ec7eF91e1387Da3D1a1769bC5A6F77' as const;

function swapAddresses() {
  return {
    weth: (process.env.WETH?.trim() || ROBINHOOD_WETH) as `0x${string}`,
    universalRouter: (process.env.UNISWAP_UNIVERSAL_ROUTER?.trim() ||
      DEFAULT_UNIVERSAL_ROUTER) as `0x${string}`,
    hookStatic: config.liquid.hookStatic,
    swapHelper: config.liquid.swapHelper,
  };
}

function corsRead(req: Request, res: Response): void {
  const h = webDeployCorsHeadersRead(req.headers.origin);
  for (const [k, v] of Object.entries(h)) res.setHeader(k, v);
}

function parseTokenParam(raw: string): `0x${string}` | null {
  if (!/^0x[a-fA-F0-9]{40}$/.test(raw.trim())) return null;
  try {
    return getAddress(raw.trim());
  } catch {
    return null;
  }
}

export function registerTokenSwapRoutes(app: Express): void {
  app.options('/api/tokens/:tokenAddress/swap-config', (req, res) => {
    corsRead(req, res);
    res.status(204).end();
  });

  app.options('/api/tokens/:tokenAddress/pool-stats', (req, res) => {
    corsRead(req, res);
    res.status(204).end();
  });

  app.get('/api/tokens/:tokenAddress/swap-config', async (req: Request, res: Response) => {
    corsRead(req, res);

    const tokenAddress = parseTokenParam(
      typeof req.params.tokenAddress === 'string' ? req.params.tokenAddress : '',
    );
    if (!tokenAddress) {
      res.status(400).json({ error: 'tokenAddress must be a valid 0x contract address.' });
      return;
    }

    const deployment = await getDeploymentByTokenAddress(tokenAddress);
    if (!deployment) {
      res.status(404).json({ error: 'Token not found in hoodmarkets catalog.' });
      return;
    }

    const isV3 = !!deployment.poolId && deployment.poolId.toLowerCase().startsWith('v3:');
    if (isV3) {
      res.json({
        launchType: 'simple',
        chainId: 4663,
        tokenAddress,
        poolId: deployment.poolId,
        uniswapSwapUrl: `https://app.uniswap.org/swap?chain=robinhood&outputCurrency=${tokenAddress}`,
      });
      return;
    }

    const { weth, universalRouter, hookStatic, swapHelper } = swapAddresses();
    const permit2 = (process.env.PERMIT2?.trim() ||
      '0x000000000022D473030F116dDEE9F6B43aC78BA3') as `0x${string}`;
    if (!hookStatic) {
      res.status(503).json({ error: 'Swap is not configured (missing hook address).' });
      return;
    }

    const poolKey = buildHoodmarketsPoolKey(tokenAddress, hookStatic, weth);
    const zeroForOne = wethToTokenZeroForOne(poolKey, weth);
    const sellZeroForOne = !zeroForOne;

    res.json({
      launchType: 'pro',
      chainId: 4663,
      tokenAddress,
      poolId: deployment.poolId,
      poolKey,
      weth,
      universalRouter,
      permit2,
      swapHelper: swapHelper || undefined,
      /** ETH → token: WETH is tokenIn. */
      zeroForOne,
      /** Token → ETH: token is tokenIn. */
      sellZeroForOne,
      pairedToken: weth,
    });
  });

  app.get('/api/tokens/:tokenAddress/pool-stats', async (req: Request, res: Response) => {
    corsRead(req, res);

    const tokenAddress = parseTokenParam(
      typeof req.params.tokenAddress === 'string' ? req.params.tokenAddress : '',
    );
    if (!tokenAddress) {
      res.status(400).json({ error: 'tokenAddress must be a valid 0x contract address.' });
      return;
    }

    const deployment = await getDeploymentByTokenAddress(tokenAddress);
    if (!deployment?.poolId) {
      res.status(404).json({ error: 'Token not found or missing poolId.' });
      return;
    }

    const { weth } = swapAddresses();
    const stats = await readRobinhoodPoolStats({
      poolId: deployment.poolId,
      tokenAddress,
      wethAddress: weth,
    });

    if ('error' in stats) {
      res.status(502).json({ error: stats.error });
      return;
    }

    res.json(stats);
  });
}
