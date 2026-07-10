import crypto from 'crypto';
import { getAddress, type Address } from 'viem';
import { buildWebWalletLoginMessage } from './webWalletMessages.js';

const TTL_MS = 5 * 60 * 1000;

type PendingChallenge = {
  walletAddress: string;
  nonce: string;
  issuedAt: string;
  expiresAt: number;
};

const pending = new Map<string, PendingChallenge>();

function purgeExpired(): void {
  const now = Date.now();
  for (const [key, row] of pending) {
    if (row.expiresAt <= now) pending.delete(key);
  }
}

export function createWebWalletChallenge(walletAddress: string): {
  message: string;
  nonce: string;
  issuedAt: string;
  expiresAt: string;
} {
  purgeExpired();
  let addr: Address;
  try {
    addr = getAddress(walletAddress);
  } catch {
    throw new Error('walletAddress must be a valid 0x address.');
  }

  const nonce = crypto.randomBytes(16).toString('hex');
  const issuedAt = new Date().toISOString();
  const expiresAt = Date.now() + TTL_MS;
  const key = addr.toLowerCase();

  pending.set(key, { walletAddress: key, nonce, issuedAt, expiresAt });

  const message = buildWebWalletLoginMessage({ walletAddress: addr, nonce, issuedAt });
  return { message, nonce, issuedAt, expiresAt: new Date(expiresAt).toISOString() };
}

export function consumeWebWalletChallenge(
  walletAddress: string,
  message: string,
): { walletAddress: Address } {
  purgeExpired();
  let addr: Address;
  try {
    addr = getAddress(walletAddress);
  } catch {
    throw new Error('walletAddress must be a valid 0x address.');
  }

  const key = addr.toLowerCase();
  const row = pending.get(key);
  if (!row) {
    throw new Error('Login challenge expired or not found. Request a new challenge.');
  }
  pending.delete(key);

  if (row.expiresAt <= Date.now()) {
    throw new Error('Login challenge expired. Request a new challenge.');
  }

  const expected = buildWebWalletLoginMessage({
    walletAddress: addr,
    nonce: row.nonce,
    issuedAt: row.issuedAt,
  });
  if (message.trim() !== expected) {
    throw new Error('Signed message does not match the active login challenge.');
  }

  return { walletAddress: addr };
}
