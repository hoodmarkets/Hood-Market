import crypto from 'crypto';
import { config } from '../config.js';
import { logger } from '../logger.js';

const X_API_BASE = 'https://api.x.com';

export interface XCredentials {
  consumerKey: string;
  consumerSecret: string;
  accessToken: string;
  accessTokenSecret: string;
}

function oauthSign(
  method: string,
  url: string,
  params: Record<string, string>,
  consumerSecret: string,
  tokenSecret: string,
): string {
  const sortedParams = Object.keys(params)
    .sort()
    .map(k => `${encodeURIComponent(k)}=${encodeURIComponent(params[k])}`)
    .join('&');

  const baseString = `${method.toUpperCase()}&${encodeURIComponent(url)}&${encodeURIComponent(sortedParams)}`;
  const signingKey = `${encodeURIComponent(consumerSecret)}&${encodeURIComponent(tokenSecret)}`;

  return crypto.createHmac('sha1', signingKey).update(baseString).digest('base64');
}

/** OAuth 1.0a signed GET — `baseUrl` has no query string; signature includes `query` + oauth params. */
async function oauth1aGet(
  baseUrl: string,
  query: Record<string, string>,
  credentials: XCredentials,
): Promise<Response> {
  const oauthParams: Record<string, string> = {
    oauth_consumer_key: credentials.consumerKey,
    oauth_nonce: crypto.randomBytes(16).toString('hex'),
    oauth_signature_method: 'HMAC-SHA1',
    oauth_timestamp: Math.floor(Date.now() / 1000).toString(),
    oauth_token: credentials.accessToken,
    oauth_version: '1.0',
  };
  const allParams: Record<string, string> = { ...query, ...oauthParams };
  oauthParams.oauth_signature = oauthSign(
    'GET',
    baseUrl,
    allParams,
    credentials.consumerSecret,
    credentials.accessTokenSecret,
  );
  const authHeader =
    'OAuth ' +
    Object.keys(oauthParams)
      .sort()
      .map(k => `${encodeURIComponent(k)}="${encodeURIComponent(oauthParams[k])}"`)
      .join(', ');
  const qs = new URLSearchParams(query).toString();
  return fetch(`${baseUrl}?${qs}`, { headers: { Authorization: authHeader } });
}

function xCredentialsOrNull(): XCredentials | null {
  const { consumerKey, consumerSecret, accessToken, accessTokenSecret } = config.x;
  if (!consumerKey?.trim() || !accessToken?.trim()) return null;
  return {
    consumerKey,
    consumerSecret: consumerSecret || '',
    accessToken,
    accessTokenSecret: accessTokenSecret || '',
  };
}

export type XUserProfile = {
  id: string;
  username: string;
  url?: string;
  description?: string;
};

/**
 * X API v2 profile for verification (website + bio).
 */
export async function fetchXUserProfileByUsername(screenName: string): Promise<XUserProfile | null> {
  const clean = screenName.replace(/^@/, '').trim();
  if (!clean) return null;
  const credentials = xCredentialsOrNull();
  if (!credentials) return null;

  const baseUrl = `${X_API_BASE}/2/users/by/username/${encodeURIComponent(clean)}`;
  try {
    const res = await oauth1aGet(
      baseUrl,
      { 'user.fields': 'id,username,url,description' },
      credentials,
    );
    if (res.status === 404) return null;
    if (!res.ok) {
      const t = await res.text().catch(() => '');
      logger.warn('X users/by/username profile failed', {
        username: clean,
        status: res.status,
        body: t.slice(0, 200),
      });
      return null;
    }
    const j = (await res.json()) as {
      data?: { id?: string; username?: string; url?: string; description?: string };
    };
    const data = j.data;
    if (!data?.id || !data.username) return null;
    return {
      id: data.id,
      username: data.username,
      url: data.url,
      description: data.description,
    };
  } catch (e: unknown) {
    logger.warn('X users/by/username profile error', {
      username: clean,
      message: e instanceof Error ? e.message : String(e),
    });
    return null;
  }
}

/**
 * X API v2 numeric user id for a screen name (same id as tweet `author_id`).
 * Used to provision Privy `custom_auth` `x:<id>` wallets — matches {@link getOrCreateWalletForUser} on the X bot.
 */
export async function fetchXUserIdByUsername(screenName: string): Promise<string | null> {
  const clean = screenName.replace(/^@/, '').trim();
  if (!clean) return null;
  const credentials = xCredentialsOrNull();
  if (!credentials) return null;

  const baseUrl = `${X_API_BASE}/2/users/by/username/${encodeURIComponent(clean)}`;
  try {
    const res = await oauth1aGet(baseUrl, { 'user.fields': 'id' }, credentials);
    if (res.status === 404) return null;
    if (!res.ok) {
      const t = await res.text().catch(() => '');
      logger.warn('X users/by/username failed', {
        username: clean,
        status: res.status,
        body: t.slice(0, 200),
      });
      return null;
    }
    const j = (await res.json()) as { data?: { id?: string } };
    const id = j.data?.id;
    return typeof id === 'string' && id.length > 0 ? id : null;
  } catch (e: unknown) {
    logger.warn('X users/by/username error', {
      username: clean,
      message: e instanceof Error ? e.message : String(e),
    });
    return null;
  }
}
