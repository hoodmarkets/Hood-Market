/**
 * Resolve deploy draft fields from a social/repo URL (used by POST /api/resolve-source).
 * Pulls real post/repo text and images where possible.
 */

import { config } from '../config.js';
import { extractCastImageUrl } from './farcasterCast.js';
import { extractImageUrlFromText } from './imageSources.js';
import type { NeynarClient } from '../neynar.js';

export type DeploySourceImport = {
  feeTarget: 'other';
  recipientPaste: string;
  name?: string;
  symbol?: string;
  description?: string;
  imageUrl?: string;
  sourceLabel: string;
};

function symFromSlug(s: string, maxLen: number): string {
  const t = s.replace(/[^a-zA-Z0-9]/g, '').toUpperCase();
  return (t || 'TKN').slice(0, maxLen);
}

function sanitizeTokenName(s: string, max = 64): string {
  const t = s
    .replace(/\s+/g, ' ')
    .replace(/[\u0000-\u001F\u007F]/g, '')
    .trim();
  return (t.slice(0, max) || 'Token').slice(0, max);
}

/** Words too generic for a ticker when no #hashtag. */
const SYMBOL_STOPWORDS = new Set([
  'the',
  'a',
  'an',
  'if',
  'you',
  'are',
  'is',
  'to',
  'in',
  'on',
  'at',
  'for',
  'and',
  'or',
  'from',
  'here',
  'quick',
  'update',
  'please',
  'your',
  'my',
  'this',
  'that',
  'with',
  'have',
  'has',
  'been',
  'not',
  'seeing',
  'latest',
  'version',
  'mobile',
  'app',
  'post',
  'by',
  'me',
  'we',
  'our',
  'be',
  'as',
  'it',
  'so',
  'of',
  'your',
  'seeing',
  'arent',
]);

/** Prefer first #hashtag as ticker; else longest substantive word (often the topic, e.g. Rainbow / Liquid). */
function symbolFromContent(text: string, fallbackSlug: string): string {
  const tag = text.match(/#([A-Za-z][A-Za-z0-9]{1,9})\b/);
  if (tag) return tag[1].toUpperCase().slice(0, 10);
  const deUrl = text.replace(/https?:\/\/\S+/g, ' ');
  const words = deUrl
    .replace(/@\w+/g, ' ')
    .trim()
    .split(/\s+/)
    .filter(Boolean);
  const candidates = words
    .map((w) => w.replace(/[^a-zA-Z0-9]/g, ''))
    .filter((w) => w.length >= 4 && w.length <= 14 && !SYMBOL_STOPWORDS.has(w.toLowerCase()));
  if (candidates.length > 0) {
    candidates.sort((a, b) => b.length - a.length);
    return symFromSlug(candidates[0], 10);
  }
  const slug = words.slice(0, 5).join(' ');
  return symFromSlug(slug || fallbackSlug, 10);
}

/** Strip common X oEmbed title prefixes so the text is what the tweet is about. */
function xOembedTitleToTweetText(title: string): string {
  let t = title.trim();
  const m = t.match(/^[^\n]*?\bon\s+X:\s*(.+)$/is);
  if (m?.[1]) return m[1].trim();
  const m2 = t.match(/^[^:]+:\s*["“](.+)["”]\s*$/s);
  if (m2?.[1]) return m2[1].trim();
  const m3 = t.match(/^[^:]+:\s*(.+)$/s);
  if (m3?.[1] && m3[1].trim().length > 10) return m3[1].trim();
  return t;
}

/** Decode minimal HTML entities (oEmbed &lt;p&gt; content). */
function stripHtmlToPlainText(raw: string): string {
  return raw
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/gi, "'")
    .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(parseInt(n, 10)))
    .replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCharCode(parseInt(h, 16)))
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * X oEmbed often omits useful `title`; tweet body is in `html` as <p> inside the blockquote.
 */
