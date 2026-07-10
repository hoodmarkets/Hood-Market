/**
 * Uniswap v4 pool reads on Robinhood Chain (PoolManager extsload).
 */
import {
  createPublicClient,
  erc20Abi,
  getAddress,
  http,
  keccak256,
  encodePacked,
  type Hex,
} from 'viem';
import {
  addSlotOffset,
  decodeSlot0Word,
  getPoolStateSlot,
  isValidV4PoolId,
  LIQUIDITY_WORD_OFFSET,
} from './uniswapV4PoolState.js';
import { ROBINHOOD_RPC_DEFAULT, ROBINHOOD_WETH, robinhood } from './robinhoodChain.js';

export const ROBINHOOD_POOL_MANAGER =
  '0x8366a39CC670B4001A1121B8F6A443A643e40951' as const;

const poolManagerExtsloadAbi = [
  {
    name: 'extsload',
    type: 'function',
    stateMutability: 'view',
    inputs: [{ name: 'slot', type: 'bytes32' }],
    outputs: [{ name: 'value', type: 'bytes32' }],
  },
] as const;

const Q96 = 1n << 96n;

function robinhoodClient() {
  const rpc = process.env.ROBINHOOD_RPC_URL?.trim() || ROBINHOOD_RPC_DEFAULT;
  return createPublicClient({
    chain: robinhood,
    transport: http(rpc),
  });
}

/** WETH per 1 token (18-decimal float string). */
export function wethPerTokenFromSqrtPrice(
  sqrtPriceX96: bigint,
  tokenIsToken0: boolean,
): number {
  if (sqrtPriceX96 <= 0n) return 0;
  const ratio = Number(sqrtPriceX96 * sqrtPriceX96) / Number(Q96 * Q96);
  if (!Number.isFinite(ratio) || ratio <= 0) return 0;
  return tokenIsToken0 ? ratio : 1 / ratio;
}

export type RobinhoodPoolStats = {
  poolId: Hex;
  tokenAddress: `0x${string}`;
  wethAddress: `0x${string}`;
  sqrtPriceX96: string;
  tick: number;
  liquidity: string;
  /** ETH per 1 whole token (float). */
  priceEthPerToken: string;
  /** Rough pool TVL in ETH (2× WETH-side virtual reserve). */
  liquidityEth: string;
  totalSupply: string;
  /** priceEthPerToken × circulating supply (full totalSupply). */
  marketCapEth: string;
  tokenIsToken0: boolean;
  source: 'on-chain';
};

export async function readRobinhoodPoolStats(opts: {
  poolId: string;
  tokenAddress: `0x${string}`;
  wethAddress?: `0x${string}`;
}): Promise<RobinhoodPoolStats | { error: string }> {
  const trimmed = opts.poolId.trim();
  if (!isValidV4PoolId(trimmed)) {
    return { error: 'Invalid poolId (expected 0x + 64 hex).' };
  }
  const poolId = trimmed as Hex;
  const weth = getAddress(opts.wethAddress ?? ROBINHOOD_WETH) as `0x${string}`;
  const token = getAddress(opts.tokenAddress) as `0x${string}`;
  const tokenIsToken0 = token.toLowerCase() < weth.toLowerCase();

  const client = robinhoodClient();
  const stateSlot = getPoolStateSlot(poolId);

  try {
    const slot0Word = (await client.readContract({
      address: ROBINHOOD_POOL_MANAGER,
      abi: poolManagerExtsloadAbi,
      functionName: 'extsload',
      args: [stateSlot],
    })) as Hex;

    const { sqrtPriceX96, tick } = decodeSlot0Word(slot0Word);
    if (sqrtPriceX96 <= 0n) {
      return { error: 'Pool not initialized (sqrtPrice is zero).' };
    }

    const liqSlot = addSlotOffset(stateSlot, LIQUIDITY_WORD_OFFSET);
    const liqWord = (await client.readContract({
      address: ROBINHOOD_POOL_MANAGER,
      abi: poolManagerExtsloadAbi,
      functionName: 'extsload',
      args: [liqSlot],
    })) as Hex;
    const liquidity = BigInt(liqWord) & ((1n << 128n) - 1n);

    const priceEth = wethPerTokenFromSqrtPrice(sqrtPriceX96, tokenIsToken0);

    let liquidityEth = 0;
    if (liquidity > 0n) {
      const wethWei = tokenIsToken0
        ? (liquidity * sqrtPriceX96) / Q96
        : (liquidity * Q96) / sqrtPriceX96;
      liquidityEth = Number(wethWei) / 1e18 * 2;
    }

    const totalSupply = await client.readContract({
      address: token,
      abi: erc20Abi,
      functionName: 'totalSupply',
    });
    const supplyTokens = Number(totalSupply) / 1e18;
    const marketCapEth = priceEth * supplyTokens;

    return {
      poolId,
      tokenAddress: token,
      wethAddress: weth,
      sqrtPriceX96: sqrtPriceX96.toString(),
      tick,
      liquidity: liquidity.toString(),
      priceEthPerToken: priceEth.toFixed(12).replace(/\.?0+$/, ''),
      liquidityEth: liquidityEth.toFixed(6).replace(/\.?0+$/, ''),
      totalSupply: totalSupply.toString(),
      marketCapEth: marketCapEth.toFixed(6).replace(/\.?0+$/, ''),
      tokenIsToken0,
      source: 'on-chain',
    };
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : String(e);
    return { error: `Robinhood pool read failed: ${msg}` };
  }
}
