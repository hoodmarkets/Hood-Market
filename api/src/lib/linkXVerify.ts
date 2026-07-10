import crypto from 'crypto';

const CHALLENGE_TTL_MS = 30 * 60 * 1000;

export function xLinkVerifyExpiresAt(): number {
  return Date.now() + CHALLENGE_TTL_MS;
}

export function generateXLinkVerifyCode(): string {
  return crypto.randomBytes(4).toString('hex');
}

export function buildXLinkVerifyUrl(webBase: string, code: string): string {
  const base = webBase.replace(/\/$/, '');
  return `${base}/?verify=x&code=${encodeURIComponent(code)}`;
}

export type XProfileForVerify = {
  username: string;
  url?: string;
  description?: string;
};

/** True when X profile website or bio proves control of the account. */
export function xProfileContainsVerification(
  profile: XProfileForVerify,
  expectedHandle: string,
  code: string,
): boolean {
  const handle = expectedHandle.trim().replace(/^@/, '').toLowerCase();
  if (profile.username.toLowerCase() !== handle) return false;

  const codeLower = code.toLowerCase();
  const bio = (profile.description ?? '').toLowerCase();
  const website = (profile.url ?? '').toLowerCase();

  if (bio.includes(codeLower)) return true;
  if (website.includes(codeLower)) return true;
  if (bio.includes('hood.markets') && bio.includes(codeLower)) return true;
  return false;
}
