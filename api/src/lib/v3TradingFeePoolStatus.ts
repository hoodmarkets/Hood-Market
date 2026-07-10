import {
  createPublicClient,
  formatEther,
  http,
  parseAbi,
  zeroAddress,
  type Address,
} from 'viem';
import { config } from '../config.js';
import { robinhood } from './robinhoodChain.js';

const FACTORY_ABI = parseAbi([
  'function fractionCollectionForToken(address) view returns (address)',
  'function liquidityLocker() view returns (address)',
]);

const FRACTION_ABI = parseAbi([
  'function positionId() view returns (uint256)',
  'function rewardToken0() view returns (address)',
  'function rewardToken1() view returns (address)',
  'function rewardTokenAccounted(address) view returns (uint256)',
  'function outstandingShares() view returns (uint256)',
  'function tokensPerFraction() view returns (uint256)',
  'function launchToken() view returns (address)',
]);

const LOCKER_ABI = parseAbi(['function positionManager() view returns (address)']);

const ERC20_ABI = parseAbi(['function balanceOf(address) view returns (uint256)']);

const NPM_ABI = parseAbi([
  'function positions(uint256 tokenId) view returns (uint96 nonce, address operator, address token0, address token1, uint24 fee, int24 tickLower, int24 tickUpper, uint128 liquidity, uint256 feeGrowthInside0LastX128, uint256 feeGrowthInside1LastX128, uint128 tokensOwed0, uint128 tokensOwed1)',
  'function collect((uint256 tokenId, address recipient, uint128 amount0Max, uint128 amount1Max)) returns (uint256 amount0, uint256 amount1)',
]);

/** Platform cut on V3 LP collect (HoodMarketsV3LpLocker TEAM_REWARD = 5%). */
const PLATFORM_FEE_PCT = 5n;
const MAX_UINT128 = (1n << 128n) - 1n;

export type V3TradingFeePoolStatus = {
  fractionAddress: string;
  /** WETH on the Holder NFT that counts as trading fees (excludes vault-locked launch token). */
  fractionWethWei: string;
  fractionWethHuman: string;
  accountedWethWei: string;
  accountedWethHuman: string;
  /** max(0, accounted − balance) — refill needed before accrual unlocks (legacy bug). */
  gapWethWei: string;
  gapWethHuman: string;
  /** max(0, balance − accounted) — already on contract and payable. */
  surplusWethWei: string;
  surplusWethHuman: string;
  /** Uncollected WETH still in the Uniswap V3 LP NFT. */
  uncollectedWethWei: string;
  uncollectedWethHuman: string;
  /** ~95% of uncollected that lands on the fraction after the platform cut. */
  estimatedIncomingWethWei: string;
  estimatedIncomingWethHuman: string;
  /** Extra WETH still needed after applying estimated incoming. */
  remainingWethWei: string;
  remainingWethHuman: string;
  /** 0–1 toward next successful claim. */
  progress: number;
  claimReady: boolean;
  statusLabel: 'ready' | 'filling' | 'empty';
};

function human(wei: bigint): string {
  const n = Number(formatEther(wei));
  if (!Number.isFinite(n)) return formatEther(wei);
  if (n === 0) return '0';
  if (n < 0.000001) return '<0.000001';
  if (n < 0.01) return n.toFixed(6);
  if (n < 1) return n.toFixed(4);
  return n.toFixed(3);
}

function clamp01(n: number): number {
  if (!Number.isFinite(n)) return 0;
  return Math.max(0, Math.min(1, n));
}

/**
 * Read V3 Holder NFT + LP fee state for the claim progress UI.
 * Best-effort — returns null if the token has no fraction or RPC fails.
 */