function extractTweetTextFromXOembedHtml(html: string): string | null {
  if (!html || typeof html !== 'string') return null;
  const chunks: string[] = [];
  const re = /<p[^>]*>([\s\S]*?)<\/p>/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(html)) !== null) {
    const plain = stripHtmlToPlainText(m[1]);
    if (plain.length > 0) chunks.push(plain);
  }
  let joined = chunks.join(' ').replace(/\s+/g, ' ').trim();
  if (joined.length < 3) {
    const bq = html.match(/<blockquote[^>]*>([\s\S]*?)<\/blockquote>/i);
    if (bq) {
      joined = stripHtmlToPlainText(bq[1]).replace(/\s+/g, ' ').trim();
    }
  }
  if (joined.length < 3) return null;
  return joined;
}

/** Remove RT/QT wrappers so the name reflects the post topic, not metadata. */
function stripSocialRepostNoise(text: string): string {
  let t = text.trim();
  t = t.replace(/^RT\s+@[\w_]{1,15}:\s*/i, '');
  t = t.replace(/^QT\s+@[\w_]{1,15}:\s*/i, '');
  return t.trim();
}

/** Drop leading @mention chains (reply prefixes) so the first line is the substance. */
function stripLeadingMentionPrefix(text: string): string {
  let t = text.trim();
  t = t.replace(/^(?:@[\w.]+\s+)+/u, '');
  return t.trim();
}

/** Title line for token name: what the tweet/cast is actually about. */
function topicTitleFromPostBody(body: string, max = 64): string {
  const core = stripLeadingMentionPrefix(stripSocialRepostNoise(body));
  let line =
    core
      .split(/\n/)
      .map((l) => l.trim())
      .find((l) => l.length > 0) || core;
  const oneLine = line.replace(/\s+/g, ' ').trim();
  const firstSentence = oneLine.match(/^(.+?[.!?])(?:\s+|$)/);
  if (
    firstSentence?.[1] &&
    firstSentence[1].length >= 12 &&
    firstSentence[1].length <= max + 24
  ) {
    line = firstSentence[1].trim();
  } else {
    line = oneLine;
  }
  return sanitizeTokenName(line, max);
}

/** First path segment on github.com that is not a username (explore, login, …). */
const GITHUB_RESERVED_TOP_SEGMENTS = new Set([
  'settings',
  'explore',
  'topics',
  'collections',
  'trending',
  'features',
  'pricing',
  'enterprise',
  'security',
  'login',
  'signup',
  'join',
  'organizations',
  'site',
  'sponsors',
  'marketplace',
  'apps',
  'account',
  'notifications',
  'search',
  'new',
  'gist',
  'git-guides',
  'readme',
  'team',
  'customer-stories',
  'solutions',
  'resources',
]);

type GithubParsedUrl =
  | { kind: 'repo'; owner: string; repo: string }
  | { kind: 'profile'; login: string };

/** Single-segment profile vs owner/repo — supports trailing slash and query (e.g. ?tab=repositories). */
function parseGithubUrlPath(raw: string): GithubParsedUrl | null {
  const normalized = normalizeHttpUrl(raw.trim());
  let u: URL;
  try {
    u = new URL(normalized);
  } catch {
    return null;
  }
  const host = u.hostname.replace(/^www\./i, '').toLowerCase();
  if (host !== 'github.com') return null;
  const parts = u.pathname.split('/').filter(Boolean);
  if (parts.length === 0) return null;
  const first = parts[0];
  if (!/^[a-zA-Z0-9](?:[a-zA-Z0-9-]){0,38}$/.test(first)) return null;
  if (GITHUB_RESERVED_TOP_SEGMENTS.has(first.toLowerCase())) return null;
  if (parts.length >= 2) {
    const repo = parts[1].replace(/\.git$/i, '');
    if (!/^[a-zA-Z0-9._-]+$/.test(repo)) return null;
    return { kind: 'repo', owner: first, repo };
  }
  return { kind: 'profile', login: first };
}

async function fetchGithubOgImage(owner: string, repo: string): Promise<string | undefined> {
  try {
    const res = await fetch(`https://github.com/${owner}/${repo}`, {
      headers: { 'User-Agent': 'LiquidLauncher/1.0 (token metadata)' },
      redirect: 'follow',
    });
    if (!res.ok) return undefined;
    const html = await res.text();
    const m = html.match(/property="og:image" content="([^"]+)"/i);
    const u = m?.[1]?.replace(/&amp;/g, '&');
    if (u?.startsWith('http')) return u;
  } catch {
    /* ignore */
  }
  return undefined;
}

