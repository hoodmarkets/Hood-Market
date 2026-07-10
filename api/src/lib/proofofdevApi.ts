import { formatUnits } from 'viem';

const DEFAULT_API = 'https://api.proofofdev.xyz';
const DEFAULT_SITE = 'https://www.proofofdev.xyz';

export function getProofOfDevApiBase(): string {
  return (process.env.PROOFOFDEV_API_URL || DEFAULT_API).replace(/\/$/, '');
}

export function getProofOfDevSiteUrl(): string {
  return (process.env.PROOFOFDEV_SITE_URL || DEFAULT_SITE).replace(/\/$/, '');
}

export type ProofOfDevGrantProgress = {
  verifiedPushCount: number;
  totalPushesRequired: number;
  progressPct?: number;
  pushesUntilNextRelease?: number;
  summary?: string;
};

export type ProofOfDevGrantSummary = {
  repoFullName: string;
  githubOwner: string;
  token: string;
  status: string;
  totalLockedFormatted: string;
  progress: ProofOfDevGrantProgress;
  createdAt: string;
  streaming?: boolean;
  matchType?: 'token' | 'recipient';
};

export type ProofOfDevByTokenResponse = {
  ok: boolean;
  token: string;
  count: number;
  activeCount?: number;
  uniqueDevs?: number;
  grants: ProofOfDevGrantSummary[];
  createLockUrl?: string;
  error?: string;
};

function formatLocked(wei: string): string {
  try {
    const n = Number(formatUnits(BigInt(wei), 18));
    if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(2)}M`;
    if (n >= 1_000) return `${(n / 1_000).toFixed(2)}k`;
    return n.toLocaleString(undefined, { maximumFractionDigits: 2 });
  } catch {
    return wei;
  }
}

function lockPath(repoFullName: string): string {
  const [owner, ...rest] = repoFullName.split('/');
  const repoName = rest.join('/');
  return `${getProofOfDevSiteUrl()}/lock/${owner}/${repoName}`;
}

function devPath(githubLogin: string): string {
  return `${getProofOfDevSiteUrl()}/dev/${githubLogin}`;
}

export function enrichGrant(g: ProofOfDevGrantSummary) {
  const progressPct =
    g.progress.progressPct ??
    (g.progress.totalPushesRequired > 0
      ? Math.floor((g.progress.verifiedPushCount / g.progress.totalPushesRequired) * 100)
      : 0);
  return {
    ...g,
    progressPct,
    lockUrl: lockPath(g.repoFullName),
    devUrl: devPath(g.githubOwner),
    githubUrl: `https://github.com/${g.repoFullName}`,
  };
}

export async function fetchVestingByToken(token: string): Promise<ProofOfDevByTokenResponse> {
  const res = await fetch(`${getProofOfDevApiBase()}/api/vesting/by-token/${token}`, {
    signal: AbortSignal.timeout(12_000),
  });
  if (!res.ok) {
    return { ok: false, token, count: 0, grants: [], error: `Proof of Dev API ${res.status}` };
  }
  return (await res.json()) as ProofOfDevByTokenResponse;
}

type RecipientGrantRow = {
  grant: {
    repoFullName: string;
    token: string;
    status: string;
    totalLocked: string;
    streaming?: boolean;
    createdAt: string;
  };
  progress: ProofOfDevGrantProgress;
};

export async function fetchVestingByRecipient(recipient: string): Promise<ProofOfDevGrantSummary[]> {
  const res = await fetch(
    `${getProofOfDevApiBase()}/api/vesting/grants?recipient=${encodeURIComponent(recipient)}`,
    { signal: AbortSignal.timeout(12_000) },
  );
  if (!res.ok) return [];
  const data = (await res.json()) as { ok?: boolean; grants?: RecipientGrantRow[] };
  if (!data.ok || !Array.isArray(data.grants)) return [];

  return data.grants.map((row) => {
    const [githubOwner] = row.grant.repoFullName.split('/');
    return {
      repoFullName: row.grant.repoFullName,
      githubOwner: githubOwner ?? '',
      token: row.grant.token,
      status: row.grant.status,
      totalLockedFormatted: formatLocked(row.grant.totalLocked),
      progress: row.progress,
      createdAt: row.grant.createdAt,
      streaming: row.grant.streaming,
      matchType: 'recipient' as const,
    };
  });
}

export function mergeGrantLists(
  byToken: ProofOfDevGrantSummary[],
  byRecipient: ProofOfDevGrantSummary[],
): ProofOfDevGrantSummary[] {
  const map = new Map<string, ProofOfDevGrantSummary>();
  for (const g of byToken) {
    map.set(g.repoFullName, { ...g, matchType: 'token' });
  }
  for (const g of byRecipient) {
    if (!map.has(g.repoFullName)) map.set(g.repoFullName, g);
  }
  return [...map.values()].sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}