export async function readV3TradingFeePoolStatus(
  tokenAddress: Address,
): Promise<V3TradingFeePoolStatus | null> {
  const factory = config.hoodmarketsV3.factory?.trim();
  if (!factory) return null;

  const client = createPublicClient({
    chain: robinhood,
    transport: http(config.chainRpcUrl),
  });

  try {
    const fraction = await client.readContract({
      address: factory as Address,
      abi: FACTORY_ABI,
      functionName: 'fractionCollectionForToken',
      args: [tokenAddress],
    });
    if (!fraction || fraction === zeroAddress) return null;

    const [reward0, reward1, positionId, launchToken, outstanding, tokensPerFraction, locker] =
      await Promise.all([
        client.readContract({ address: fraction, abi: FRACTION_ABI, functionName: 'rewardToken0' }),
        client.readContract({ address: fraction, abi: FRACTION_ABI, functionName: 'rewardToken1' }),
        client.readContract({ address: fraction, abi: FRACTION_ABI, functionName: 'positionId' }),
        client.readContract({ address: fraction, abi: FRACTION_ABI, functionName: 'launchToken' }),
        client.readContract({ address: fraction, abi: FRACTION_ABI, functionName: 'outstandingShares' }),
        client.readContract({ address: fraction, abi: FRACTION_ABI, functionName: 'tokensPerFraction' }),
        client.readContract({
          address: factory as Address,
          abi: FACTORY_ABI,
          functionName: 'liquidityLocker',
        }),
      ]);

    const wethAddr =
      reward0.toLowerCase() === launchToken.toLowerCase() ? reward1 : reward0;

    const [wethBal, accounted, positionManager] = await Promise.all([
      client.readContract({
        address: wethAddr,
        abi: ERC20_ABI,
        functionName: 'balanceOf',
        args: [fraction],
      }),
      client.readContract({
        address: fraction,
        abi: FRACTION_ABI,
        functionName: 'rewardTokenAccounted',
        args: [wethAddr],
      }),
      client.readContract({
        address: locker,
        abi: LOCKER_ABI,
        functionName: 'positionManager',
      }),
    ]);

    let rewardableWeth = wethBal;
    if (wethAddr.toLowerCase() === launchToken.toLowerCase()) {
      const vaultLocked = outstanding * tokensPerFraction;
      rewardableWeth = wethBal > vaultLocked ? wethBal - vaultLocked : 0n;
    }

    const gap = accounted > rewardableWeth ? accounted - rewardableWeth : 0n;
    const surplus = rewardableWeth > accounted ? rewardableWeth - accounted : 0n;

    let uncollectedWeth = 0n;
    try {
      const pos = await client.readContract({
        address: positionManager,
        abi: NPM_ABI,
        functionName: 'positions',
        args: [positionId],
      });
      const token0 = pos[2] as Address;
      const { result } = await client.simulateContract({
        address: positionManager,
        abi: NPM_ABI,
        functionName: 'collect',
        args: [
          {
            tokenId: positionId,
            recipient: locker,
            amount0Max: MAX_UINT128,
            amount1Max: MAX_UINT128,
          },
        ],
        account: locker,
      });
      uncollectedWeth =
        token0.toLowerCase() === wethAddr.toLowerCase() ? result[0] : result[1];
    } catch {
      uncollectedWeth = 0n;
    }

    const estimatedIncoming = (uncollectedWeth * (100n - PLATFORM_FEE_PCT)) / 100n;
    const remaining = gap > estimatedIncoming ? gap - estimatedIncoming : 0n;

    const claimReady =
      surplus > 0n ||
      (gap === 0n && uncollectedWeth > 0n) ||
      (gap > 0n && remaining === 0n && estimatedIncoming > 0n);

    let progress = 0;
    if (claimReady) {
      progress = 1;
    } else if (gap > 0n) {
      progress = clamp01(Number(estimatedIncoming) / Number(gap));
    } else if (uncollectedWeth > 0n) {
      progress = 1;
    }

    let statusLabel: V3TradingFeePoolStatus['statusLabel'] = 'empty';
    if (claimReady) statusLabel = 'ready';
    else if (gap > 0n || uncollectedWeth > 0n) statusLabel = 'filling';

    return {
      fractionAddress: fraction,
      fractionWethWei: rewardableWeth.toString(),
      fractionWethHuman: human(rewardableWeth),
      accountedWethWei: accounted.toString(),
      accountedWethHuman: human(accounted),
      gapWethWei: gap.toString(),
      gapWethHuman: human(gap),
      surplusWethWei: surplus.toString(),
      surplusWethHuman: human(surplus),
      uncollectedWethWei: uncollectedWeth.toString(),
      uncollectedWethHuman: human(uncollectedWeth),
      estimatedIncomingWethWei: estimatedIncoming.toString(),
      estimatedIncomingWethHuman: human(estimatedIncoming),
      remainingWethWei: remaining.toString(),
      remainingWethHuman: human(remaining),
      progress,
      claimReady,
      statusLabel,
    };
  } catch {
    return null;
  }
}
