import sqlite3 from 'sqlite3';
import path from 'path';
import { fileURLToPath } from 'url';
import { mkdirSync } from 'fs';
import { getAddress } from 'viem';
import { logger } from '../logger.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const dataDir = path.join(__dirname, '../../.data');
const dbPath = path.join(dataDir, 'hood-social.db');

let db: sqlite3.Database | null = null;

export type TokenSpacePostRow = {
  id: number;
  tokenAddress: string;
  walletAddress: string;
  body: string;
  createdAt: string;
};

function run(sql: string, params: unknown[] = []): Promise<void> {
  return new Promise((resolve, reject) => {
    if (!db) {
      reject(new Error('hood-social DB not initialized'));
      return;
    }
    db.run(sql, params, (err) => (err ? reject(err) : resolve()));
  });
}

function get<T>(sql: string, params: unknown[] = []): Promise<T | undefined> {
  return new Promise((resolve, reject) => {
    if (!db) {
      reject(new Error('hood-social DB not initialized'));
      return;
    }
    db.get(sql, params, (err, row) => (err ? reject(err) : resolve(row as T | undefined)));
  });
}

function all<T>(sql: string, params: unknown[] = []): Promise<T[]> {
  return new Promise((resolve, reject) => {
    if (!db) {
      reject(new Error('hood-social DB not initialized'));
      return;
    }
    db.all(sql, params, (err, rows) => (err ? reject(err) : resolve((rows as T[]) ?? [])));
  });
}

export function initHoodSocialDb(): void {
  if (db) return;
  try {
    mkdirSync(dataDir, { recursive: true });
  } catch (err: unknown) {
    logger.warn('hoodSocialDb: failed to create .data directory:', (err as Error).message);
  }

  db = new sqlite3.Database(dbPath, (err) => {
    if (err) logger.error('hoodSocialDb: failed to open database:', err.message);
    else logger.info('Hood social DB ready:', dbPath);
  });

  db.serialize(() => {
    db!.run(
      `CREATE TABLE IF NOT EXISTS user_bankr_links (
        privy_user_id TEXT PRIMARY KEY,
        bankr_wallet TEXT NOT NULL,
        linked_at DATETIME DEFAULT CURRENT_TIMESTAMP
      )`,
    );
    db!.run(
      `CREATE INDEX IF NOT EXISTS idx_user_bankr_wallet ON user_bankr_links(bankr_wallet)`,
    );
    db!.run(
      `CREATE TABLE IF NOT EXISTS token_space_posts (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        token_address TEXT NOT NULL,
        wallet_address TEXT NOT NULL,
        body TEXT NOT NULL,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP
      )`,
    );
    db!.run(
      `CREATE INDEX IF NOT EXISTS idx_token_space_posts_token ON token_space_posts(token_address, created_at DESC)`,
    );
    db!.run(
      `CREATE TABLE IF NOT EXISTS token_page_profiles (
        token_address TEXT PRIMARY KEY,
        description TEXT NOT NULL DEFAULT '',
        website_url TEXT NOT NULL DEFAULT '',
        x_url TEXT NOT NULL DEFAULT '',
        telegram_url TEXT NOT NULL DEFAULT '',
        discord_url TEXT NOT NULL DEFAULT '',
        github_url TEXT NOT NULL DEFAULT '',
        custom_links_json TEXT NOT NULL DEFAULT '[]',
        image_url TEXT NOT NULL DEFAULT '',
        banner_url TEXT NOT NULL DEFAULT '',
        use_dex_icon INTEGER NOT NULL DEFAULT 1,
        use_dex_banner INTEGER NOT NULL DEFAULT 1,
        use_launch_image INTEGER NOT NULL DEFAULT 1,
        use_dex_links INTEGER NOT NULL DEFAULT 1,
        verified INTEGER NOT NULL DEFAULT 0,
        verified_at TEXT,
        verified_by TEXT,
        updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
      )`,
    );
    db!.run(
      `CREATE TABLE IF NOT EXISTS user_x_links (
        wallet_address TEXT PRIMARY KEY,
        x_handle TEXT NOT NULL,
        linked_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        verified_at DATETIME
      )`,
    );
    db!.run(`ALTER TABLE token_page_profiles ADD COLUMN use_dex_links INTEGER NOT NULL DEFAULT 1`, () => undefined);
    db!.run(`ALTER TABLE user_x_links ADD COLUMN verified_at DATETIME`, () => undefined);
    db!.run(
      `CREATE INDEX IF NOT EXISTS idx_user_x_handle ON user_x_links(x_handle)`,
    );
    db!.run(
      `CREATE TABLE IF NOT EXISTS user_x_link_challenges (
        wallet_address TEXT PRIMARY KEY,
        x_handle TEXT NOT NULL,
        verify_code TEXT NOT NULL,
        expires_at_ms INTEGER NOT NULL,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP
      )`,
    );
  });
}

