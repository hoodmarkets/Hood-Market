import { getAddress } from 'viem';

/** Uniswap v4 `LPFeeLibrary.DYNAMIC_FEE_FLAG` — hood.markets hooks use dynamic LP fees. */
export const DYNAMIC_FEE_FLAG = 0x800000;

export const HOODMARKETS_STATIC_TICK_SPACING = 200;

export interface HoodmarketsPoolKey {
  currency0: `0x${string}`;
  currency1: `0x${string}`;
  fee: number;
  tickSpacing: number;
  hooks: `0x${string}`;
}

export function buildHoodmarketsPoolKey(
  tokenAddress: string,
  hookAddress: string,
  wethAddress: string,
): HoodmarketsPoolKey {
  const token = getAddress(tokenAddress);
  const weth = getAddress(wethAddress);
  const tokenIsLower = token.toLowerCase() < weth.toLowerCase();
  return {
    currency0: tokenIsLower ? token : weth,
    currency1: tokenIsLower ? weth : token,
    fee: DYNAMIC_FEE_FLAG,
    tickSpacing: HOODMARKETS_STATIC_TICK_SPACING,
    hooks: getAddress(hookAddress),
  };
}

export function wethToTokenZeroForOne(
  poolKey: HoodmarketsPoolKey,
  wethAddress: string,
): boolean {
  return poolKey.currency0.toLowerCase() === getAddress(wethAddress).toLowerCase();
}
