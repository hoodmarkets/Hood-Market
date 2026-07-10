import { getAddress, type Address } from 'viem';
import { ROBINHOOD_CHAIN_ID } from './robinhoodChain.js';

/** EIP-191 message users sign to obtain a hood.markets web session (Rainbow, Bankr, etc.). */
export function buildWebWalletLoginMessage(params: {
  walletAddress: Address;
  nonce: string;
  issuedAt: string;
}): string {
  const addr = getAddress(params.walletAddress);
  return [
    'hoodmarkets wallet login',
    `Robinhood Chain ID: ${ROBINHOOD_CHAIN_ID}`,
    `Wallet: ${addr}`,
    `Nonce: ${params.nonce}`,
    `Issued: ${params.issuedAt}`,
  ].join('\n');
}

export function webWalletDeployerId(walletAddress: Address): string {
  return `web-wallet:${getAddress(walletAddress).toLowerCase()}`;
}