export function closeHoodSocialDb(): void {
  if (!db) return;
  db.close();
  db = null;
}

export async function getBankrWalletForPrivyUser(privyUserId: string): Promise<string | null> {
  const row = await get<{ bankr_wallet: string }>(
    `SELECT bankr_wallet FROM user_bankr_links WHERE privy_user_id = ?`,
    [privyUserId],
  );
  if (!row?.bankr_wallet) return null;
  try {
    return getAddress(row.bankr_wallet);
  } catch {
    return null;
  }
}

export async function linkBankrWalletForPrivyUser(
  privyUserId: string,
  bankrWallet: string,
): Promise<void> {
  const wallet = getAddress(bankrWallet);
  await run(
    `INSERT INTO user_bankr_links (privy_user_id, bankr_wallet, linked_at)
     VALUES (?, ?, CURRENT_TIMESTAMP)
     ON CONFLICT(privy_user_id) DO UPDATE SET
       bankr_wallet = excluded.bankr_wallet,
       linked_at = CURRENT_TIMESTAMP`,
    [privyUserId, wallet.toLowerCase()],
  );
}

export async function unlinkBankrWalletForPrivyUser(privyUserId: string): Promise<void> {
  await run(`DELETE FROM user_bankr_links WHERE privy_user_id = ?`, [privyUserId]);
}

export type WalletLinkedAccounts = {
  xHandle: string | null;
  xLinked: boolean;
  bankrWallet: string | null;
  bankrLinked: boolean;
};

/** Public linked-account flags for a hood.markets wallet profile. */
export async function getLinkedAccountsForWallet(
  walletAddress: string,
): Promise<WalletLinkedAccounts> {
  const wallet = getAddress(walletAddress);
  const xLink = await getXLinkForWallet(wallet);
  const { webWalletDeployerId } = await import('./webWalletMessages.js');
  const sessionBankr = await getBankrWalletForPrivyUser(
    webWalletDeployerId(wallet as `0x${string}`),
  );
  const registeredBankr = await get<{ bankr_wallet: string }>(
    `SELECT bankr_wallet FROM user_bankr_links WHERE LOWER(bankr_wallet) = ?`,
    [wallet.toLowerCase()],
  );
  let bankrWallet: string | null = sessionBankr;
  if (!bankrWallet && registeredBankr?.bankr_wallet) {
    try {
      bankrWallet = getAddress(registeredBankr.bankr_wallet);
    } catch {
      bankrWallet = null;
    }
  }
  return {
    xHandle: xLink?.xHandle ?? null,
    xLinked: !!xLink?.xHandle,
    bankrWallet,
    bankrLinked: !!bankrWallet,
  };
}

export async function listTokenSpacePosts(
  tokenAddress: string,
  limit = 50,
  offset = 0,
): Promise<TokenSpacePostRow[]> {
  const token = getAddress(tokenAddress).toLowerCase();
  const rows = await all<{
    id: number;
    token_address: string;
    wallet_address: string;
    body: string;
    created_at: string;
  }>(
    `SELECT id, token_address, wallet_address, body, created_at
     FROM token_space_posts
     WHERE lower(token_address) = ?
     ORDER BY created_at DESC
     LIMIT ? OFFSET ?`,
    [token, limit, offset],
  );
  return rows.map((r) => ({
    id: r.id,
    tokenAddress: r.token_address,
    walletAddress: r.wallet_address,
    body: r.body,
    createdAt: r.created_at,
  }));
}

