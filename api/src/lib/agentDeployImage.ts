import {
  extractImageUrlFromText,
  extractSyndicationTweetImageUrl,
  extractTwitterMediaImageUrl,
  extractTwitterV2MediaImageUrl,
} from './imageSources.js';

export type AgentDeployImageSource =
  | 'imageUrl'
  | 'tweetImageUrl'
  | 'mediaUrl'
  | 'tweet_media'
  | 'tweetMedia'
  | 'tweet_text'
  | 'tweet_syndication'
  | 'tweet_oembed';

export type AgentDeployImageInput = {
  imageUrl?: unknown;
  /** First photo from the original X tweet (pbs.twimg.com). */
  tweetImageUrl?: unknown;
  mediaUrl?: unknown;
  /** HTTPS URLs from tweet attachments. */
  tweetMedia?: unknown;
  /** Full tweet text — used to extract inline image URLs. */
  tweetText?: unknown;
  /** Twitter API tweet object (v1.1 extended_entities, v2 includes.media, or syndication JSON). */
  tweet?: unknown;
  /** Numeric tweet id — resolves via syndication API. */
  tweetId?: unknown;
  /** Full X status URL — resolves via syndication then oEmbed. */
  tweetUrl?: unknown;
};

function normalizeHttpsImageUrl(raw: unknown): string | undefined {
  if (typeof raw !== 'string') return undefined;
  const t = raw.trim();
  if (!t.startsWith('https://') && !t.startsWith('http://')) return undefined;
  return t.slice(0, 2048);
}

function firstUrlFromArray(raw: unknown): string | undefined {
  if (!Array.isArray(raw)) return undefined;
  for (const item of raw) {
    const direct = normalizeHttpsImageUrl(item);
    if (direct) return direct;
    if (item && typeof item === 'object') {
      const url = (item as { url?: unknown }).url;
      const nested = normalizeHttpsImageUrl(url);
      if (nested) return nested;
    }
  }
  return undefined;
}

/**
 * Resolve token logo for agent deploy from explicit fields or original tweet context.
 * Priority: imageUrl → tweetImageUrl → mediaUrl → tweetMedia[] → tweet object media → tweet text URL.
 */
export function resolveAgentDeployImageUrl(
  input: AgentDeployImageInput,
): { imageUrl: string | undefined; imageSource: AgentDeployImageSource | null } {
  const explicit = normalizeHttpsImageUrl(input.imageUrl);
  if (explicit) return { imageUrl: explicit, imageSource: 'imageUrl' };

  const tweetImg = normalizeHttpsImageUrl(input.tweetImageUrl);
  if (tweetImg) return { imageUrl: tweetImg, imageSource: 'tweetImageUrl' };

  const media = normalizeHttpsImageUrl(input.mediaUrl);
  if (media) return { imageUrl: media, imageSource: 'mediaUrl' };

  const fromArray = firstUrlFromArray(input.tweetMedia);
  if (fromArray) return { imageUrl: fromArray, imageSource: 'tweetMedia' };

  if (input.tweet && typeof input.tweet === 'object') {
    const fromTweet = extractTwitterMediaImageUrl(input.tweet);
    const u = normalizeHttpsImageUrl(fromTweet);
    if (u) return { imageUrl: u, imageSource: 'tweet_media' };

    const fromV2 = extractTwitterV2MediaImageUrl(input.tweet);
    const v2u = normalizeHttpsImageUrl(fromV2);
    if (v2u) return { imageUrl: v2u, imageSource: 'tweet_media' };
  }

  if (typeof input.tweetText === 'string') {
    const fromText = extractImageUrlFromText(input.tweetText);
    const u = normalizeHttpsImageUrl(fromText);
    if (u) return { imageUrl: u, imageSource: 'tweet_text' };
  }

  return { imageUrl: undefined, imageSource: null };
}

const X_STATUS_URL_RE = /(?:twitter\.com|x\.com)\/\w+\/status\/(\d+)/i;

/** Extract numeric tweet id from status URL or raw id string. */
export function extractTweetId(raw: unknown): string | undefined {
  if (typeof raw === 'number' && Number.isFinite(raw)) {
    return String(Math.trunc(raw));
  }
  if (typeof raw === 'string') {
    const t = raw.trim();
    if (/^\d{10,25}$/.test(t)) return t;
    const m = t.match(X_STATUS_URL_RE);
    if (m?.[1]) return m[1];
  }
  return undefined;
}

/** Token required by cdn.syndication.twimg.com/tweet-result (react-tweet formula). */
export function syndicationTokenForTweetId(tweetId: string): string {
  return ((Number(tweetId) / 1e15) * Math.PI).toString(36).replace(/(0+|\.)/g, '');
}

