import { getAddress, verifyMessage, type Address } from 'viem';
import { ROBINHOOD_CHAIN_ID } from './robinhoodChain.js';

const CHAIN_ID = ROBINHOOD_CHAIN_ID;

/** EIP-191 message the agent signs to authorize deploy (fee recipient must match signer). */
export function buildAgentDeployMessage(params: {
  feeRecipient: Address;
  name: string;
  symbol: string;
}): string {
  const sym = params.symbol.trim().toUpperCase().slice(0, 10);
  return [
    'hoodmarkets agent deploy',
    `Robinhood Chain ID: ${CHAIN_ID}`,
    `Fee recipient: ${getAddress(params.feeRecipient)}`,
    `Token name: ${params.name.trim()}`,
    `Symbol: ${sym}`,
  ].join('\n');
}

/** Message signed to authorize requesting claim calldata (fee recipient must match signer). */
export function buildAgentClaimMessage(params: {
  feeRecipient: Address;
  tokenAddress: Address;
}): string {
  return [
    'hoodmarkets agent claim fees',
    `Robinhood Chain ID: ${CHAIN_ID}`,
    `Fee recipient: ${getAddress(params.feeRecipient)}`,
    `Token: ${getAddress(params.tokenAddress)}`,
  ].join('\n');
}

export async function verifyDeploySignature(params: {
  feeRecipient: string;
  name: string;
  symbol: string;
  signature: `0x${string}`;
}): Promise<Address> {
  const addr = getAddress(params.feeRecipient as Address);
  const message = buildAgentDeployMessage({
    feeRecipient: addr,
    name: params.name,
    symbol: params.symbol,
  });
  const ok = await verifyMessage({
    address: addr,
    message,
    signature: params.signature,
  });
  if (!ok) {
    throw new Error('deploySignature does not match fee recipient wallet');
  }
  return addr;
}

export async function verifyClaimSignature(params: {
  feeRecipient: string;
  tokenAddress: string;
  signature: `0x${string}`;
}): Promise<{ feeRecipient: Address; tokenAddress: Address }> {
  const feeRecipient = getAddress(params.feeRecipient as Address);
  const tokenAddress = getAddress(params.tokenAddress as Address);
  const message = buildAgentClaimMessage({ feeRecipient, tokenAddress });
  const ok = await verifyMessage({
    address: feeRecipient,
    message,
    signature: params.signature,
  });
  if (!ok) {
    throw new Error('claimSignature does not match fee recipient wallet');
  }
  return { feeRecipient, tokenAddress };
}
