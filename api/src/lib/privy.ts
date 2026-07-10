import { config } from '../config.js';
import { logger } from '../logger.js';
import { robinhoodAddressUrl } from './robinhoodChain.js';

export interface PrivyWallet {
  id: string;
  address: string;
  chainType: 'ethereum' | 'solana';
  createdAt: string;
}

export interface IdentityClaim {
  platform: 'discord' | 'telegram' | 'x' | 'farcaster' | 'github';
  userId: string;
  username?: string;
  /**
   * Discord only: numeric discriminator (often `"0"` on new Discord accounts).
   * Used with `username` to build Privy `discord_oauth` — must match web Discord login, not `custom_auth`.
   */
  discordDiscriminator?: string;
}

/** Privy REST API uses Basic Auth (app ID : app secret), not Bearer JWTs. */
function basicAuthHeader(): string {
  const id = config.privy.appId;
  const secret = config.privy.appSecret;
  return `Basic ${Buffer.from(`${id}:${secret}`, 'utf8').toString('base64')}`;
}

async function privyFetch(url: string, init: RequestInit = {}): Promise<Response> {
  const headers = new Headers(init.headers);
  headers.set('Authorization', basicAuthHeader());
  headers.set('privy-app-id', config.privy.appId);
  if (!headers.has('Content-Type') && init.body) {
    headers.set('Content-Type', 'application/json');
  }
  return fetch(url, { ...init, headers });
}

/** REST + SDK variants: embedded wallets are `privy` or `privy-v2`. */
function isEmbeddedWalletClientType(walletClientType: string | undefined): boolean {
  return walletClientType === 'privy' || walletClientType === 'privy-v2';
}

function walletClientTypeFromAccount(a: { wallet_client_type?: string; walletClientType?: string }): string | undefined {
  return a.wallet_client_type ?? a.walletClientType;
}

/**
 * Prefer Privy embedded EVM wallet — not the first `wallet` row (external wallets can appear first).
 * Server signing / delegation always targets the embedded wallet the user grants in the web app.
 */
function findEmbeddedEthereumFromUser(
  user: any
): { id: string | null; address: string } | null {
  const accounts = user?.linked_accounts ?? [];

  for (const a of accounts) {
    if (a?.type !== 'wallet' || a?.chain_type !== 'ethereum' || typeof a.address !== 'string') continue;
    if (!isEmbeddedWalletClientType(walletClientTypeFromAccount(a))) continue;
    return { id: a.id ?? a.wallet_id ?? null, address: a.address };
  }

  for (const a of accounts) {
    if (a?.type === 'wallet' && a?.chain_type === 'ethereum' && typeof a.address === 'string') {
      return { id: a.id ?? a.wallet_id ?? null, address: a.address };
    }
  }
  return null;
}

/**
 * Whether the given address has `delegated: true` on the Privy user record (GET /v1/users/:id).
 * Checks top-level `wallet` when present, then `linked_accounts`.
 */
export function isPrivyWalletDelegatedForAddress(userJson: unknown, walletAddress: string): boolean {
  const want = walletAddress.toLowerCase();
  const u = userJson as {
    wallet?: { address?: string; chain_type?: string; delegated?: boolean };
    linked_accounts?: Array<{
      type?: string;
      chain_type?: string;
      address?: string;
      delegated?: boolean;
    }>;
  } | null;
  if (!u) return false;

  const top = u.wallet;
  if (
    top &&
    typeof top.address === 'string' &&
    top.address.toLowerCase() === want &&
    top.chain_type === 'ethereum'
  ) {
    return Boolean(top.delegated);
  }

  for (const a of u.linked_accounts ?? []) {
    if (
      a?.type === 'wallet' &&
      a.chain_type === 'ethereum' &&
      typeof a.address === 'string' &&
      a.address.toLowerCase() === want
    ) {
      return Boolean(a.delegated);
    }
  }
  return false;
}

async function lookupTelegramUser(telegramUserId: string): Promise<any | null> {
  const res = await privyFetch(
    'https://api.privy.io/v1/users/telegram/telegram_user_id',
    {
      method: 'POST',
      body: JSON.stringify({ telegram_user_id: telegramUserId }),
    }
  );
  if (res.status === 404) return null;
  const text = await res.text();
  if (!res.ok) {
    logger.error('Privy lookup telegram user failed', { status: res.status, body: text });
    throw new Error(`Privy lookup user: ${res.status} ${text}`);
  }
  return JSON.parse(text) as any;
}

/**
 * Privy `discord_oauth` username pattern (see API): `name#0` or `name#1234`, etc.
 */
