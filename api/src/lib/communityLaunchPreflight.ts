import {
  formatCommunityLaunchCreateBlockMessage,
  communityLaunchRowToConflict,
  type CommunityLaunchLockConflict,
} from './communityLaunchLock.js';
import {
  findActiveCommunityLaunchByName,
  findActiveCommunityLaunchBySymbol,
} from './petitionDb.js';
import { resolveEthRaiseCreate } from './petitionEthGoal.js';
import {
  formatDeployCooldownConflictMessage,
  getGlobalNameCooldownConflict,
  getGlobalSimilarNameCooldownConflict,
  getGlobalTickerCooldownConflict,
  type DeployCooldownConflict,
} from './globalTickerCooldown.js';
import { normalizeCatalogTickerSymbol } from './deploymentCatalog.js';

export type CommunityLaunchPreflightResult = {
  ok: boolean;
  error?: string;
  communityLaunch?: CommunityLaunchLockConflict;
  deployCooldown?: DeployCooldownConflict;
};

function tokenSymbol(raw: unknown): string {
  return normalizeCatalogTickerSymbol(String(raw ?? ''));
}

function cleanString(raw: unknown, max: number): string {
  return String(raw ?? '')
    .trim()
    .slice(0, max);
}

export async function runCommunityLaunchPreflight(input: {
  tokenName: unknown;
  tokenSymbol: unknown;
  targetRaiseEth?: unknown;
  supporterSlots?: unknown;
  appOrigin?: string;
}): Promise<CommunityLaunchPreflightResult> {
  const tokenName = cleanString(input.tokenName, 64);
  const symbol = tokenSymbol(input.tokenSymbol);
  const origin = (input.appOrigin ?? 'https://hood.markets').replace(/\/$/, '');

  if (tokenName.length < 2) {
    return { ok: false, error: 'tokenName must be at least 2 characters.' };
  }
  if (!symbol || symbol.length > 10) {
    return { ok: false, error: 'tokenSymbol is required (max 10 chars).' };
  }

  if (input.targetRaiseEth !== undefined && String(input.targetRaiseEth).trim() !== '') {
    const raise = resolveEthRaiseCreate({
      targetRaiseEth: input.targetRaiseEth,
      supporterSlots: input.supporterSlots,
    });
    if (!raise.ok) {
      return { ok: false, error: raise.error };
    }
  }

  const activeBySymbol = await findActiveCommunityLaunchBySymbol(symbol);
  if (activeBySymbol) {
    const conflict = {
      ...communityLaunchRowToConflict(activeBySymbol, 'ticker'),
      shareUrl: `${origin}/community-launch?id=${activeBySymbol.id}`,
    };
    return {
      ok: false,
      error: formatCommunityLaunchCreateBlockMessage(conflict),
      communityLaunch: conflict,
    };
  }

  const activeByName = await findActiveCommunityLaunchByName(tokenName);
  if (activeByName) {
    const conflict = {
      ...communityLaunchRowToConflict(activeByName, 'name'),
      shareUrl: `${origin}/community-launch?id=${activeByName.id}`,
    };
    return {
      ok: false,
      error: formatCommunityLaunchCreateBlockMessage(conflict),
      communityLaunch: conflict,
    };
  }

  const tickerCooldown = await getGlobalTickerCooldownConflict(symbol);
  if (tickerCooldown) {
    return {
      ok: false,
      error: formatDeployCooldownConflictMessage(tickerCooldown),
      deployCooldown: tickerCooldown,
    };
  }

  const nameCooldown =
    (await getGlobalNameCooldownConflict(tokenName)) ??
    (await getGlobalSimilarNameCooldownConflict(tokenName));
  if (nameCooldown) {
    return {
      ok: false,
      error: formatDeployCooldownConflictMessage(nameCooldown),
      deployCooldown: nameCooldown,
    };
  }

  return { ok: true };
}
