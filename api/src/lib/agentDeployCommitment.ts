import crypto from 'crypto';
import { getAddress, type Address } from 'viem';

/** Canonical payload binding for agent payment (must match between 402 and retry). */
export function buildAgentDeployCommitment(params: {
  name: string;
  symbol: string;
  agentFeeRecipient: Address;
  description: string;
  imageUrl: string;
}): string {
  const sym = params.symbol.trim().toUpperCase().slice(0, 10);
  const payload = {
    name: params.name.trim(),
    symbol: sym,
    agentFeeRecipient: getAddress(params.agentFeeRecipient),
    description: params.description.trim(),
    imageUrl: params.imageUrl.trim(),
  };
  return crypto.createHash('sha256').update(JSON.stringify(payload)).digest('hex');
}

export function verifyAgentDeployCommitment(
  commitment: string,
  params: {
    name: string;
    symbol: string;
    agentFeeRecipient: Address;
    description: string;
    imageUrl: string;
  },
): boolean {
  const expected = buildAgentDeployCommitment(params);
  const a = commitment.trim().toLowerCase();
  const b = expected.toLowerCase();
  return a.length > 0 && a === b;
}