async function resolveGithubRepo(url: string): Promise<DeploySourceImport | null> {
  const gh = url.match(/github\.com\/([a-zA-Z0-9](?:[a-zA-Z0-9-]){0,38})\/([a-zA-Z0-9._-]+)/i);
  if (!gh) return null;
  const owner = gh[1];
  const repo = gh[2].replace(/\.git$/i, '');
  const res = await fetch(`https://api.github.com/repos/${owner}/${repo}`, {
    headers: {
      Accept: 'application/vnd.github+json',
      'User-Agent': 'LiquidLauncher/1.0',
      ...(process.env.GITHUB_TOKEN ? { Authorization: `Bearer ${process.env.GITHUB_TOKEN}` } : {}),
    },
  });
  if (!res.ok) {
    throw new Error(res.status === 404 ? 'GitHub repo not found.' : 'Could not load GitHub repo.');
  }
  const j = (await res.json()) as {
    name: string;
    description: string | null;
    full_name: string;
    topics?: string[];
    owner: { login: string; avatar_url: string };
  };
  // Token name = what the repo is called (display name / slug, humanized) — not tags mixed into the title.
  const humanName = j.name.replace(/[-_]/g, ' ').trim();
  const name = sanitizeTokenName(humanName, 64);
  const sym = symFromSlug(j.name, 10);
  const topicLine =
    Array.isArray(j.topics) && j.topics.length
      ? `Topics: ${j.topics.slice(0, 8).join(', ')}`
      : '';
  const descParts = [
    j.description?.trim(),
    topicLine,
    j.full_name ? `github.com/${j.full_name}` : '',
  ].filter(Boolean);
  const description = descParts.join(' — ').slice(0, 500);

  const og = await fetchGithubOgImage(owner, repo);
  const imageUrl = og || j.owner.avatar_url;

  return {
    feeTarget: 'other',
    recipientPaste: `https://github.com/${owner}`,
    name,
    symbol: sym,
    description,
    imageUrl,
    sourceLabel: j.full_name,
  };
}

async function resolveGithubProfile(login: string): Promise<DeploySourceImport> {
  const res = await fetch(`https://api.github.com/users/${encodeURIComponent(login)}`, {
    headers: {
      Accept: 'application/vnd.github+json',
      'User-Agent': 'liquid-social-launcher/1.0',
      ...(process.env.GITHUB_TOKEN ? { Authorization: `Bearer ${process.env.GITHUB_TOKEN}` } : {}),
    },
  });
  if (!res.ok) {
    throw new Error(
      res.status === 404 ? 'GitHub user not found.' : 'Could not load GitHub profile.',
    );
  }
  const j = (await res.json()) as {
    login: string;
    name: string | null;
    bio: string | null;
    avatar_url: string;
    blog?: string | null;
  };
  const display = (j.name || j.login).trim();
  const name = sanitizeTokenName(display, 64);
  const sym = symFromSlug(j.login, 10);
  const descParts = [
    j.bio?.trim(),
    typeof j.blog === 'string' && j.blog.startsWith('http') ? j.blog.trim() : undefined,
    `github.com/${j.login}`,
  ].filter(Boolean);
  const description = descParts.join(' — ').slice(0, 500);
  const imageUrl =
    typeof j.avatar_url === 'string' && j.avatar_url.startsWith('http') ? j.avatar_url : undefined;

  return {
    feeTarget: 'other',
    recipientPaste: `https://github.com/${j.login}`,
    name,
    symbol: sym,
    description,
    imageUrl,
    sourceLabel: `GitHub @${j.login}`,
  };
}

