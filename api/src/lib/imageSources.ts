/**
 * Find a likely token image URL in free-form text (tweets, casts, bios).
 */
export function extractImageUrlFromText(text: string): string | undefined {
  if (!text || !text.trim()) return undefined;

  // Direct image file URLs
  const withExt = text.match(
    /https?:\/\/[^\s<>"']+\.(?:png|jpe?g|gif|webp|svg)(?:\?[^\s<>"']*)?/i
  );
  if (withExt) return withExt[0];

  // Common CDNs / hosts where path may omit extension
  const hostRe =
    /https?:\/\/[^\s<>"']*(?:imagedelivery\.net|pbs\.twimg\.com|abs\.twimg\.com|i\.imgur\.com|media\.discordapp\.(?:net|com)|cdn\.discordapp\.com\/attachments)[^\s<>"']*/i;
  const hostMatch = text.match(hostRe);
  if (hostMatch) return hostMatch[0];

  return undefined;
}

function firstPhotoUrlFromMediaList(list: unknown): string | undefined {
  if (!Array.isArray(list)) return undefined;
  for (const media of list) {
    if (!media || typeof media !== 'object') continue;
    const m = media as {
      type?: string;
      media_url_https?: string;
      url?: string;
    };
    if (m.type === 'photo' || m.media_url_https || m.url) {
      const raw = m.media_url_https || m.url;
      if (typeof raw === 'string' && raw.startsWith('http')) return raw;
    }
  }
  return undefined;
}

/** Syndication API tweet-result JSON (`photos`, `mediaDetails`). */
export function extractSyndicationTweetImageUrl(tweet: any): string | undefined {
  const photos = tweet?.photos;
  if (Array.isArray(photos) && photos[0] && typeof photos[0].url === 'string') {
    return photos[0].url;
  }
  return firstPhotoUrlFromMediaList(tweet?.mediaDetails);
}

/** X API v2: `{ data, includes: { media: [{ type, url }] } }`. */
export function extractTwitterV2MediaImageUrl(payload: any): string | undefined {
  const fromIncludes = firstPhotoUrlFromMediaList(payload?.includes?.media);
  if (fromIncludes) return fromIncludes;
  return firstPhotoUrlFromMediaList(payload?.media);
}

/** X/Twitter tweet object: v1.1 extended_entities, entities, or syndication shape. */
export function extractTwitterMediaImageUrl(tweet: any): string | undefined {
  const fromSyndication = extractSyndicationTweetImageUrl(tweet);
  if (fromSyndication) return fromSyndication;

  const fromV2 = extractTwitterV2MediaImageUrl(tweet);
  if (fromV2) return fromV2;

  const list = tweet?.extended_entities?.media ?? tweet?.entities?.media ?? [];
  return firstPhotoUrlFromMediaList(list);
}

/** X author profile picture (Account Activity / v1.1 style user object on tweets). */
export function extractXProfileImageUrl(tweet: any): string | undefined {
  const u = tweet?.user;
  if (!u || typeof u !== 'object') return undefined;
  const raw =
    (typeof u.profile_image_url_https === 'string' && u.profile_image_url_https) ||
    (typeof u.profile_image_url === 'string' && u.profile_image_url) ||
    undefined;
  if (!raw || !raw.startsWith('http')) return undefined;
  // _normal.jpg → larger asset when Twitter uses that suffix
  return raw.replace(/_normal(\.(?:jpg|jpeg|png|webp))$/i, '_400x400$1');
}