export async function insertTokenSpacePost(
  tokenAddress: string,
  walletAddress: string,
  body: string,
): Promise<number> {
  const token = getAddress(tokenAddress).toLowerCase();
  const wallet = getAddress(walletAddress).toLowerCase();
  const trimmed = body.trim().slice(0, 2000);
  if (!trimmed) throw new Error('Post body is empty.');
  await run(
    `INSERT INTO token_space_posts (token_address, wallet_address, body)
     VALUES (?, ?, ?)`,
    [token, wallet, trimmed],
  );
  const row = await get<{ id: number }>(`SELECT last_insert_rowid() AS id`);
  return row?.id ?? 0;
}

export async function getXHandleForWallet(walletAddress: string): Promise<string | null> {
  const link = await getXLinkForWallet(walletAddress);
  return link?.xHandle ?? null;
}

export type WalletXLink = {
  xHandle: string;
  verifiedAt: string | null;
  linkedAt: string;
};

export async function getXLinkForWallet(walletAddress: string): Promise<WalletXLink | null> {
  const wallet = getAddress(walletAddress).toLowerCase();
  const row = await get<{ x_handle: string; verified_at: string | null; linked_at: string }>(
    `SELECT x_handle, verified_at, linked_at FROM user_x_links WHERE wallet_address = ?`,
    [wallet],
  );
  if (!row?.x_handle) return null;
  return {
    xHandle: row.x_handle,
    verifiedAt: row.verified_at ?? null,
    linkedAt: row.linked_at,
  };
}

export async function linkXHandleForWallet(
  walletAddress: string,
  xHandle: string,
  verified = false,
): Promise<void> {
  const wallet = getAddress(walletAddress).toLowerCase();
  const handle = xHandle.trim().replace(/^@/, '').toLowerCase().slice(0, 64);
  if (!handle) throw new Error('xHandle is required.');
  if (verified) {
    await run(
      `INSERT INTO user_x_links (wallet_address, x_handle, linked_at, verified_at)
       VALUES (?, ?, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
       ON CONFLICT(wallet_address) DO UPDATE SET
         x_handle = excluded.x_handle,
         linked_at = CURRENT_TIMESTAMP,
         verified_at = CURRENT_TIMESTAMP`,
      [wallet, handle],
    );
    return;
  }
  await run(
    `INSERT INTO user_x_links (wallet_address, x_handle, linked_at, verified_at)
     VALUES (?, ?, CURRENT_TIMESTAMP, NULL)
     ON CONFLICT(wallet_address) DO UPDATE SET
       x_handle = excluded.x_handle,
       linked_at = CURRENT_TIMESTAMP`,
    [wallet, handle],
  );
}

export type XLinkChallengeRow = {
  xHandle: string;
  verifyCode: string;
  expiresAtMs: number;
};

export async function upsertXLinkChallenge(
  walletAddress: string,
  xHandle: string,
  verifyCode: string,
  expiresAtMs: number,
): Promise<void> {
  const wallet = getAddress(walletAddress).toLowerCase();
  const handle = xHandle.trim().replace(/^@/, '').toLowerCase().slice(0, 64);
  await run(
    `INSERT INTO user_x_link_challenges (wallet_address, x_handle, verify_code, expires_at_ms)
     VALUES (?, ?, ?, ?)
     ON CONFLICT(wallet_address) DO UPDATE SET
       x_handle = excluded.x_handle,
       verify_code = excluded.verify_code,
       expires_at_ms = excluded.expires_at_ms,
       created_at = CURRENT_TIMESTAMP`,
    [wallet, handle, verifyCode, expiresAtMs],
  );
}