async function resolveXOembed(statusUrl: string, xHandle: string): Promise<DeploySourceImport> {
  const oembed = `https://publish.twitter.com/oembed?url=${encodeURIComponent(statusUrl)}&omit_script=true&dnt=true`;
  const res = await fetch(oembed, {
    headers: { 'User-Agent': 'LiquidLauncher/1.0' },
  });
  if (!res.ok) {
    throw new Error('Could not load tweet preview (oEmbed).');
  }
  const j = (await res.json()) as {
    title?: string;
    author_name?: string;
    thumbnail_url?: string;
    html?: string;
  };
  const fromHtml = extractTweetTextFromXOembedHtml(j.html || '');
  const rawTitle = (j.title || '').trim();
  const fromTitle = rawTitle ? xOembedTitleToTweetText(rawTitle) : '';
  let tweetText: string;
  if (fromHtml && fromHtml.length >= 4) {
    tweetText = fromHtml;
  } else if (fromTitle.length >= 4) {
    tweetText = fromTitle;
  } else {
    tweetText = `Post by @${xHandle}`;
  }
  const name = topicTitleFromPostBody(tweetText, 64);
  const symbol = symbolFromContent(tweetText, xHandle);
  const description = stripLeadingMentionPrefix(stripSocialRepostNoise(tweetText)).slice(0, 500);
  let imageUrl: string | undefined =
    typeof j.thumbnail_url === 'string' && j.thumbnail_url.startsWith('http')
      ? j.thumbnail_url
      : undefined;
  if (!imageUrl) {
    imageUrl = extractImageUrlFromText(
      stripLeadingMentionPrefix(stripSocialRepostNoise(tweetText)),
    );
  }

  return {
    feeTarget: 'other',
    recipientPaste: `https://x.com/${xHandle}`,
    name,
    symbol,
    description,
    imageUrl,
    sourceLabel: `X @${xHandle}`,
  };
}

