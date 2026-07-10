import type { Address } from 'viem';
import { config } from '../config.js';
import { verifyPrivyBearerToken } from './privyAccessToken.js';
import { verifyWebWalletSessionToken } from './webWalletSession.js';

export type WebSessionAuth =
  | {
      kind: 'wallet';
      userId: string;
      walletAddress: Address;
      walletKind: string;
    }
  | {
      kind: 'privy';
      userId: string;
    };

function readBearer(authHeader: string | undefined): string | null {
  if (!authHeader?.startsWith('Bearer ')) return null;
  const t = authHeader.slice('Bearer '.length).trim();
  return t || null;
}

/** Resolve Bearer token to wallet session (preferred) or legacy Privy session. */
export async function verifyWebSessionBearer(
  authHeader: string | undefined,
): Promise<WebSessionAuth> {
  const bearer = readBearer(authHeader);
  if (!bearer) {
    throw new Error('Missing or invalid Authorization header');
  }

  if (config.webWallet.enabled) {
    try {
      const w = await verifyWebWalletSessionToken(bearer);
      return {
        kind: 'wallet',
        userId: w.userId,
        walletAddress: w.walletAddress,
        walletKind: w.walletKind,
      };
    } catch {
      /* fall through to Privy when configured */
    }
  }

  if (config.privy.enabled) {
    const { userId } = await verifyPrivyBearerToken(authHeader);
    return { kind: 'privy', userId };
  }

  throw new Error('Web login is not configured (set WEB_WALLET_JWT_SECRET or Privy keys).');
}
