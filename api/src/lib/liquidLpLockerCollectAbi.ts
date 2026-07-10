/**
 * LiquidLpLockerFeeConversion — permissionless collectRewards pulls LP fees from the
 * Uniswap v4 position into the fee locker (then recipients claim via fee locker).
 * @see https://github.com/Liquid-Protocol-Ops/liquid-protocol-v0/blob/main/src/lp-lockers/LiquidLpLockerFeeConversion.sol
 */
export const LIQUID_LP_LOCKER_COLLECT_ABI = [
  {
    type: 'function',
    name: 'collectRewards',
    inputs: [{ name: 'token', type: 'address' }],
    outputs: [],
    stateMutability: 'nonpayable',
  },
] as const;
