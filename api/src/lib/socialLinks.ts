export type CustomSocialLink = { title: string; url: string };

export type SocialLinksInput = {
  website?: string;
  x?: string;
  telegram?: string;
  discord?: string;
  github?: string;
  custom?: CustomSocialLink[];
};

const MAX_CUSTOM_LINKS = 12;
const MAX_TITLE_LEN = 40;

function trimOrEmpty(v: unknown): string {
  return typeof v === 'string' ? v.trim() : '';
}

function normalizeWebsite(raw: string): string {
  const t = raw.trim();
  if (!t) return '';
  if (/^https?:\/\//i.test(t)) return t.slice(0, 512);
  return `https://${t.replace(/^\/\//, '')}`.slice(0, 512);
}

function normalizeX(raw: string): string {
  const t = raw.trim();
  if (!t) return '';
  if (t.startsWith('@')) {
    const handle = t.replace(/^@+/, '').split(/[/?#]/)[0];
    return handle ? `https://x.com/${handle}`.slice(0, 512) : '';
  }
  if (/^https?:\/\//i.test(t)) return t.slice(0, 512);
  const handle = t.replace(/^@+/, '').split(/[/?#]/)[0];
  return handle ? `https://x.com/${handle}`.slice(0, 512) : '';
}

function normalizeGithub(raw: string): string {
  const t = raw.trim();
  if (!t) return '';
  if (/^https?:\/\//i.test(t)) return t.slice(0, 512);
  const path = t.replace(/^github\.com\/?/i, '').replace(/^@+/, '');
  return path ? `https://github.com/${path}`.slice(0, 512) : '';
}

function normalizeTelegram(raw: string): string {
  const t = raw.trim();
  if (!t) return '';
  if (/^https?:\/\//i.test(t)) return t.slice(0, 512);
  const handle = t.replace(/^@+/, '').replace(/^t\.me\/?/i, '');
  return handle ? `https://t.me/${handle}`.slice(0, 512) : '';
}

function normalizeDiscord(raw: string): string {
  const t = raw.trim();
  if (!t) return '';
  if (/^https?:\/\//i.test(t)) return t.slice(0, 512);
  if (t.startsWith('discord.gg/')) return `https://${t}`.slice(0, 512);
  const invite = t.replace(/^discord\.gg\/?/i, '');
  return invite ? `https://discord.gg/${invite}`.slice(0, 512) : '';
}

function normalizeCustomLinks(raw: unknown): CustomSocialLink[] {
  if (!Array.isArray(raw)) return [];
  const out: CustomSocialLink[] = [];
  for (const item of raw) {
    if (!item || typeof item !== 'object') continue;
    const title = trimOrEmpty((item as CustomSocialLink).title).slice(0, MAX_TITLE_LEN);
    const url = normalizeWebsite(trimOrEmpty((item as CustomSocialLink).url));
    if (!title || !url) continue;
    out.push({ title, url });
    if (out.length >= MAX_CUSTOM_LINKS) break;
  }
  return out;
}

export function normalizeSocialLinks(input: SocialLinksInput): {
  websiteUrl: string;
  xUrl: string;
  telegramUrl: string;
  discordUrl: string;
  githubUrl: string;
  customLinks: CustomSocialLink[];
} {
  return {
    websiteUrl: normalizeWebsite(trimOrEmpty(input.website)),
    xUrl: normalizeX(trimOrEmpty(input.x)),
    telegramUrl: normalizeTelegram(trimOrEmpty(input.telegram)),
    discordUrl: normalizeDiscord(trimOrEmpty(input.discord)),
    githubUrl: normalizeGithub(trimOrEmpty(input.github)),
    customLinks: normalizeCustomLinks(input.custom),
  };
}

export function parseCustomLinksJson(raw: string | null | undefined): CustomSocialLink[] {
  if (!raw?.trim()) return [];
  try {
    return normalizeCustomLinks(JSON.parse(raw));
  } catch {
    return [];
  }
}

export function isHttpsAssetUrl(raw: string): boolean {
  const t = raw.trim();
  if (!t.startsWith('https://')) return false;
  try {
    const u = new URL(t);
    return u.protocol === 'https:';
  } catch {
    return false;
  }
}