export async function getXLinkChallenge(walletAddress: string): Promise<XLinkChallengeRow | null> {
  const wallet = getAddress(walletAddress).toLowerCase();
  const row = await get<{ x_handle: string; verify_code: string; expires_at_ms: number }>(
    `SELECT x_handle, verify_code, expires_at_ms FROM user_x_link_challenges WHERE wallet_address = ?`,
    [wallet],
  );
  if (!row) return null;
  if (row.expires_at_ms < Date.now()) {
    await deleteXLinkChallenge(wallet);
    return null;
  }
  return {
    xHandle: row.x_handle,
    verifyCode: row.verify_code,
    expiresAtMs: row.expires_at_ms,
  };
}

export async function deleteXLinkChallenge(walletAddress: string): Promise<void> {
  const wallet = getAddress(walletAddress).toLowerCase();
  await run(`DELETE FROM user_x_link_challenges WHERE wallet_address = ?`, [wallet]);
}

export async function unlinkXHandleForWallet(walletAddress: string): Promise<void> {
  const wallet = getAddress(walletAddress).toLowerCase();
  await run(`DELETE FROM user_x_links WHERE wallet_address = ?`, [wallet]);
}

export type TokenPageProfileRow = {
  tokenAddress: string;
  description: string;
  websiteUrl: string;
  xUrl: string;
  telegramUrl: string;
  discordUrl: string;
  githubUrl: string;
  customLinksJson: string;
  imageUrl: string;
  bannerUrl: string;
  useDexIcon: boolean;
  useDexBanner: boolean;
  useLaunchImage: boolean;
  useDexLinks: boolean;
  verified: boolean;
  verifiedAt: string | null;
  verifiedBy: string | null;
  updatedAt: string;
};

function mapTokenPageProfileRow(row: {
  token_address: string;
  description: string;
  website_url: string;
  x_url: string;
  telegram_url: string;
  discord_url: string;
  github_url: string;
  custom_links_json: string;
  image_url: string;
  banner_url: string;
  use_dex_icon: number;
  use_dex_banner: number;
  use_launch_image: number;
  use_dex_links: number;
  verified: number;
  verified_at: string | null;
  verified_by: string | null;
  updated_at: string;
}): TokenPageProfileRow {
  return {
    tokenAddress: row.token_address,
    description: row.description ?? '',
    websiteUrl: row.website_url ?? '',
    xUrl: row.x_url ?? '',
    telegramUrl: row.telegram_url ?? '',
    discordUrl: row.discord_url ?? '',
    githubUrl: row.github_url ?? '',
    customLinksJson: row.custom_links_json ?? '[]',
    imageUrl: row.image_url ?? '',
    bannerUrl: row.banner_url ?? '',
    useDexIcon: row.use_dex_icon !== 0,
    useDexBanner: row.use_dex_banner !== 0,
    useLaunchImage: row.use_launch_image !== 0,
    useDexLinks: (row.use_dex_links ?? 1) !== 0,
    verified: row.verified === 1,
    verifiedAt: row.verified_at ?? null,
    verifiedBy: row.verified_by ?? null,
    updatedAt: row.updated_at,
  };
}

export async function getTokenPageProfile(tokenAddress: string): Promise<TokenPageProfileRow | null> {
  const token = getAddress(tokenAddress).toLowerCase();
  const row = await get<Parameters<typeof mapTokenPageProfileRow>[0]>(
    `SELECT token_address, description, website_url, x_url, telegram_url, discord_url, github_url,
            custom_links_json, image_url, banner_url, use_dex_icon, use_dex_banner, use_launch_image,
            use_dex_links, verified, verified_at, verified_by, updated_at
     FROM token_page_profiles WHERE token_address = ?`,
    [token],
  );
  return row ? mapTokenPageProfileRow(row) : null;
}

export type UpsertTokenPageProfileInput = {
  description?: string;
  websiteUrl?: string;
  xUrl?: string;
  telegramUrl?: string;
  discordUrl?: string;
  githubUrl?: string;
  customLinksJson?: string;
  imageUrl?: string;
  bannerUrl?: string;
  useDexIcon?: boolean;
  useDexBanner?: boolean;
  useLaunchImage?: boolean;
  useDexLinks?: boolean;
};