export function formatDiscordUsernameForPrivy(
  username?: string,
  discriminator?: string,
): string {
  const raw = (username || 'user').trim();
  if (raw.includes('#')) return raw.slice(0, 37);
  const d = (discriminator ?? '0').trim();
  return `${raw}#${d}`;
}

function linkedAccountsForIdentity(
  identity: IdentityClaim,
): Record<string, string>[] {
  if (identity.platform === 'telegram') {
    const acc: Record<string, string> = {
      type: 'telegram',
      telegram_user_id: identity.userId,
    };
    if (identity.username) acc.username = identity.username;
    return [acc];
  }
  if (identity.platform === 'discord') {
    return [
      {
        type: 'discord_oauth',
        subject: identity.userId,
        username: formatDiscordUsernameForPrivy(
          identity.username,
          identity.discordDiscriminator,
        ),
      },
    ];
  }
  if (identity.platform === 'github') {
    return [
      {
        type: 'github_oauth',
        subject: identity.userId,
        username: identity.username || identity.userId,
      },
    ];
  }
  return [
    {
      type: 'custom_auth',
      custom_user_id: `${identity.platform}:${identity.userId}`,
    },
  ];
}

async function lookupDiscordUserByUsername(username: string): Promise<any | null> {
  const res = await privyFetch('https://api.privy.io/v1/users/discord/username', {
    method: 'POST',
    body: JSON.stringify({ username }),
  });
  if (res.status === 404) return null;
  const text = await res.text();
  if (!res.ok) {
    logger.error('Privy lookup Discord user failed', { status: res.status, body: text, username });
    throw new Error(`Privy lookup Discord user: ${res.status} ${text}`);
  }
  return JSON.parse(text) as any;
}

/** Try Privy lookups that match how the React app stores Discord usernames. */
async function lookupDiscordUser(identity: IdentityClaim): Promise<any | null> {
  const formatted = formatDiscordUsernameForPrivy(
    identity.username,
    identity.discordDiscriminator,
  );
  const plain = identity.username?.trim();
  const candidates = [formatted];
  if (plain && !plain.includes('#') && plain !== formatted) {
    candidates.push(plain);
  }
  for (const u of candidates) {
    const user = await lookupDiscordUserByUsername(u);
    if (user) return user;
  }
  return null;
}

/**
 * Find an existing Privy user created with `custom_auth` (X, Farcaster, etc.).
 * @see https://docs.privy.io/api-reference/users/get-by-custom-auth
 */
async function lookupUserByCustomAuthId(customUserId: string): Promise<any | null> {
  if (!config.privy.enabled) return null;
  try {
    const res = await fetch('https://auth.privy.io/api/v1/users/custom_auth/id', {
      method: 'POST',
      headers: {
        Authorization: basicAuthHeader(),
        'privy-app-id': config.privy.appId,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ custom_user_id: customUserId }),
    });
    if (res.status === 404) return null;
    const text = await res.text();
    if (!res.ok) {
      logger.warn('Privy lookup custom_auth user failed', {
        status: res.status,
        body: text.slice(0, 400),
      });
      return null;
    }
    return JSON.parse(text) as any;
  } catch (e: any) {
    logger.warn('Privy lookup custom_auth user error', { message: e?.message });
    return null;
  }
}

/**
 * Users who sign in on the web with Privy "Login with Farcaster" are stored under the official
 * Farcaster linked account — not `custom_auth` `farcaster:<fid>`. Without this lookup the bot
 * resolves a different Privy user than the web session (delegation / embedded wallet mismatch).
 * @see https://docs.privy.io/api-reference/users/get-by-farcaster-id
 */
async function lookupUserByFarcasterFid(fidStr: string): Promise<any | null> {
  if (!config.privy.enabled) return null;
  const fid = Number.parseInt(fidStr, 10);
  if (!Number.isFinite(fid) || fid <= 0) return null;
  try {
    const res = await privyFetch('https://api.privy.io/v1/users/farcaster/fid', {
      method: 'POST',
      body: JSON.stringify({ fid }),
    });
    if (res.status === 404) return null;
    const text = await res.text();
    if (!res.ok) {
      logger.warn('Privy lookup Farcaster fid failed', {
        fid,
        status: res.status,
        body: text.slice(0, 400),
      });
      return null;
    }
    return JSON.parse(text) as any;
  } catch (e: any) {
    logger.warn('Privy lookup Farcaster fid error', { fid: fidStr, message: e?.message });
    return null;
  }
}

