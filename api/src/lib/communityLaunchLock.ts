import {
  findActiveCommunityLaunchByName,
  findActiveCommunityLaunchBySymbol,
  type PetitionRow,
} from './petitionDb.js';
import { normalizeCatalogTickerSymbol } from './deploymentCatalog.js';

export type CommunityLaunchLockKind = 'ticker' | 'name';

export type CommunityLaunchLockConflict = {
  kind: CommunityLaunchLockKind;
  roundId: number;
  tokenName: string;
  tokenSymbol: string;
  status: string;
  expiresAt: string;
  shareUrl: string;
};

function shareUrlForRound(id: number): string {
  return `https://hood.markets/community-launch?id=${id}`;
}

export function communityLaunchRowToConflict(
  row: PetitionRow,
  kind: CommunityLaunchLockKind,
): CommunityLaunchLockConflict {
  return {
    kind,
    roundId: row.id,
    tokenName: row.token_name,
    tokenSymbol: row.token_symbol,
    status: row.status,
    expiresAt: row.expires_at,
    shareUrl: shareUrlForRound(row.id),
  };
}

export async function getCommunityLaunchLockConflict(
  symbol: string,
  name: string,
  appOrigin = 'https://hood.markets',
): Promise<CommunityLaunchLockConflict | null> {
  const sym = normalizeCatalogTickerSymbol(symbol);
  const bySymbol = sym ? await findActiveCommunityLaunchBySymbol(sym) : undefined;
  if (bySymbol) {
    return {
      ...communityLaunchRowToConflict(bySymbol, 'ticker'),
      shareUrl: `${appOrigin.replace(/\/$/, '')}/community-launch?id=${bySymbol.id}`,
    };
  }

  const byName = name.trim().length >= 2 ? await findActiveCommunityLaunchByName(name) : undefined;
  if (byName) {
    return {
      ...communityLaunchRowToConflict(byName, 'name'),
      shareUrl: `${appOrigin.replace(/\/$/, '')}/community-launch?id=${byName.id}`,
    };
  }

  return null;
}

export function formatCommunityLaunchLockMessage(conflict: CommunityLaunchLockConflict): string {
  const statusNote =
    conflict.status === 'open'
      ? 'until it sells out or expires'
      : 'while launch finalization is in progress';

  if (conflict.kind === 'ticker') {
    return (
      `Ticker $${conflict.tokenSymbol} has an active Community Launch (round #${conflict.roundId}). ` +
      `Instant deploy is blocked ${statusNote}. ` +
      conflict.shareUrl
    );
  }

  return (
    `Token name "${conflict.tokenName}" has an active Community Launch for $${conflict.tokenSymbol} ` +
    `(round #${conflict.roundId}). Instant deploy is blocked ${statusNote}. ` +
    conflict.shareUrl
  );
}

export function formatCommunityLaunchCreateBlockMessage(conflict: CommunityLaunchLockConflict): string {
  const statusNote =
    conflict.status === 'open'
      ? 'until it sells out or expires'
      : 'while launch finalization is in progress';

  if (conflict.kind === 'ticker') {
    return (
      `Ticker $${conflict.tokenSymbol} already has an active Community Launch (round #${conflict.roundId}). ` +
      `Start another round ${statusNote}. ` +
      conflict.shareUrl
    );
  }

  return (
    `Token name "${conflict.tokenName}" is reserved by Community Launch $${conflict.tokenSymbol} ` +
    `(round #${conflict.roundId}). Pick another name or wait ${statusNote}. ` +
    conflict.shareUrl
  );
}

export function formatCommunityLaunchLockReplyHint(conflict: CommunityLaunchLockConflict): string {
  if (conflict.kind === 'ticker') {
    return (
      `$${conflict.tokenSymbol} is in a Community Launch pre-sale on hood.markets — ` +
      `can't deploy the same ticker until the round finishes or expires.\n${conflict.shareUrl}`
    );
  }
  return (
    `That token name is tied to an active Community Launch for $${conflict.tokenSymbol} — ` +
    `pick another name or wait for the round to finish.\n${conflict.shareUrl}`
  );
}
