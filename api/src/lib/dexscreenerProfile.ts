import { ROBINHOOD_CHAIN_ID } from './robinhoodChain.js';
import { DEXSCREENER_CHAIN_SLUG } from './dexscreenerChain.js';

const DEXSCREENER_BASE = 'https://api.dexscreener.com';

type DexPair = {
  url?: string;
  liquidity?: { usd?: number | null };
  info?: {
    imageUrl?: string | null;
    header?: string | null;
    description?: string | null;
    websites?: Array<{ url?: string; label?: string }>;
    socials?: Array<{ url?: string; type?: string }>;
  };
};

type DexOrder = {
  type?: string;
  status?: string;
};

export type DexSocialLinksProfile = {
  websiteUrl: string;
  xUrl: string;
  telegramUrl: string;
  discordUrl: string;
  githubUrl: string;
  customLinks: Array<{ title: string; url: string }>;
};

export type DexBrandingProfile = {
  chainId: number;
  tokenAddress: string;
  found: boolean;
  enhancedInfoPaid: boolean;
  enhancedInfoStatus: string | null;
  iconUrl: string | null;
  bannerUrl: string | null;
  dexUrl: string | null;
  description: string | null;
  links: DexSocialLinksProfile;
};

function pickPrimaryPair(pairs: DexPair[]): DexPair | null {
  if (!pairs.length) return null;
  return [...pairs].sort((a, b) => (b.liquidity?.usd ?? 0) - (a.liquidity?.usd ?? 0))[0] ?? null;
}

function isHttpsDexAsset(url: string | null | undefined): url is string {
  if (!url) return false;
  const t = url.trim();
  if (!t.startsWith('https://')) return false;
  try {
    const host = new URL(t).hostname.toLowerCase();
    return (
      host.endsWith('dexscreener.com') ||
      host.endsWith('dd.dexscreener.com') ||
      host.endsWith('cdn.dexscreener.com')
    );
  } catch {
    return false;
  }
}

const EMPTY_DEX_LINKS: DexSocialLinksProfile = {
  websiteUrl: '',
  xUrl: '',
  telegramUrl: '',
  discordUrl: '',
  githubUrl: '',
  customLinks: [],
};

export function parseDexPairSocialLinks(
  info: DexPair['info'] | null | undefined,
): DexSocialLinksProfile {
  if (!info) return { ...EMPTY_DEX_LINKS, customLinks: [] };

  let websiteUrl = '';
  const customLinks: Array<{ title: string; url: string }> = [];

  for (const site of info.websites ?? []) {
    const url = site.url?.trim();
    if (!url || !url.startsWith('https://')) continue;
    const label = (site.label ?? 'Website').trim();
    if (label.toLowerCase() === 'website' && !websiteUrl) {
      websiteUrl = url.slice(0, 512);
    } else {
      customLinks.push({ title: label.slice(0, 40), url: url.slice(0, 512) });
    }
  }

  let xUrl = '';
  let telegramUrl = '';
  let discordUrl = '';
  let githubUrl = '';

  for (const social of info.socials ?? []) {
    const url = social.url?.trim();
    if (!url || !url.startsWith('https://')) continue;
    const type = (social.type ?? '').toLowerCase();
    if ((type === 'twitter' || type === 'x') && !xUrl) xUrl = url.slice(0, 512);
    else if (type === 'telegram' && !telegramUrl) telegramUrl = url.slice(0, 512);
    else if (type === 'discord' && !discordUrl) discordUrl = url.slice(0, 512);
    else if (type === 'github' && !githubUrl) githubUrl = url.slice(0, 512);
    else {
      const title = type ? type.charAt(0).toUpperCase() + type.slice(1) : 'Link';
      customLinks.push({ title: title.slice(0, 40), url: url.slice(0, 512) });
    }
  }

  return {
    websiteUrl,
    xUrl,
    telegramUrl,
    discordUrl,
    githubUrl,
    customLinks: customLinks.slice(0, 12),
  };
}

export async function fetchDexBrandingProfile(tokenAddress: string): Promise<DexBrandingProfile> {
  const address = tokenAddress.trim().toLowerCase();
  const empty: DexBrandingProfile = {
    chainId: ROBINHOOD_CHAIN_ID,
    tokenAddress: address,
    found: false,
    enhancedInfoPaid: false,
    enhancedInfoStatus: null,
    iconUrl: null,
    bannerUrl: null,
    dexUrl: null,
    description: null,
    links: { ...EMPTY_DEX_LINKS, customLinks: [] },
  };

  const [pairsRes, ordersRes] = await Promise.all([
    fetch(`${DEXSCREENER_BASE}/token-pairs/v1/${DEXSCREENER_CHAIN_SLUG}/${address}`, {
      signal: AbortSignal.timeout(12_000),
    }).catch(() => null),
    fetch(`${DEXSCREENER_BASE}/orders/v1/${DEXSCREENER_CHAIN_SLUG}/${address}`, {
      signal: AbortSignal.timeout(12_000),
    }).catch(() => null),
  ]);

  let pairs: DexPair[] = [];
  if (pairsRes?.ok) {
    const data = (await pairsRes.json()) as DexPair[] | { pairs?: DexPair[] };
    pairs = Array.isArray(data) ? data : (data.pairs ?? []);
  }

  let enhancedInfoPaid = false;
  let enhancedInfoStatus: string | null = null;
  if (ordersRes?.ok) {
    const ordersData = (await ordersRes.json()) as { orders?: DexOrder[] };
    const tokenProfile = (ordersData.orders ?? []).find((o) => o.type === 'tokenProfile');
    enhancedInfoStatus = tokenProfile?.status ?? null;
    enhancedInfoPaid =
      tokenProfile?.status === 'approved' || tokenProfile?.status === 'processing';
  }

  const primary = pickPrimaryPair(pairs);
  if (!primary && !enhancedInfoPaid) return empty;

  const iconUrl = isHttpsDexAsset(primary?.info?.imageUrl) ? primary!.info!.imageUrl!.trim() : null;
  const bannerUrl = isHttpsDexAsset(primary?.info?.header) ? primary!.info!.header!.trim() : null;
  const description = primary?.info?.description?.trim() || null;
  const links = parseDexPairSocialLinks(primary?.info);

  return {
    chainId: ROBINHOOD_CHAIN_ID,
    tokenAddress: address,
    found: !!primary,
    enhancedInfoPaid,
    enhancedInfoStatus,
    iconUrl,
    bannerUrl,
    dexUrl: primary?.url ?? null,
    description,
    links,
  };
}
