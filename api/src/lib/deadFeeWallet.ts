import { getAddress } from 'viem';

/**
 * Canonical burn address on Base — LP/trading fees accrue here but are not spendable
 * ("No Dev" / meme-style deploys).
 */
export const BASE_DEAD_FEE_RECIPIENT = getAddress(
  '0x000000000000000000000000000000000000dEaD',
);
