/** Robinhood Chain mainnet (4663) — launcher defaults. */

import { defineChain } from 'viem';

export const ROBINHOOD_CHAIN_ID = 4663;

export const ROBINHOOD_WETH =
  '0x0Bd7D308f8E1639FAb988df18A8011f41EAcAD73' as const;

export const ROBINHOOD_RPC_DEFAULT = 'https://rpc.mainnet.chain.robinhood.com';

export const ROBINHOOD_EXPLORER = 'https://robinhoodchain.blockscout.com';

export const robinhood = defineChain({
  id: ROBINHOOD_CHAIN_ID,
  name: 'Robinhood Chain',
  nativeCurrency: { name: 'Ether', symbol: 'ETH', decimals: 18 },
  rpcUrls: {
    default: { http: [ROBINHOOD_RPC_DEFAULT] },
  },
  blockExplorers: {
    default: { name: 'Blockscout', url: ROBINHOOD_EXPLORER },
  },
});

export function robinhoodTxUrl(txHash: string): string {
  return `${ROBINHOOD_EXPLORER}/tx/${txHash}`;
}

export function robinhoodTokenUrl(tokenAddress: string): string {
  return `${ROBINHOOD_EXPLORER}/token/${tokenAddress}`;
}

export function robinhoodAddressUrl(address: string): string {
  return `${ROBINHOOD_EXPLORER}/address/${address}`;
}

/** @deprecated use robinhoodTxUrl — kept for API field name `basescanUrl` */
export const explorerTxUrl = robinhoodTxUrl;

/** Paired token for Liquid pools on Robinhood (alias for legacy `BASE_WETH` imports). */
export const CHAIN_WETH = ROBINHOOD_WETH;
