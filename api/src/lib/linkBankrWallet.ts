import { getAddress, verifyMessage, type Address } from 'viem';

const LINK_TTL_MS = 10 * 60 * 1000;

export function buildLinkBankrWalletMessage(
  privyUserId: string,
  walletAddress: string,
  expiresAtMs: number,
): string {
  const wallet = getAddress(walletAddress);
  return [
    'hood.markets — link Bankr wallet',
    `User: ${privyUserId}`,
    `Wallet: ${wallet}`,
    `Expires: ${expiresAtMs}`,
  ].join('\n');
}

export async function verifyLinkBankrWalletSignature(input: {
  privyUserId: string;
  walletAddress: string;
  expiresAtMs: number;
  signature: `0x${string}`;
}): Promise<void> {
  if (!Number.isFinite(input.expiresAtMs) || input.expiresAtMs < Date.now()) {
    throw new Error('Link request expired. Try again.');
  }
  if (input.expiresAtMs - Date.now() > LINK_TTL_MS + 60_000) {
    throw new Error('Invalid link expiry.');
  }

  const wallet = getAddress(input.walletAddress) as Address;
  const message = buildLinkBankrWalletMessage(input.privyUserId, wallet, input.expiresAtMs);
  const valid = await verifyMessage({
    address: wallet,
    message,
    signature: input.signature,
  });
  if (!valid) {
    throw new Error('Signature does not match wallet.');
  }
}

export function linkBankrWalletExpiresAt(): number {
  return Date.now() + LINK_TTL_MS;
}
