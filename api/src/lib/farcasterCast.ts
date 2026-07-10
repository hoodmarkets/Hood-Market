/**
 * Extract a token image URL from Farcaster cast embeds (Neynar webhook / API shape).
 * Image attachments are usually URL embeds pointing at imagedelivery.net or similar.
 */
export function extractCastImageUrl(embeds: unknown): string | undefined {
  if (!Array.isArray(embeds) || embeds.length === 0) return undefined;

  for (const raw of embeds) {
    if (!raw || typeof raw !== 'object') continue;
    const e = raw as Record<string, unknown>;

    // Quote-cast embed — not a direct image
    if ('cast' in e && !('url' in e)) continue;

    const url = e.url;
    if (typeof url !== 'string' || !/^https?:\/\//i.test(url)) continue;

    const meta = e.metadata as Record<string, unknown> | undefined;
    const contentType = meta?.content_type;
    if (typeof contentType === 'string' && contentType.startsWith('image/')) {
      return url;
    }

    if (meta?.image && typeof meta.image === 'object') {
      return url;
    }

    if (/\.(png|jpe?g|gif|webp)(\?|$)/i.test(url)) {
      return url;
    }

    if (url.includes('imagedelivery.net') || url.includes('cloudflare')) {
      return url;
    }
  }

  return undefined;
}
