import { getAddress } from 'viem';
import { config } from '../config.js';
import { BASE_DEAD_FEE_RECIPIENT } from './deadFeeWallet.js';
import {
  countThirdPartyFeeRecipientDeploymentsRollingHours,
  getMostRecentGlobalNameDeploymentInRollingHours,
  getMostRecentGlobalTickerDeploymentInRollingHours,
  getMostRecentThirdPartyFeeRecipientDeploymentInRollingHours,
  hasGlobalNameDeploymentInRollingHours,
  hasGlobalTickerDeploymentInRollingHours,
  listRecentDeployedNamesInRollingHours,
  normalizeCatalogTickerSymbol,
  normalizeCatalogTokenName,
} from './deploymentCatalog.js';

export function globalTickerCooldownHours(): number {
  return config.globalTickerCooldownHours;
}

export interface ExistingDeployToken {
  tokenName: string;
  tokenSymbol: string;
  tokenAddress: string;
}

export interface DeployCooldownConflict {
  kind: 'ticker' | 'name';
  cooldownHours: number;
  requestedSymbol?: string;
  requestedName?: string;
  existing: ExistingDeployToken;
}

export async function getGlobalTickerCooldownConflict(
  symbol: string,
): Promise<DeployCooldownConflict | null> {
  const h = globalTickerCooldownHours();
  if (h <= 0) return null;
  if (!(await isTickerGloballyReserved(symbol))) return null;
  const existing = await getMostRecentGlobalTickerDeploymentInRollingHours(symbol, h);
  const s = normalizeCatalogTickerSymbol(symbol);
  if (!existing) {
    return {
      kind: 'ticker',
      cooldownHours: h,
      requestedSymbol: s,
      existing: {
        tokenName: '(unknown)',
        tokenSymbol: s,
        tokenAddress: '0x0000000000000000000000000000000000000000',
      },
    };
  }
  return {
    kind: 'ticker',
    cooldownHours: h,
    requestedSymbol: s,
    existing,
  };
}

export async function getGlobalNameCooldownConflict(
  name: string,
): Promise<DeployCooldownConflict | null> {
  const h = globalTickerCooldownHours();
  if (h <= 0) return null;
  if (!(await isNameGloballyReserved(name))) return null;
  const existing = await getMostRecentGlobalNameDeploymentInRollingHours(name, h);
  const n = normalizeCatalogTokenName(name);
  if (!existing) {
    return {
      kind: 'name',
      cooldownHours: h,
      requestedName: name.trim(),
      existing: {
        tokenName: name.trim(),
        tokenSymbol: '?',
        tokenAddress: '0x0000000000000000000000000000000000000000',
      },
    };
  }
  return {
    kind: 'name',
    cooldownHours: h,
    requestedName: name.trim(),
    existing: {
      tokenName: name.trim(),
      tokenSymbol: existing.tokenSymbol,
      tokenAddress: existing.tokenAddress,
    },
  };
}

function levenshtein(a: string, b: string): number {
  const m = a.length;
  const n = b.length;
  if (m === 0) return n;
  if (n === 0) return m;
  const dp = Array.from({ length: m + 1 }, () => new Array<number>(n + 1).fill(0));
  for (let i = 0; i <= m; i++) dp[i][0] = i;
  for (let j = 0; j <= n; j++) dp[0][j] = j;
  for (let i = 1; i <= m; i++) {
    for (let j = 1; j <= n; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      dp[i][j] = Math.min(dp[i - 1][j] + 1, dp[i][j - 1] + 1, dp[i - 1][j - 1] + cost);
    }
  }
  return dp[m][n];
}

function namesAreConfusinglySimilar(a: string, b: string): boolean {
  const na = normalizeCatalogTokenName(a);
  const nb = normalizeCatalogTokenName(b);
  if (!na || !nb || na === nb) return na === nb && na.length >= 2;
  if (na.includes(nb) || nb.includes(na)) return true;
  const maxLen = Math.max(na.length, nb.length);
  if (maxLen < 4) return false;
  const distance = levenshtein(na, nb);
  const threshold = maxLen >= 8 ? 2 : 1;
  return distance <= threshold;
}

/** Fuzzy name match against recent deploys when exact name differs slightly (e.g. hoorich vs Hoodrich). */
export async function getGlobalSimilarNameCooldownConflict(
  name: string,
): Promise<DeployCooldownConflict | null> {
  const exact = await getGlobalNameCooldownConflict(name);
  if (exact) return exact;
  const h = globalTickerCooldownHours();
  if (h <= 0) return null;
  const recent = await listRecentDeployedNamesInRollingHours(h);
  for (const row of recent) {
    if (!namesAreConfusinglySimilar(name, row.tokenName)) continue;
    return {
      kind: 'name',
      cooldownHours: h,
      requestedName: name.trim(),
      existing: {
        tokenName: row.tokenName,
        tokenSymbol: row.tokenSymbol,
        tokenAddress: row.tokenAddress,
      },
    };
  }
  return null;
}

export function formatDeployCooldownConflictMessage(conflict: DeployCooldownConflict): string {
  if (conflict.kind === 'ticker') {
    const sym = conflict.requestedSymbol ?? conflict.existing.tokenSymbol;
    return (
      `Ticker $${sym} was already deployed in the last ${conflict.cooldownHours} hours. ` +
      `Existing token: ${conflict.existing.tokenName} (${conflict.existing.tokenAddress}).`
    );
  }
  return (
    `Token name "${conflict.requestedName ?? conflict.existing.tokenName}" was already deployed in the last ${conflict.cooldownHours} hours. ` +
    `Existing token: $${conflict.existing.tokenSymbol} (${conflict.existing.tokenAddress}).`
  );
}