function privyCreateUserHttpError(status: number, bodyText: string): Error {
  try {
    const j = JSON.parse(bodyText) as { code?: string; error?: string };
    if (j.code === 'max_accounts_reached') {
      return new Error(
        'Privy user limit reached for this app (max_accounts_reached). Upgrade the Privy plan, free capacity in the dashboard, or use a Base 0x fee address instead of a profile link that provisions a new Privy user.',
      );
    }
  } catch {
    /* not JSON */
  }
  if (/max_accounts_reached|User limit reached/i.test(bodyText)) {
    return new Error(
      'Privy user limit reached for this app. Upgrade Privy or use a 0x fee address for recipients that are not already Privy users.',
    );
  }
  return new Error(`Privy create user: ${status} ${bodyText}`);
}

async function createPrivyUserWithEmbeddedWallet(identity: IdentityClaim): Promise<any> {
  const res = await fetch('https://auth.privy.io/api/v1/users', {
    method: 'POST',
    headers: {
      Authorization: basicAuthHeader(),
      'privy-app-id': config.privy.appId,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      linked_accounts: linkedAccountsForIdentity(identity),
      wallets: [{ chain_type: 'ethereum' }],
    }),
  });
  const text = await res.text();
  if (!res.ok) {
    logger.error('Privy create user failed', { status: res.status, body: text });
    throw privyCreateUserHttpError(res.status, text);
  }
  return JSON.parse(text) as any;
}

async function createEthereumWalletForPrivyUser(
  privyUserId: string
): Promise<{ id: string; address: string }> {
  const res = await privyFetch('https://api.privy.io/v1/wallets', {
    method: 'POST',
    body: JSON.stringify({
      chain_type: 'ethereum',
      owner: { user_id: privyUserId },
    }),
  });
  const text = await res.text();
  if (!res.ok) {
    logger.error('Privy create wallet failed', { status: res.status, body: text });
    throw new Error(`Privy create wallet: ${res.status} ${text}`);
  }
  const data = JSON.parse(text) as { id: string; address: string };
  return { id: data.id, address: data.address };
}

/** Exposed for delegated server swaps (Telegram/Discord → Privy wallet API). */
export async function resolveWalletForIdentity(identity: IdentityClaim): Promise<{
  address: string;
  walletId: string | null;
  isNew: boolean;
  /** Privy DID — same across linked X / GitHub / wallet logins when users merge accounts. */
  privyUserId: string;
}> {
  let user: any = null;

  if (identity.platform === 'telegram') {
    user = await lookupTelegramUser(identity.userId);
  }

  if (identity.platform === 'discord') {
    user = await lookupDiscordUser(identity);
  }

  if (!user && identity.platform === 'farcaster') {
    user = await lookupUserByFarcasterFid(identity.userId);
  }

  if (
    !user &&
    (identity.platform === 'x' || identity.platform === 'farcaster')
  ) {
    user = await lookupUserByCustomAuthId(`${identity.platform}:${identity.userId}`);
  }

  if (user) {
    const uid = user.id as string;
    const embedded = findEmbeddedEthereumFromUser(user);
    if (embedded) {
      return {
        address: embedded.address,
        walletId: embedded.id,
        isNew: false,
        privyUserId: uid,
      };
    }
    const w = await createEthereumWalletForPrivyUser(uid);
    return { address: w.address, walletId: w.id, isNew: false, privyUserId: uid };
  }

  try {
    user = await createPrivyUserWithEmbeddedWallet(identity);
  } catch (firstErr: any) {
    if (identity.platform === 'telegram') {
      user = await lookupTelegramUser(identity.userId);
      if (!user) throw firstErr;
    } else if (identity.platform === 'discord') {
      user = await lookupDiscordUser(identity);
      if (!user) throw firstErr;
    } else if (identity.platform === 'farcaster') {
      user = await lookupUserByFarcasterFid(identity.userId);
      if (!user) {
        user = await lookupUserByCustomAuthId(`farcaster:${identity.userId}`);
      }
      if (!user) throw firstErr;
    } else if (identity.platform === 'x') {
      user = await lookupUserByCustomAuthId(`x:${identity.userId}`);
      if (!user) throw firstErr;
    } else {
      throw firstErr;
    }
  }

  const uid = user.id as string;
  const embedded = findEmbeddedEthereumFromUser(user);
  if (embedded) {
    return {
      address: embedded.address,
      walletId: embedded.id,
      isNew: true,
      privyUserId: uid,
    };
  }

  const w = await createEthereumWalletForPrivyUser(uid);
  return { address: w.address, walletId: w.id, isNew: true, privyUserId: uid };
}