/** Normalize an X/Twitter status URL for syndication / oEmbed lookup. */
export function normalizeTweetStatusUrl(raw: unknown): string | undefined {
  if (typeof raw !== 'string') return undefined;
  const trimmed = raw.trim();
  if (!trimmed || !X_STATUS_URL_RE.test(trimmed)) return undefined;
  try {
    const withProto = /^https?:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`;
    const u = new URL(withProto);
    const host = u.hostname.replace(/^www\./i, '').toLowerCase();
    if (host !== 'x.com' && host !== 'twitter.com') return undefined;
    return u.toString().slice(0, 512);
  } catch {
    return undefined;
  }
}

/** Launch tweet URL for catalog `source_url` — from status URL or numeric tweet id. */
export function resolveLaunchTweetUrl(input: {
  tweetUrl?: unknown;
  tweet_url?: unknown;
  tweetId?: unknown;
  tweet_id?: unknown;
  sourceUrl?: unknown;
}): string | undefined {
  const fromUrl = normalizeTweetStatusUrl(
    input.tweetUrl ?? input.tweet_url ?? input.sourceUrl,
  );
  if (fromUrl) return fromUrl;
  const id = extractTweetId(input.tweetId ?? input.tweet_id);
  if (id) return `https://x.com/i/web/status/${id}`;
  return undefined;
}

/** Resolve attached photo via X syndication API (no auth — uses tweet id + token). */
export async function resolveTweetImageFromSyndication(tweetId: string): Promise<string | undefined> {
  const token = syndicationTokenForTweetId(tweetId);
  const url = `https://cdn.syndication.twimg.com/tweet-result?id=${encodeURIComponent(tweetId)}&lang=en&token=${encodeURIComponent(token)}`;
  const res = await fetch(url, {
    headers: {
      'User-Agent': 'Mozilla/5.0 (compatible; HoodMarkets/1.0)',
      Accept: 'application/json',
    },
    signal: AbortSignal.timeout(12_000),
  });
  if (!res.ok) return undefined;

  const j = (await res.json()) as { __typename?: string };
  if (j.__typename === 'TweetTombstone') return undefined;

  const fromSyndication = extractSyndicationTweetImageUrl(j);
  return normalizeHttpsImageUrl(fromSyndication);
}

/** Resolve attached photo from an X status URL via publish.twitter.com oEmbed. */
export async function resolveTweetImageFromOembed(tweetUrl: string): Promise<string | undefined> {
  const oembed = `https://publish.twitter.com/oembed?url=${encodeURIComponent(tweetUrl)}&omit_script=true&dnt=true`;
  const res = await fetch(oembed, {
    headers: { 'User-Agent': 'HoodMarkets/1.0' },
    signal: AbortSignal.timeout(12_000),
  });
  if (!res.ok) return undefined;

  const j = (await res.json()) as { thumbnail_url?: string; html?: string };
  const thumb = normalizeHttpsImageUrl(j.thumbnail_url);
  if (thumb) return thumb;

  if (typeof j.html === 'string') {
    const img = j.html.match(/<img[^>]+src=["']([^"']+)["']/i);
    const fromHtml = normalizeHttpsImageUrl(img?.[1]);
    if (fromHtml) return fromHtml;
  }

  return undefined;
}

/**
 * Resolve token logo — sync fields first, then syndication (tweet id), then oEmbed fallback.
 */
export async function resolveAgentDeployImageUrlAsync(
  input: AgentDeployImageInput,
): Promise<{ imageUrl: string | undefined; imageSource: AgentDeployImageSource | null }> {
  const sync = resolveAgentDeployImageUrl(input);
  if (sync.imageUrl && sync.imageSource) return sync;

  const tweetId = extractTweetId(input.tweetId) ?? extractTweetId(input.tweetUrl);
  if (tweetId) {
    const fromSyndication = await resolveTweetImageFromSyndication(tweetId);
    if (fromSyndication) {
      return { imageUrl: fromSyndication, imageSource: 'tweet_syndication' };
    }
  }

  const tweetUrl = normalizeTweetStatusUrl(input.tweetUrl);
  if (tweetUrl) {
    const fromOembed = await resolveTweetImageFromOembed(tweetUrl);
    if (fromOembed) return { imageUrl: fromOembed, imageSource: 'tweet_oembed' };
  }

  return sync;
}

export type AgentDeployConfirmSummary = {
  name: string;
  symbol: string;
  launchMode: 'simple' | 'pro';
  feeRecipient: string;
  imageUrl: string;
  imageSource: AgentDeployImageSource;
  description?: string;
  websiteUrl?: string;
  xUrl?: string;
};

export function buildAgentDeployConfirmSummary(input: {
  name: string;
  symbol: string;
  launchMode: 'simple' | 'pro';
  feeRecipient: string;
  imageUrl: string;
  imageSource: AgentDeployImageSource;
  description?: string;
  websiteUrl?: string;
  xUrl?: string;
}): AgentDeployConfirmSummary {
  return {
    name: input.name,
    symbol: input.symbol,
    launchMode: input.launchMode,
    feeRecipient: input.feeRecipient,
    imageUrl: input.imageUrl,
    imageSource: input.imageSource,
    ...(input.description ? { description: input.description } : {}),
    ...(input.websiteUrl ? { websiteUrl: input.websiteUrl } : {}),
    ...(input.xUrl ? { xUrl: input.xUrl } : {}),
  };
}

export function agentDeployConfirmReplyHint(summary: AgentDeployConfirmSummary): string {
  return (
    `Launch ${summary.name} ($${summary.symbol}) on hood.markets?\n` +
    `Logo: ${summary.imageUrl}\n` +
    `Fees: ${summary.feeRecipient}\n\n` +
    `Reply yes to deploy.`
  );
}

export function agentDeploySuccessReplyHint(input: {
  name: string;
  symbol: string;
  tokenAddress: string;
  transactionHash: string;
  feeRecipient: string;
  dexscreenerUrl?: string;
  uniswapSwapUrl?: string;
}): string {
  const lines = [
    `$${input.symbol} deployed on hood.markets.`,
    `Token: ${input.name} (${input.symbol})`,
    `Address: ${input.tokenAddress}`,
    `Tx: ${input.transactionHash}`,
    `Fee recipient: ${input.feeRecipient}`,
    `https://hood.markets/?token=${input.tokenAddress}`,
  ];
  if (input.dexscreenerUrl) lines.push(input.dexscreenerUrl);
  if (input.uniswapSwapUrl) lines.push(input.uniswapSwapUrl);
  return lines.join('\n');
}
