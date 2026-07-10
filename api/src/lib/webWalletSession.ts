import { SignJWT, jwtVerify } from 'jose';
import { getAddress, type Address } from 'viem';
import { config } from '../config.js';
import { webWalletDeployerId } from './webWalletMessages.js';

export type WebWalletSessionPayload = {
  type: 'web_wallet_session';
  walletAddress: string;
  walletKind?: string;
};

function sessionSecret(): Uint8Array {
  const secret = config.webWallet.jwtSecret;
  if (!secret) {
    throw new Error(
      'WEB_WALLET_JWT_SECRET (or AGENT_CAPTCHA_JWT_SECRET) is required for wallet login.',
    );
  }
  return new TextEncoder().encode(secret);
}

export async function issueWebWalletSession(params: {
  walletAddress: Address;
  walletKind?: string;
}): Promise<{ token: string; expiresAt: string; userId: string }> {
  const addr = getAddress(params.walletAddress);
  const walletKind =
    typeof params.walletKind === 'string' ? params.walletKind.trim().slice(0, 64) : 'injected';
  const expSeconds = Math.max(1, config.webWallet.sessionHours) * 3600;
  const now = Math.floor(Date.now() / 1000);
  const exp = now + expSeconds;

  const token = await new SignJWT({
    type: 'web_wallet_session',
    walletAddress: addr,
    walletKind: walletKind || 'injected',
  } satisfies WebWalletSessionPayload)
    .setProtectedHeader({ alg: 'HS256' })
    .setIssuedAt(now)
    .setExpirationTime(exp)
    .sign(sessionSecret());

  return {
    token,
    expiresAt: new Date(exp * 1000).toISOString(),
    userId: webWalletDeployerId(addr),
  };
}

export async function verifyWebWalletSessionToken(
  bearerToken: string,
): Promise<{ userId: string; walletAddress: Address; walletKind: string }> {
  const t = bearerToken.trim();
  if (!t) throw new Error('Empty access token');

  const { payload } = await jwtVerify(t, sessionSecret(), { algorithms: ['HS256'] });
  if (payload.type !== 'web_wallet_session') {
    throw new Error('Invalid session token type');
  }
  if (typeof payload.walletAddress !== 'string' || !payload.walletAddress) {
    throw new Error('Session token missing walletAddress');
  }

  const walletAddress = getAddress(payload.walletAddress);
  const walletKind =
    typeof payload.walletKind === 'string' && payload.walletKind.trim()
      ? payload.walletKind.trim().slice(0, 64)
      : 'injected';

  return {
    userId: webWalletDeployerId(walletAddress),
    walletAddress,
    walletKind,
  };
}