/**
 * Robinhood Chain explorer for the fee wallet address.
 * Note: `https://auth.privy.io/login?...` is not a valid route (returns 404). End users manage
 * embedded wallets through a web app using Privy's SDK; the bot only provisions the wallet via API.
 */
export function walletExplorerUrl(address: `0x${string}` | string): string {
  return robinhoodAddressUrl(address);
}

export async function getWalletAddressForIdentity(
  identity: IdentityClaim
): Promise<{
  address: string;
  claimUrl: string;
  isNew: boolean;
  privyUserId: string;
}> {
  const { address, isNew, privyUserId } = await resolveWalletForIdentity(identity);
  return {
    address,
    /** Historical field name: link to view the wallet on-chain (BaseScan), not a Privy login page. */
    claimUrl: walletExplorerUrl(address),
    isNew,
    privyUserId,
  };
}

export async function getOrCreatePrivyWallet(
  identity: IdentityClaim
): Promise<{ wallet: PrivyWallet; isNew: boolean; privyUserId: string }> {
  const { address, walletId, isNew, privyUserId } = await resolveWalletForIdentity(identity);
  return {
    wallet: {
      id: walletId ?? 'embedded',
      address,
      chainType: 'ethereum',
      createdAt: new Date().toISOString(),
    },
    isNew,
    privyUserId,
  };
}

/**
 * Privy user id for an existing custom_auth identity (X / Farcaster), if any — without creating a user.
 */
export async function fetchPrivyUserIdForCustomAuth(
  platform: 'x' | 'farcaster',
  platformUserId: string,
): Promise<string | null> {
  if (platform === 'farcaster') {
    const byFid = await lookupUserByFarcasterFid(platformUserId);
    if (typeof byFid?.id === 'string') return byFid.id;
  }
  const u = await lookupUserByCustomAuthId(`${platform}:${platformUserId}`);
  return typeof u?.id === 'string' ? u.id : null;
}

export function createIdentity(
  platform: 'discord' | 'telegram' | 'x' | 'farcaster' | 'github',
  userId: string,
  username?: string,
  discordDiscriminator?: string,
): IdentityClaim {
  return { platform, userId, username, discordDiscriminator };
}

/**
 * Short label for on-chain metadata: who initiated a web deploy (from `linked_accounts` on GET /v1/users/:id).
 * Priority: Farcaster → X → Telegram → Discord → GitHub → email.
 */
export function extractTwitterUsernameFromPrivyUser(user: unknown): string | null {
  if (!user || typeof user !== 'object') return null;
  const accounts: unknown[] = Array.isArray((user as { linked_accounts?: unknown[] }).linked_accounts)
    ? (user as { linked_accounts: unknown[] }).linked_accounts
    : [];

  const usernameFrom = (a: unknown): string | null => {
    if (!a || typeof a !== 'object') return null;
    const o = a as { username?: unknown; name?: unknown; display_name?: unknown };
    const raw = o.username ?? o.name ?? o.display_name;
    if (typeof raw !== 'string' || !raw.trim()) return null;
    return raw.trim().replace(/^@/, '');
  };

  for (const a of accounts) {
    if (!a || typeof a !== 'object') continue;
    const typ = String((a as { type?: unknown }).type ?? '').toLowerCase();
    if (typ.includes('twitter') || typ.includes('x_oauth') || typ === 'x') {
      const u = usernameFrom(a);
      if (u) return u;
    }
  }
  return null;
}

/**
 * Short label for on-chain metadata: who initiated a web deploy (from `linked_accounts` on GET /v1/users/:id).
 * Priority: Farcaster → X → Telegram → Discord → GitHub → email.
 */