function normalizeHttpUrl(text: string): string {
  const t = text.trim();
  if (!/^https?:\/\//i.test(t)) return `https://${t}`;
  return t;
}

/** Minimal decode for og: meta content attributes */
function decodeOgContent(raw: string): string {
  return raw
    .replace(/&amp;/g, '&')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>');
}

function extractOgMeta(html: string): { title?: string; description?: string; image?: string } {
  const pick = (prop: string): string | undefined => {
    const re1 = new RegExp(
      `<meta[^>]+property=["']og:${prop}["'][^>]+content=["']([^"']*)["']`,
      'i',
    );
    const re2 = new RegExp(
      `<meta[^>]+content=["']([^"']*)["'][^>]+property=["']og:${prop}["']`,
      'i',
    );
    const m = html.match(re1) || html.match(re2);
    return m?.[1] ? decodeOgContent(m[1]) : undefined;
  };
  return {
    title: pick('title'),
    description: pick('description'),
    image: pick('image'),
  };
}

async function fetchHtmlForPreview(url: string): Promise<string> {
  const res = await fetch(url, {
    headers: { 'User-Agent': 'hoodmarkets/1.0 (deploy source preview; +https://hood.markets)' },
    redirect: 'follow',
  });
  if (!res.ok) {
    throw new Error(`Could not fetch preview page (HTTP ${res.status}).`);
  }
  return res.text();
}

const TELEGRAM_RESERVED_SEGMENTS = new Set([
  'joinchat',
  'addlist',
  'proxy',
  'socks',
  'iv',
  'share',
  'setlanguage',
  'addstickers',
  'login',
]);

function stripTelegramOgNoise(s: string): string {
  return s
    .replace(/^Telegram:\s*/i, '')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Public Telegram posts: scrape Open Graph from t.me/s/… (no bot token).
 */
async function resolveTelegramPost(username: string, messageId: string): Promise<DeploySourceImport> {
  const u = username.replace(/^@/, '').trim();
  if (!u || TELEGRAM_RESERVED_SEGMENTS.has(u.toLowerCase())) {
    throw new Error('Invalid Telegram link.');
  }
  const previewUrl = `https://t.me/s/${encodeURIComponent(u)}/${encodeURIComponent(messageId)}`;
  let html: string;
  try {
    html = await fetchHtmlForPreview(previewUrl);
  } catch {
    throw new Error(
      'Could not load that Telegram post. It may be private, deleted, or the link is wrong.',
    );
  }
  const og = extractOgMeta(html);
  const rawText = [og.title, og.description].filter(Boolean).join('\n');
  const body = stripTelegramOgNoise(rawText) || `Post in @${u}`;
  const name = topicTitleFromPostBody(body, 64);
  const symbol = symbolFromContent(body, u);
  const description = stripLeadingMentionPrefix(stripSocialRepostNoise(body)).slice(0, 500);
  const imageUrl =
    og.image?.startsWith('http') && !og.image.includes('telegram.org/img/t_logo')
      ? og.image
      : undefined;

  return {
    feeTarget: 'other',
    recipientPaste: `https://t.me/${u}`,
    name,
    symbol,
    description,
    imageUrl,
    sourceLabel: `Telegram @${u}`,
  };
}

async function resolveTelegramProfile(username: string): Promise<DeploySourceImport> {
  const u = username.replace(/^@/, '').trim();
  if (!u || TELEGRAM_RESERVED_SEGMENTS.has(u.toLowerCase())) {
    throw new Error('Invalid Telegram profile link.');
  }
  const profileUrl = `https://t.me/${encodeURIComponent(u)}`;
  let html: string;
  try {
    html = await fetchHtmlForPreview(profileUrl);
  } catch {
    throw new Error('Could not load that Telegram profile.');
  }
  const og = extractOgMeta(html);
  const body = stripTelegramOgNoise([og.title, og.description].filter(Boolean).join(' — ')) || u;
  const name = topicTitleFromPostBody(body, 64);
  const sym = symFromSlug(u, 10);
  const description = `t.me/${u} — ${stripLeadingMentionPrefix(body)}`.slice(0, 500);
  const imageUrl =
    og.image?.startsWith('http') && !og.image.includes('telegram.org/img/t_logo')
      ? og.image
      : undefined;

  return {
    feeTarget: 'other',
    recipientPaste: `https://t.me/${u}`,
    name,
    symbol: sym,
    description,
    imageUrl,
    sourceLabel: `Telegram @${u}`,
  };
}

function discordAvatarUrl(userId: string, avatarHash: string | null | undefined): string | undefined {
  if (!avatarHash) return undefined;
  const ext = avatarHash.startsWith('a_') ? 'gif' : 'png';
  return `https://cdn.discordapp.com/avatars/${userId}/${avatarHash}.${ext}?size=256`;
}

async function resolveDiscordMessage(
  channelId: string,
  messageId: string,
): Promise<DeploySourceImport> {
  const token = config.discord.token;
  if (!token) {
    throw new Error(
      'Discord message links need DISCORD_TOKEN on the API server and a bot that can read that channel.',
    );
  }
  const res = await fetch(
    `https://discord.com/api/v10/channels/${channelId}/messages/${messageId}`,
    { headers: { Authorization: `Bot ${token}` } },
  );
  if (res.status === 404) {
    throw new Error('Discord message not found, or the bot is not in that server.');
  }
  if (res.status === 403) {
    throw new Error(
      'This bot cannot read that Discord message. Give it access to the channel (View channel, Read message history), then try again.',
    );
  }
  if (!res.ok) {
    throw new Error('Could not load Discord message.');
  }
  const msg = (await res.json()) as {
    content?: string;
    author?: {
      id?: string;
      username?: string;
      global_name?: string | null;
      avatar?: string | null;
    };
    attachments?: { url?: string; content_type?: string | null }[];
    embeds?: {
      title?: string;
      description?: string;
      image?: { url?: string };
      thumbnail?: { url?: string };
    }[];
  };
  const author = msg.author;
  const authorId = author?.id;
  const authorHandle = author?.username || 'user';
  if (!authorId) {
    throw new Error('Could not read message author from Discord.');
  }

  let textBody = (msg.content || '').trim();
  if (!textBody && Array.isArray(msg.embeds) && msg.embeds.length > 0) {
    const e = msg.embeds[0];
    textBody = [e.title, e.description].filter((x) => typeof x === 'string' && x.trim()).join(' — ');
  }
  const displayName = (author?.global_name || authorHandle).trim();
  const fallbackBody = textBody || `Post by ${displayName}`;
  const name = textBody
    ? topicTitleFromPostBody(fallbackBody, 64)
    : sanitizeTokenName(displayName, 64);
  const symbol = symbolFromContent(fallbackBody, authorHandle);
  const description = stripLeadingMentionPrefix(stripSocialRepostNoise(fallbackBody)).slice(0, 500);

  let imageUrl: string | undefined;
  const att = msg.attachments?.find(
    (a) => a.url?.startsWith('http') && (a.content_type || '').startsWith('image/'),
  );
  if (att?.url) imageUrl = att.url;
  if (!imageUrl && msg.embeds?.length) {
    const e = msg.embeds[0];
    imageUrl = e.image?.url || e.thumbnail?.url;
  }
  if (!imageUrl) {
    imageUrl = discordAvatarUrl(authorId, author?.avatar) || extractImageUrlFromText(textBody);
  }

  return {
    feeTarget: 'other',
    recipientPaste: `https://discord.com/users/${authorId}`,
    name,
    symbol,
    description,
    imageUrl,
    sourceLabel: `Discord @${authorHandle}`,
  };
}

async function resolveDiscordUserProfile(userId: string): Promise<DeploySourceImport> {
  const token = config.discord.token;
  if (!token) {
    throw new Error(
      'Discord profile links need DISCORD_TOKEN on the API server to load user info and avatars.',
    );
  }
  const res = await fetch(`https://discord.com/api/v10/users/${userId}`, {
    headers: { Authorization: `Bot ${token}` },
  });
  if (!res.ok) {
    throw new Error(
      res.status === 404
        ? 'Discord user not found.'
        : 'Could not load Discord user (check DISCORD_TOKEN).',
    );
  }
  const u = (await res.json()) as {
    id: string;
    username: string;
    global_name?: string | null;
    avatar?: string | null;
  };
  const handle = u.username;
  const display = (u.global_name || handle).trim();
  const name = sanitizeTokenName(display, 64);
  const sym = symFromSlug(handle, 10);
  const imageUrl = discordAvatarUrl(u.id, u.avatar);
  return {
    feeTarget: 'other',
    recipientPaste: `https://discord.com/users/${u.id}`,
    name,
    symbol: sym,
    description: `Discord @${handle}`.slice(0, 500),
    imageUrl,
    sourceLabel: `Discord @${handle}`,
  };
}

async function lookUpCastByWarpcastUrl(warpcastUrl: string): Promise<{
  text: string;
  embeds: unknown[];
  author: { username: string; pfp_url?: string };
} | null> {
  const canonical = normalizeHttpUrl(warpcastUrl);
  const u = new URL('https://api.neynar.com/v2/farcaster/cast/');
  u.searchParams.set('identifier', canonical);
  u.searchParams.set('type', 'url');
  const res = await fetch(u.toString(), {
    headers: {
      'x-api-key': config.neynar.apiKey,
      'x-neynar-experimental': 'true',
    },
  });
  if (!res.ok) return null;
  const data = (await res.json()) as { cast?: any; result?: { cast?: any } };
  const c = data.cast ?? data.result?.cast;
  if (!c) return null;
  return {
    text: typeof c.text === 'string' ? c.text : '',
    embeds: Array.isArray(c.embeds) ? c.embeds : [],
    author: {
      username: typeof c.author?.username === 'string' ? c.author.username : '',
      pfp_url:
        typeof c.author?.pfp_url === 'string' && c.author.pfp_url.startsWith('http')
          ? c.author.pfp_url
          : undefined,
    },
  };
}

async function resolveFarcasterCast(warpcastUrl: string): Promise<DeploySourceImport | null> {
  const cast = await lookUpCastByWarpcastUrl(warpcastUrl);
  if (!cast) return null;
  const text = cast.text.trim();
  const name = topicTitleFromPostBody(text, 64);
  const symbol = symbolFromContent(
    stripLeadingMentionPrefix(stripSocialRepostNoise(text)),
    cast.author.username || 'fc',
  );
  const description = stripLeadingMentionPrefix(stripSocialRepostNoise(text)).slice(0, 500);
  let imageUrl =
    extractCastImageUrl(cast.embeds) ||
    extractImageUrlFromText(text) ||
    cast.author.pfp_url;

  return {
    feeTarget: 'other',
    recipientPaste: `https://warpcast.com/${cast.author.username}`,
    name,
    symbol,
    description,
    imageUrl,
    sourceLabel: `Cast @${cast.author.username}`,
  };
}

export async function resolveDeploySourceFromUrl(
  rawUrl: string,
  neynar: NeynarClient,
): Promise<DeploySourceImport | null> {
  const text = rawUrl.trim();
  if (!text) return null;

  const ghPath = parseGithubUrlPath(text);
  if (ghPath?.kind === 'repo') {
    return resolveGithubRepo(text);
  }
  if (ghPath?.kind === 'profile') {
    return resolveGithubProfile(ghPath.login);
  }

  const xPost = text.match(
    /(?:twitter\.com|x\.com|mobile\.twitter\.com)\/([a-zA-Z0-9_]{1,15})\/status\/(\d+)/i,
  );
  if (xPost) {
    const user = xPost[1];
    const statusUrl = /^https?:\/\//i.test(text)
      ? text
      : `https://x.com/${xPost[1]}/status/${xPost[2]}`;
    return resolveXOembed(statusUrl, user);
  }

  const tgPost = text.match(
    /(?:https?:\/\/)?(?:t\.me|telegram\.me)\/(?:s\/)?([^/\s?#]+)\/(\d+)\/?(?:\?|#|$)/i,
  );
  if (tgPost?.[1] && tgPost[2]) {
    const handle = tgPost[1].replace(/^@/, '');
    if (!TELEGRAM_RESERVED_SEGMENTS.has(handle.toLowerCase())) {
      return resolveTelegramPost(handle, tgPost[2]);
    }
  }

  const tgProfile = text.match(
    /(?:https?:\/\/)?(?:t\.me|telegram\.me)\/([a-zA-Z][a-zA-Z0-9_]{3,})\/?(?:\?|#|$)/i,
  );
  if (tgProfile?.[1]) {
    const handle = tgProfile[1].replace(/^@/, '');
    if (!TELEGRAM_RESERVED_SEGMENTS.has(handle.toLowerCase())) {
      return resolveTelegramProfile(handle);
    }
  }

  const discordHost =
    /(?:https?:\/\/)?(?:discord(?:app)?\.com|ptb\.discord\.com|canary\.discord\.com|mobile\.discord\.com)/i;
  const discordMsg = text.match(
    new RegExp(
      `${discordHost.source}\\/channels\\/(\\d{17,20})\\/(\\d{17,20})\\/(\\d{17,20})`,
      'i',
    ),
  );
  if (discordMsg?.[1] && discordMsg[2] && discordMsg[3]) {
    return resolveDiscordMessage(discordMsg[2], discordMsg[3]);
  }

  const discordUser = text.match(
    new RegExp(
      `${discordHost.source}\\/users\\/(\\d{10,20})(?:\\/|\\?|#|$)`,
      'i',
    ),
  );
  if (discordUser?.[1]) {
    return resolveDiscordUserProfile(discordUser[1]);
  }

  if (/warpcast\.com/i.test(text)) {
    const looksLikeCast =
      /\/0x[a-fA-F0-9]{40}/i.test(text) || /warpcast\.com\/~\/casts\//i.test(text);
    if (looksLikeCast) {
      const resolved = await resolveFarcasterCast(text);
      if (resolved) return resolved;
      throw new Error('Could not load that cast. Try again or use a Warpcast profile URL.');
    }
  }

  const wcProfile = text.match(/warpcast\.com\/(?!~\/)([a-zA-Z0-9][a-zA-Z0-9-]{0,63})\/?(?:\?|#|$)/i);
  if (wcProfile) {
    const u = wcProfile[1];
    const user = await neynar.getUserByFarcasterUsername(u);
    if (!user) {
      throw new Error(`Farcaster profile @${u} not found.`);
    }
    // Profile link: name is how they present (what the profile is "about" in display name).
    const display = (user.displayName || user.username).trim();
    const name = sanitizeTokenName(display, 64);
    const symbol = symFromSlug(user.username, 10);
    return {
      feeTarget: 'other',
      recipientPaste: `https://warpcast.com/${user.username}`,
      name,
      symbol,
      description: `Farcaster @${user.username}`.slice(0, 500),
      imageUrl: user.pfpUrl,
      sourceLabel: `Warpcast @${user.username}`,
    };
  }

  return null;
}