export async function upsertTokenPageProfile(
  tokenAddress: string,
  patch: UpsertTokenPageProfileInput,
): Promise<void> {
  const token = getAddress(tokenAddress).toLowerCase();
  const existing = await getTokenPageProfile(tokenAddress);

  const next = {
    description: patch.description ?? existing?.description ?? '',
    websiteUrl: patch.websiteUrl ?? existing?.websiteUrl ?? '',
    xUrl: patch.xUrl ?? existing?.xUrl ?? '',
    telegramUrl: patch.telegramUrl ?? existing?.telegramUrl ?? '',
    discordUrl: patch.discordUrl ?? existing?.discordUrl ?? '',
    githubUrl: patch.githubUrl ?? existing?.githubUrl ?? '',
    customLinksJson: patch.customLinksJson ?? existing?.customLinksJson ?? '[]',
    imageUrl: patch.imageUrl ?? existing?.imageUrl ?? '',
    bannerUrl: patch.bannerUrl ?? existing?.bannerUrl ?? '',
    useDexIcon: patch.useDexIcon ?? existing?.useDexIcon ?? true,
    useDexBanner: patch.useDexBanner ?? existing?.useDexBanner ?? true,
    useLaunchImage: patch.useLaunchImage ?? existing?.useLaunchImage ?? true,
    useDexLinks: patch.useDexLinks ?? existing?.useDexLinks ?? true,
  };

  await run(
    `INSERT INTO token_page_profiles (
       token_address, description, website_url, x_url, telegram_url, discord_url, github_url,
       custom_links_json, image_url, banner_url, use_dex_icon, use_dex_banner, use_launch_image,
       use_dex_links, verified, verified_at, verified_by, updated_at
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, NULL, NULL, CURRENT_TIMESTAMP)
     ON CONFLICT(token_address) DO UPDATE SET
       description = excluded.description,
       website_url = excluded.website_url,
       x_url = excluded.x_url,
       telegram_url = excluded.telegram_url,
       discord_url = excluded.discord_url,
       github_url = excluded.github_url,
       custom_links_json = excluded.custom_links_json,
       image_url = excluded.image_url,
       banner_url = excluded.banner_url,
       use_dex_icon = excluded.use_dex_icon,
       use_dex_banner = excluded.use_dex_banner,
       use_launch_image = excluded.use_launch_image,
       use_dex_links = excluded.use_dex_links,
       updated_at = CURRENT_TIMESTAMP`,
    [
      token,
      next.description.slice(0, 2000),
      next.websiteUrl.slice(0, 512),
      next.xUrl.slice(0, 512),
      next.telegramUrl.slice(0, 512),
      next.discordUrl.slice(0, 512),
      next.githubUrl.slice(0, 512),
      next.customLinksJson.slice(0, 8000),
      next.imageUrl.slice(0, 1024),
      next.bannerUrl.slice(0, 1024),
      next.useDexIcon ? 1 : 0,
      next.useDexBanner ? 1 : 0,
      next.useLaunchImage ? 1 : 0,
      next.useDexLinks ? 1 : 0,
    ],
  );
}

export async function markTokenPageVerified(
  tokenAddress: string,
  walletAddress: string,
): Promise<void> {
  const token = getAddress(tokenAddress).toLowerCase();
  const wallet = getAddress(walletAddress).toLowerCase();
  const iso = new Date().toISOString();
  await run(
    `INSERT INTO token_page_profiles (token_address, verified, verified_at, verified_by, updated_at)
     VALUES (?, 1, ?, ?, CURRENT_TIMESTAMP)
     ON CONFLICT(token_address) DO UPDATE SET
       verified = 1,
       verified_at = excluded.verified_at,
       verified_by = excluded.verified_by,
       updated_at = CURRENT_TIMESTAMP`,
    [token, iso, wallet],
  );
}

