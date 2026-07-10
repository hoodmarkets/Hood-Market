import type { DeploymentCatalogRow } from './deploymentCatalog.js';
import { parseAgentMetadataJson } from './agentDeployMetadata.js';

const X_HANDLE_RE = /^[A-Za-z0-9_]{1,15}$/;
const X_TWEET_USER_RE = /(?:twitter\.com|x\.com)\/([A-Za-z0-9_]{1,15})\/status\//i;

/** Normalize @handle or bare username for storage and lookup. */
export function normalizeXUsername(raw: unknown): string | undefined {
  if (typeof raw !== 'string') return undefined;
  const t = raw.trim().replace(/^@/, '').split(/[\s/]/)[0]?.trim();
  if (!t || !X_HANDLE_RE.test(t)) return undefined;
  return t.toLowerCase();
}

export function xUsernameFromTweetUrl(url: unknown): string | undefined {
  if (typeof url !== 'string') return undefined;
  const m = url.trim().match(X_TWEET_USER_RE);
  return m ? normalizeXUsername(m[1]) : undefined;
}

export function resolveRequesterXUsernameFromDeployInput(input: {
  xUsername?: unknown;
  tweetUrl?: unknown;
  tweet_url?: unknown;
  sourceUrl?: unknown;
  launchTweetUrl?: unknown;
}): string | undefined {
  const direct = normalizeXUsername(
    typeof input.xUsername === 'string' ? input.xUsername : undefined,
  );
  if (direct) return direct;

  for (const raw of [
    input.tweetUrl,
    input.tweet_url,
    input.sourceUrl,
    input.launchTweetUrl,
  ]) {
    const fromTweet = xUsernameFromTweetUrl(raw);
    if (fromTweet) return fromTweet;
  }
  return undefined;
}

/** Best-effort X handle for who requested this launch (catalog row). */
export function resolveRequesterXUsername(row: DeploymentCatalogRow): string | undefined {
  const meta = parseAgentMetadataJson(row.agentMetadata);
  const fromMeta = normalizeXUsername(meta?.xUsername);
  if (fromMeta) return fromMeta;

  const label = row.deployerLabel?.trim() ?? '';
  if (label.startsWith('@')) {
    const fromLabel = normalizeXUsername(label.slice(1));
    if (fromLabel) return fromLabel;
  }
  const atMatch = label.match(/@([A-Za-z0-9_]{1,15})/);
  if (atMatch) {
    const fromAt = normalizeXUsername(atMatch[1]);
    if (fromAt) return fromAt;
  }

  const fromSource = xUsernameFromTweetUrl(row.sourceUrl);
  if (fromSource) return fromSource;

  const fromMetaTweet = xUsernameFromTweetUrl(meta?.launchTweetUrl);
  if (fromMetaTweet) return fromMetaTweet;

  return undefined;
}

export type DeploymentPublicExtras = {
  requesterXUsername?: string;
  requesterXLaunchCount?: number;
  deployerWalletAddress?: string;
};
