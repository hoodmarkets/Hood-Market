/** Returns normalized https? URL or undefined for the literal `skip` or empty input */
export function parseOptionalHttpUrl(raw: string): string | undefined {
  const t = raw.trim().toLowerCase();
  if (!t || t === 'skip') return undefined;
  try {
    const u = new URL(raw.trim());
    if (u.protocol !== 'http:' && u.protocol !== 'https:') return undefined;
    return u.href;
  } catch {
    return undefined;
  }
}

/** Shorten a URL using TinyURL API for X posting */
export async function shortenUrl(url: string): Promise<string> {
  try {
    const response = await fetch(`https://tinyurl.com/api/create.php?url=${encodeURIComponent(url)}`);
    if (response.ok) {
      const shortened = await response.text();
      const cleanedUrl = shortened.trim();
      // Ensure it's actually a URL and not something weird
      if (cleanedUrl.startsWith('http://') || cleanedUrl.startsWith('https://')) {
        return cleanedUrl;
      }
    }
  } catch (err: any) {
    // Fall through to return original URL
  }
  // Return original URL, ensuring it's a clean string
  return String(url).trim();
}
 