/** Short X/DM copy when ticker or name is on cooldown — includes existing token address when known. */
export function formatDeployCooldownReplyHint(conflict: DeployCooldownConflict): string {
  const { existing, cooldownHours } = conflict;
  const hasAddr =
    existing.tokenAddress &&
    existing.tokenAddress !== '0x0000000000000000000000000000000000000000';

  if (conflict.kind === 'ticker') {
    const sym = conflict.requestedSymbol ?? existing.tokenSymbol;
    if (hasAddr) {
      return (
        `Ticker $${sym} is already on hood.markets — ${existing.tokenName} at ${existing.tokenAddress}. ` +
        `Try another symbol or wait ${cooldownHours}h.\n` +
        `https://hood.markets/?token=${existing.tokenAddress}`
      );
    }
    return `Ticker $${sym} is taken on hood.markets for now — try another symbol or wait ${cooldownHours}h.`;
  }

  const name = conflict.requestedName ?? existing.tokenName;
  if (hasAddr) {
    return (
      `Name "${name}" is already on hood.markets — $${existing.tokenSymbol} at ${existing.tokenAddress}. ` +
      `Try another name or wait ${cooldownHours}h.\n` +
      `https://hood.markets/?token=${existing.tokenAddress}`
    );
  }
  return `That name is taken on hood.markets — pick another name or wait ${cooldownHours}h.`;
}

/** True if this ticker was used in a catalog deploy within the configured rolling window (global). */
export async function isTickerGloballyReserved(symbol: string): Promise<boolean> {
  const h = globalTickerCooldownHours();
  if (h <= 0) return false;
  return hasGlobalTickerDeploymentInRollingHours(symbol, h);
}

/** True if this token name was used in a catalog deploy within the configured rolling window (global). */
export async function isNameGloballyReserved(name: string): Promise<boolean> {
  const h = globalTickerCooldownHours();
  if (h <= 0) return false;
  return hasGlobalNameDeploymentInRollingHours(name, h);
}

/**
 * User-facing cooldown message, including the existing token contract from the catalog when available.
 */
export async function formatGlobalTickerCooldownMessage(symbol: string): Promise<string> {
  const conflict = await getGlobalTickerCooldownConflict(symbol);
  if (conflict) return formatDeployCooldownConflictMessage(conflict);
  const s = normalizeCatalogTickerSymbol(symbol);
  const h = globalTickerCooldownHours();
  return `Ticker $${s} was already deployed in the last ${h} hours. Choose another symbol or wait.`;
}

export async function formatGlobalNameCooldownMessage(name: string): Promise<string> {
  const conflict = await getGlobalNameCooldownConflict(name);
  if (conflict) return formatDeployCooldownConflictMessage(conflict);
  const h = globalTickerCooldownHours();
  return `Token name "${name.trim()}" was already deployed in the last ${h} hours. Choose another name or wait.`;
}

/**
 * Third-party fee wallet cooldown (same window as `GLOBAL_TICKER_COOLDOWN_HOURS`): at most one catalog
 * deploy with `fee_to_self = 0` to this address in the rolling window (any platform / ticker).
 */
export async function formatThirdPartyFeeRecipientCooldownMessage(
  feeRecipientAddress: string,
  feeRecipientLabel?: string,
): Promise<string> {
  const h = globalTickerCooldownHours();
  let addr: string;
  try {
    addr = getAddress(feeRecipientAddress);
  } catch {
    return 'Invalid fee wallet for cooldown check.';
  }
  const label = (feeRecipientLabel ?? '').trim();
  const who = label ? `${label} (${addr})` : addr;
  let msg = `This fee recipient already had a token deployed in the last ${h} hours: ${who}. Use a different wallet/account or wait.`;
  if (h <= 0) return msg;
  const existing = await getMostRecentThirdPartyFeeRecipientDeploymentInRollingHours(addr, h);
  if (existing) {
    msg += `\n\nRecent token for this recipient: ${existing.tokenAddress}\nSymbol: $${existing.tokenSymbol}\nName: ${existing.tokenName}`;
  }
  return msg;
}

/** When cooldown applies, returns an error string; otherwise `null`. */
export async function thirdPartyFeeRecipientCooldownErrorOrNull(
  feeRecipientAddress: string,
  opts: { feeToSelf: boolean; rateLimitForcedBurn: boolean; feeRecipientLabel?: string },
): Promise<string | null> {
  const h = globalTickerCooldownHours();
  if (h <= 0) return null;
  if (opts.feeToSelf || opts.rateLimitForcedBurn) return null;
  let addr: string;
  try {
    addr = getAddress(feeRecipientAddress);
  } catch {
    return null;
  }
  if (addr.toLowerCase() === BASE_DEAD_FEE_RECIPIENT.toLowerCase()) return null;
  const n = await countThirdPartyFeeRecipientDeploymentsRollingHours(addr, h);
  if (n <= 0) return null;
  return formatThirdPartyFeeRecipientCooldownMessage(addr, opts.feeRecipientLabel);
}
