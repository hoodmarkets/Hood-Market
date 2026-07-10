import { getAddress } from 'viem';

/** All lowercase EVM wallet addresses linked to a Privy user record. */
export function extractEthereumWalletAddresses(userJson: unknown): string[] {
  const u = userJson as {
    linked_accounts?: Array<{
      type?: string;
      chain_type?: string;
      address?: string;
    }>;
    wallet?: { address?: string; chain_type?: string };
  };

  const out = new Set<string>();
  const top = u.wallet;
  if (top?.chain_type === 'ethereum' && typeof top.address === 'string') {
    try {
      out.add(getAddress(top.address).toLowerCase());
    } catch {
      /* ignore */
    }
  }

  for (const a of u.linked_accounts ?? []) {
    if (a?.type !== 'wallet' && a?.type !== 'smart_wallet') continue;
    if (a.chain_type !== 'ethereum' || typeof a.address !== 'string') continue;
    try {
      out.add(getAddress(a.address).toLowerCase());
    } catch {
      /* ignore */
    }
  }

  return [...out];
}

export function privyUserOwnsWallet(userJson: unknown, walletAddress: string): boolean {
  try {
    const want = getAddress(walletAddress).toLowerCase();
    return extractEthereumWalletAddresses(userJson).includes(want);
  } catch {
    return false;
  }
}
