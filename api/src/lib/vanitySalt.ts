import { randomBytes } from 'node:crypto';
import { toHex, type Address, type Hex } from 'viem';
import { logger } from '../logger.js';

/** Normalize env vanity suffix to lowercase hex (no 0x). */
export function normalizeVanitySuffix(raw: string): string {
  let s = raw.trim().toLowerCase();
  if (s.startsWith('0x')) s = s.slice(2);
  if (!/^[0-9a-f]+$/.test(s)) {
    throw new Error(`VANITY_ADDRESS_SUFFIX must be hex digits (e.g. 4004); got: ${raw}`);
  }
  if (s.length < 1 || s.length > 40) {
    throw new Error('VANITY_ADDRESS_SUFFIX must be 1–40 hex characters (20-byte address tail).');
  }
  return s;
}

/** Suffix for CREATE2 vanity mining. Opt-in only — set e.g. `4004`; unset / false / off disables. */
export function resolveVanityAddressSuffix(): string | null {
  const raw = process.env.VANITY_ADDRESS_SUFFIX?.trim();
  if (!raw || raw === 'false' || raw === '0' || raw === 'off' || raw === 'none') {
    return null;
  }
  return normalizeVanitySuffix(raw);
}

/** Web wallet launches — default suffix `00d` (fast 3-char). Set `WEB_WALLET_DEPLOY_VANITY=false` to disable. */
export function resolveWebVanityAddressSuffix(): string | null {
  const disabled =
    process.env.WEB_WALLET_DEPLOY_VANITY === 'false' ||
    process.env.WEB_WALLET_DEPLOY_VANITY === '0' ||
    process.env.WEB_WALLET_DEPLOY_VANITY === 'off';
  if (disabled) return null;

  const raw = process.env.WEB_VANITY_ADDRESS_SUFFIX?.trim();
  if (raw && raw !== 'false' && raw !== 'off' && raw !== 'none') {
    return normalizeVanitySuffix(raw);
  }
  return '00d';
}

export function vanitySaltMiningOptions(): { maxAttempts: number; concurrency: number } {
  const maxAttempts = (() => {
    const env = process.env.VANITY_SALT_MAX_ATTEMPTS?.trim();
    if (!env) return 1_000_000;
    const n = Number.parseInt(env, 10);
    if (!Number.isFinite(n) || n < 1) {
      throw new Error('VANITY_SALT_MAX_ATTEMPTS must be a positive integer');
    }
    return n;
  })();

  const concurrency = (() => {
    const env = process.env.VANITY_SALT_CONCURRENCY?.trim();
    if (!env) return 32;
    const n = Number.parseInt(env, 10);
    if (!Number.isFinite(n) || n < 1) {
      throw new Error('VANITY_SALT_CONCURRENCY must be a positive integer');
    }
    return Math.min(256, n);
  })();

  return { maxAttempts, concurrency };
}

/**
 * Brute-force CREATE2 salt candidates until `tryCandidate` returns a matching address.
 */
export async function bruteForceVanitySalt(
  suffix: string,
  tryCandidate: (candidate: Hex) => Promise<Address | null>,
): Promise<Hex> {
  const { maxAttempts, concurrency } = vanitySaltMiningOptions();
  let lastErr: unknown;
  let totalAttempts = 0;
  let lastProgressLog = 0;

  while (totalAttempts < maxAttempts) {
    const batch = Math.min(concurrency, maxAttempts - totalAttempts);
    const candidates = Array.from({ length: batch }, () => toHex(randomBytes(32)) as Hex);
    const results = await Promise.all(
      candidates.map((salt) => tryCandidate(salt).then((addr) => ({ salt, addr }))),
    );
    totalAttempts += batch;

    for (const { salt, addr } of results) {
      if (addr) {
        logger.info('Vanity salt found', {
          attempts: totalAttempts,
          suffix,
          tokenAddress: addr,
        });
        return salt;
      }
    }

    if (totalAttempts === batch || totalAttempts - lastProgressLog >= 5_000) {
      lastProgressLog = totalAttempts;
      logger.info('Vanity mining in progress', {
        attempts: totalAttempts,
        maxAttempts,
        concurrency,
        suffix,
      });
    }
  }

  throw new Error(
    `Vanity salt not found after ${maxAttempts} attempts (suffix …${suffix}). ` +
      `Increase VANITY_SALT_MAX_ATTEMPTS or set VANITY_ADDRESS_SUFFIX=false to disable. ` +
      (lastErr instanceof Error ? `Last error: ${lastErr.message}` : ''),
  );
}