export function formatWebDeployInitiatorAttribution(user: any): string {
  if (!user) return 'signed-in user';

  const accounts: any[] = Array.isArray(user.linked_accounts) ? user.linked_accounts : [];
  const candidates: { order: number; text: string }[] = [];

  const push = (order: number, text: string) => {
    if (text) candidates.push({ order, text });
  };

  const usernameFrom = (a: any): string | null => {
    const raw = a?.username ?? a?.name ?? a?.display_name;
    if (typeof raw !== 'string' || !raw.trim()) return null;
    return raw.trim().replace(/^@/, '');
  };

  for (const a of accounts) {
    if (!a?.type) continue;
    const typ = String(a.type).toLowerCase();
    if (typ === 'wallet' || typ === 'smart_wallet') continue;

    if (typ.includes('farcaster')) {
      const u = usernameFrom(a);
      if (u) push(0, `Farcaster @${u}`);
    } else if (typ.includes('twitter') || typ.includes('x_oauth') || typ === 'x') {
      const u = usernameFrom(a);
      if (u) push(1, `X @${u}`);
    } else if (typ.includes('telegram')) {
      const u = usernameFrom(a);
      if (u) push(2, `Telegram @${u}`);
    } else if (typ.includes('discord')) {
      const u = a.username ?? a.name;
      const d = a.discriminator;
      if (typeof u === 'string' && u.trim()) {
        const uname = u.trim();
        if (d !== undefined && d !== null && String(d).length > 0) {
          push(3, `Discord ${uname}#${String(d)}`);
        } else {
          push(3, `Discord @${uname.replace(/^@/, '')}`);
        }
      }
    } else if (typ.includes('github')) {
      const u = usernameFrom(a);
      if (u) push(4, `GitHub @${u}`);
    }
  }

  for (const a of accounts) {
    if (a?.type === 'email' && typeof a.address === 'string' && a.address.includes('@')) {
      push(90, `email ${a.address}`);
      break;
    }
  }

  if (candidates.length === 0) return 'signed-in user';
  candidates.sort((x, y) => x.order - y.order);
  return candidates[0].text;
}

/**
 * Catalog / API label when web deploy fees go to the signer’s embedded wallet — mirrors
 * `formatDeployedBy(web, …)` (e.g. `Web · X @handle`) instead of generic “Your Privy wallet”.
 */
export function formatSelfFeeRecipientLabelFromPrivyUser(user: any): string {
  if (!user) return 'Embedded wallet (Privy)';
  const attr = formatWebDeployInitiatorAttribution(user);
  if (attr === 'signed-in user') return 'Embedded wallet (Privy)';
  return `Web · ${attr}`;
}

/** Load full Privy user (server API) — used to read embedded wallet for the logged-in web user. */
export async function fetchPrivyUserRecordById(userId: string): Promise<any | null> {
  if (!config.privy.enabled) return null;
  const res = await privyFetch(
    `https://api.privy.io/v1/users/${encodeURIComponent(userId)}`,
  );
  if (res.status === 404) return null;
  const text = await res.text();
  if (!res.ok) {
    logger.error('Privy get user failed', { status: res.status, body: text });
    throw new Error(`Privy get user: ${res.status} ${text}`);
  }
  return JSON.parse(text) as any;
}

/** Embedded Ethereum address for a Privy user id (e.g. from access token `user_id`). */
export async function getEmbeddedEthAddressForPrivyUserId(
  userId: string,
): Promise<string | null> {
  const user = await fetchPrivyUserRecordById(userId);
  if (!user) return null;
  const embedded = findEmbeddedEthereumFromUser(user);
  return embedded?.address ?? null;
}

/**
 * Look up a Privy user by linked X/Twitter handle (no Farcaster required).
 * Only returns users who have signed in with X/Twitter to this Privy app at least once.
 * @see https://docs.privy.io/api-reference/users/get-by-twitter-username
 */
export async function lookupPrivyUserByTwitterUsername(username: string): Promise<any | null> {
  if (!config.privy.enabled) return null;
  const clean = username.replace(/^@/, '').trim();
  if (!clean) return null;
  const candidates = clean === clean.toLowerCase() ? [clean] : [clean, clean.toLowerCase()];
  for (const uname of candidates) {
    try {
      const res = await privyFetch('https://api.privy.io/v1/users/twitter/username', {
        method: 'POST',
        body: JSON.stringify({ username: uname }),
      });
      if (res.status === 404) continue;
      const text = await res.text();
      if (!res.ok) {
        logger.warn('Privy lookup Twitter username failed', {
          username: uname,
          status: res.status,
          body: text.slice(0, 400),
        });
        continue;
      }
      return JSON.parse(text) as any;
    } catch (e: unknown) {
      logger.warn('Privy lookup Twitter username error', {
        username: uname,
        message: e instanceof Error ? e.message : String(e),
      });
    }
  }
  return null;
}

/**
 * Embedded Base address for fee routing: use existing embedded wallet or create one via Privy API.
 */
export async function ensureEmbeddedEthAddressForPrivyUserRecord(user: any): Promise<string | null> {
  if (!user?.id) return null;
  const embedded = findEmbeddedEthereumFromUser(user);
  if (embedded?.address) return embedded.address;
  try {
    const w = await createEthereumWalletForPrivyUser(user.id as string);
    return w.address;
  } catch (e: unknown) {
    logger.error('ensureEmbeddedEthAddressForPrivyUserRecord failed', {
      privyUserId: user.id,
      message: e instanceof Error ? e.message : String(e),
    });
    return null;
  }
}
