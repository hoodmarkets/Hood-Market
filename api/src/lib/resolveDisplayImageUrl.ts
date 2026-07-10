import { resolveTokenImageUrl } from './tokenImageUrl.js';

const DIRECT_IMAGE = /\.(png|jpe?g|gif|webp|svg)(\?|$)/i;
const IMG_BB_PAGE = /^https?:\/\/(?:www\.)?ibb\.co(?:\.com)?\/([a-zA-Z0-9]+)\/?$/i;
const KOMODO_PAGE = /^https?:\/\/(?:www\.)?kommodo\.ai\/i\//i;

const cache = new Map<string, string>();
const MAX_CACHE = 512;

function remember(key: string, value: string): string {
  if (cache.size >= MAX_CACHE) {
    const first = cache.keys().next().value;
    if (first) cache.delete(first);
  }
  cache.set(key, value);
  return value;
}

export function looksLikeDirectImageUrl(url: string): boolean {
  const t = url.trim();
  if (!t) return false;
  if (extractIpfsCid(t)) return true;
  if (DIRECT_IMAGE.test(t)) return true;
  if (/^https?:\/\/i\.ibb\.co\//i.test(t)) return true;
  return false;
}

function extractIpfsCid(url: string): string | undefined {
  const t = url.trim();
  const proto = /^ipfs:\/\/([^/?#]+)/i.exec(t);
  if (proto?.[1]) return proto[1];
  const path = /\/ipfs\/([^/?#]+)/i.exec(t);
  if (path?.[1]) return path[1];
  return undefined;
}

async function resolveHtmlPageImage(pageUrl: string): Promise<string | undefined> {
  try {
    const res = await fetch(pageUrl, {
      redirect: 'follow',
      headers: { Accept: 'text/html', 'User-Agent': 'hood.markets/1.0' },
      signal: AbortSignal.timeout(8000),
    });
    if (!res.ok) return undefined;
    const html = await res.text();

    const og =
      html.match(/property="og:image"\s+content="([^"]+)"/i)?.[1] ??
      html.match(/content="([^"]+)"\s+property="og:image"/i)?.[1] ??
      html.match(/name="twitter:image"\s+content="([^"]+)"/i)?.[1];
    if (og && looksLikeDirectImageUrl(og)) return og;

    const ibb =
      html.match(/https:\/\/i\.ibb\.co\/[^"'\\s>]+\.(?:png|jpe?g|webp|gif)/i)?.[0] ??
      html.match(/https:\/\/i\.ibb\.co\.com\/[^"'\\s>]+\.(?:png|jpe?g|webp|gif)/i)?.[0];
    return ibb;
  } catch {
    return undefined;
  }
}

/** Resolve catalog / on-chain image URLs to a browser-loadable direct image when possible. */
export async function resolveDisplayImageUrl(raw: string | undefined | null): Promise<string | undefined> {
  const trimmed = (raw ?? '').trim();
  if (!trimmed) return undefined;

  const cached = cache.get(trimmed);
  if (cached) return cached;

  const ipfsResolved = resolveTokenImageUrl(trimmed);
  if (ipfsResolved && looksLikeDirectImageUrl(ipfsResolved)) {
    return remember(trimmed, ipfsResolved);
  }

  if (looksLikeDirectImageUrl(trimmed)) {
    return remember(trimmed, trimmed);
  }

  if (IMG_BB_PAGE.test(trimmed) || KOMODO_PAGE.test(trimmed) || !looksLikeDirectImageUrl(trimmed)) {
    const direct = await resolveHtmlPageImage(trimmed);
    if (direct) return remember(trimmed, direct);
  }

  if (ipfsResolved) return remember(trimmed, ipfsResolved);
  return undefined;
}
