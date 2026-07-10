import sqlite3 from 'sqlite3';
import path from 'path';
import { fileURLToPath } from 'url';
import { mkdirSync } from 'fs';
import { getAddress } from 'viem';
import { logger } from '../logger.js';
import { BASE_DEAD_FEE_RECIPIENT } from './deadFeeWallet.js';
import { getEasternDayRangeUtc, toSqliteUtc } from './easternDay.js';
import { notifyTelegramDeploymentFeed } from './telegramFeed.js';
import { resolveTokenImageUrl } from './tokenImageUrl.js';
import {
  catalogProductionVisibleClause,
  isDeprecatedV3CatalogPurgeComplete,
  isLegacyTestCatalogPurgeComplete,
  markDeprecatedV3CatalogPurgeComplete,
  markLegacyTestCatalogPurgeComplete,
  purgeDeprecatedV3CatalogEntries,
} from './deprecatedV3Catalog.js';
import { parseAgentMetadataJson } from './agentDeployMetadata.js';
import {
  normalizeXUsername,
  resolveRequesterXUsername,
  type DeploymentPublicExtras,
} from './requesterXUsername.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const dataDir = path.join(__dirname, '../../.data');
/** Same DB file as deploy dedup — mount `.data` as a persistent volume on Railway. */
const dbPath = path.join(dataDir, 'deploy-dedup.db');

let db: sqlite3.Database | null = null;

export function hydrateDeploymentCatalogRow<T extends DeploymentCatalogRow>(
  row: T | null | undefined,
): T | null {
  if (!row) return null;
  const fixed = resolveTokenImageUrl(row.tokenImageUrl);
  if (!fixed || fixed === row.tokenImageUrl) return row;
  return { ...row, tokenImageUrl: fixed };
}

export function hydrateDeploymentCatalogRows<T extends DeploymentCatalogRow>(rows: T[]): T[] {
  return rows.map((r) => hydrateDeploymentCatalogRow(r) as T);
}

export interface DeploymentCatalogRow {
  id: number;
  createdAt: string;
  platform: string;
  deployerId: string;
  deployerLabel: string;
  feeRecipientAddress: string;
  /** `base` | `ethereum` | `robinhood` */
  chain: string;
  /** HoodMarkets V3/V4 factory that created this token (empty on legacy rows). */
  factoryAddress?: string;
  tokenName: string;
  tokenSymbol: string;
  tokenAddress: string;
  /** Public HTTPS or IPFS gateway URL stored at deploy time (also on-chain `imageUrl`). */
  tokenImageUrl?: string;
  /** Optional hero banner for token page (Dex import or manual). */
  tokenBannerUrl?: string;
  tokenWebsiteUrl?: string;
  tokenXUrl?: string;
  tokenDescription?: string;
  poolId: string;
  transactionHash: string;
  blockNumber: string;
  /** Original post URL (e.g. Warpcast cast, X tweet) when available. */
  sourceUrl: string;
  /**
   * Human-readable fee target when not obvious from address alone (e.g. "GitHub @alice").
   * Empty for older rows or plain wallet recipients without a social label.
   */
  feeRecipientLabel: string;
  /** Total catalog rows for this platform + deployer_id (including this row). */
  deployerDeploymentCount: number;
  /** Distinct fee recipient wallets this deployer has used on this platform. */
  deployerDistinctRecipientCount: number;
  /** Catalog rows where this on-chain fee wallet receives fees (including this row). */
  feeRecipientDeploymentCount: number;
  /** Fees go to deployer’s own wallet (self) vs third-party — used for UI profile links. */
  feeToSelf?: boolean;
  /** `agent` when POST /api/deploy included clientKind=agent (automation); else `web` or omitted (legacy). */
  clientKind?: string;
  /** JSON object for agent-wallet deploys (provider, runtime, wallet kind). */
  agentMetadata?: string;
  /** ISO timestamp when WETH trading fees were first successfully claimed for this deployment (launcher-recorded). */
  feeClaimedAt?: string;
  /** BaseScan tx hash from first recorded claim (optional). */
  feeClaimTxHash?: string;
  /**
   * When listing for a logged-in user: true if this row was initiated by them
   * (`deployer_id` or `privy_user_id` matches their Privy id). Populated by listDeploymentCatalogForUser.
   */
  deployedByViewer?: boolean;
}

export interface RecordDeploymentCatalogInput {
  platform: string;
  deployerId: string;
  deployerLabel: string;
  feeRecipientAddress: string;
  tokenName: string;
  tokenSymbol: string;
  tokenAddress: string;
  poolId: string;
  transactionHash: string;
  blockNumber: bigint;
  /** Warpcast / X / etc. link to the originating post or cast. */
  sourceUrl?: string;
  /** Short UI label for who receives trading fees (web deploys). */
  feeRecipientLabel?: string;
  /** Fees to deployer’s own wallet — Telegram “deployer & fee match” topic. */
  feeToSelf?: boolean;
  /** Privy DID when known — ties Eastern-day self-fee limits across linked logins (X, web, Discord, …). */
  privyUserId?: string;
  /** Web: `agent` for API/automation deploys; default `web`. */
  clientKind?: 'web' | 'agent';
  /** JSON string (optional) — agent-wallet deploy hints. */
  agentMetadataJson?: string;
  /** Public image URL written on-chain at deploy (HTTPS or IPFS gateway). */
  tokenImageUrl?: string;
  tokenWebsiteUrl?: string;
  tokenXUrl?: string;
  tokenDescription?: string;
  /** `base` | `ethereum` | `robinhood`. */
  chain?: string;
  /** Launch factory address (V3 simple or V4 pro). */
  factoryAddress?: string;
}

const DEAD_FEE_LOWER = BASE_DEAD_FEE_RECIPIENT.toLowerCase();
const VISIBLE_CATALOG = catalogProductionVisibleClause('dc');

function visibleCatalogSql(): string {
  return VISIBLE_CATALOG.sql;
}

function visibleCatalogParam(): string {
  return VISIBLE_CATALOG.param;
}

export type SelfFeeCountKey = {
  /** When set, counts all platforms for this Privy user (linked accounts share one bucket). */
  privyUserId?: string | null;
  /** Fallback when `privyUserId` is absent — per-platform deployer id (X user id, Discord id, …). */
  platform: string;
  deployerId: string;
};

/**
 * Successful deploys in the current US Eastern day with fees to self (`fee_to_self`), excluding burn.
 * Prefer `privyUserId` when available so X + web + Discord + … share one daily bucket after linking.
 */
export async function countSelfFeeDeploymentsCurrentEasternDay(
  key: SelfFeeCountKey,
): Promise<number> {
  if (!db) return 0;
  const { start, end } = getEasternDayRangeUtc();
  const startSql = toSqliteUtc(start);
  const endSql = toSqliteUtc(end);
  const pid = key.privyUserId?.trim().slice(0, 256);
  if (pid) {
    return new Promise((resolve) => {
      db!.get(
        `SELECT COUNT(*) AS c FROM deployment_catalog
         WHERE lower(fee_recipient_address) != ?
           AND created_at >= ? AND created_at < ?
           AND fee_to_self = 1
           AND privy_user_id = ?`,
        [DEAD_FEE_LOWER, startSql, endSql, pid],
        (err, row: { c: number } | undefined) => {
          if (err) {
            logger.warn('deploymentCatalog: countSelfFee (privy) failed:', err.message);
            resolve(0);
            return;
          }
          resolve(Number(row?.c ?? 0));
        },
      );
    });
  }
  const platform = key.platform.slice(0, 64);
  const id = key.deployerId.slice(0, 256);
  return new Promise((resolve) => {
    db!.get(
      `SELECT COUNT(*) AS c FROM deployment_catalog
       WHERE platform = ?
         AND deployer_id = ?
         AND lower(fee_recipient_address) != ?
         AND created_at >= ? AND created_at < ?
         AND fee_to_self = 1`,
      [platform, id, DEAD_FEE_LOWER, startSql, endSql],
      (err, row: { c: number } | undefined) => {
        if (err) {
          logger.warn('deploymentCatalog: countSelfFee (platform) failed:', err.message);
          resolve(0);
          return;
        }
        resolve(Number(row?.c ?? 0));
      },
    );
  });
}

/**
 * Successful deploys in the current US Eastern day with fees to a **third party** (not your Privy-linked
 * self wallet): `fee_to_self = 0`, not the burn address, not `client_kind = agent`. Linked accounts share
 * one daily bucket via `privy_user_id`.
 */
export async function countOtherFeeDeploymentsCurrentEasternDay(
  key: SelfFeeCountKey,
): Promise<number> {
  if (!db) return 0;
  const { start, end } = getEasternDayRangeUtc();
  const startSql = toSqliteUtc(start);
  const endSql = toSqliteUtc(end);
  const pid = key.privyUserId?.trim().slice(0, 256);
  if (pid) {
    return new Promise((resolve) => {
      db!.get(
        `SELECT COUNT(*) AS c FROM deployment_catalog
         WHERE lower(fee_recipient_address) != ?
           AND created_at >= ? AND created_at < ?
           AND fee_to_self = 0
           AND COALESCE(client_kind, 'web') != 'agent'
           AND TRIM(COALESCE(privy_user_id, '')) != ''
           AND privy_user_id = ?`,
        [DEAD_FEE_LOWER, startSql, endSql, pid],
        (err, row: { c: number } | undefined) => {
          if (err) {
            logger.warn('deploymentCatalog: countOtherFee (privy) failed:', err.message);
            resolve(0);
            return;
          }
          resolve(Number(row?.c ?? 0));
        },
      );
    });
  }
  const platform = key.platform.slice(0, 64);
  const id = key.deployerId.slice(0, 256);
  return new Promise((resolve) => {
    db!.get(
      `SELECT COUNT(*) AS c FROM deployment_catalog
       WHERE platform = ?
         AND deployer_id = ?
         AND lower(fee_recipient_address) != ?
         AND created_at >= ? AND created_at < ?
         AND fee_to_self = 0
         AND COALESCE(client_kind, 'web') != 'agent'`,
      [platform, id, DEAD_FEE_LOWER, startSql, endSql],
      (err, row: { c: number } | undefined) => {
        if (err) {
          logger.warn('deploymentCatalog: countOtherFee (platform) failed:', err.message);
          resolve(0);
          return;
        }
        resolve(Number(row?.c ?? 0));
      },
    );
  });
}

/**
 * Successful deploys in the current US Eastern day whose **fee recipient** is this wallet (not burn).
 * Used to cap how many distinct tokens can send fees to the same address per day (web deploy).
 */
export async function countDeploymentsForFeeRecipientCurrentEasternDay(
  feeRecipientAddress: string,
): Promise<number> {
  if (!db) return 0;
  let fee: string;
  try {
    fee = getAddress(feeRecipientAddress);
  } catch {
    return 0;
  }
  if (fee.toLowerCase() === DEAD_FEE_LOWER) return 0;
  const { start, end } = getEasternDayRangeUtc();
  const startSql = toSqliteUtc(start);
  const endSql = toSqliteUtc(end);
  return new Promise((resolve) => {
    db!.get(
      `SELECT COUNT(*) AS c FROM deployment_catalog
       WHERE lower(fee_recipient_address) = lower(?)
         AND lower(fee_recipient_address) != ?
         AND created_at >= ? AND created_at < ?`,
      [fee, DEAD_FEE_LOWER, startSql, endSql],
      (err, row: { c: number } | undefined) => {
        if (err) {
          logger.warn('deploymentCatalog: count fee recipient day failed:', err.message);
          resolve(0);
          return;
        }
        resolve(Number(row?.c ?? 0));
      },
    );
  });
}

/** @deprecated Use {@link countSelfFeeDeploymentsCurrentEasternDay} — X-only legacy name. */
export async function countXSelfFeeDeploymentsCurrentEasternDay(deployerId: string): Promise<number> {
  return countSelfFeeDeploymentsCurrentEasternDay({
    privyUserId: null,
    platform: 'x',
    deployerId,
  });
}

function rollingHoursSqlMod(hours: number): string {
  const h = Math.min(Math.max(1, Math.floor(hours)), 168);
  return `-${h} hours`;
}

/**
 * Successful deploys in the last `hours` (rolling) with fees to self (`fee_to_self`), excluding burn.
 * Prefer `privyUserId` when set so linked accounts share one bucket.
 */
export async function countSelfFeeDeploymentsRollingHours(
  key: SelfFeeCountKey,
  hours: number,
): Promise<number> {
  if (!db) return 0;
  const timeMod = rollingHoursSqlMod(hours);
  const pid = key.privyUserId?.trim().slice(0, 256);
  if (pid) {
    return new Promise((resolve) => {
      db!.get(
        `SELECT COUNT(*) AS c FROM deployment_catalog
         WHERE lower(fee_recipient_address) != ?
           AND datetime(created_at) >= datetime('now', ?)
           AND fee_to_self = 1
           AND privy_user_id = ?`,
        [DEAD_FEE_LOWER, timeMod, pid],
        (err, row: { c: number } | undefined) => {
          if (err) {
            logger.warn('deploymentCatalog: countSelfFee rolling (privy) failed:', err.message);
            resolve(0);
            return;
          }
          resolve(Number(row?.c ?? 0));
        },
      );
    });
  }
  const platform = key.platform.slice(0, 64);
  const id = key.deployerId.slice(0, 256);
  return new Promise((resolve) => {
    db!.get(
      `SELECT COUNT(*) AS c FROM deployment_catalog
       WHERE platform = ?
         AND deployer_id = ?
         AND lower(fee_recipient_address) != ?
         AND datetime(created_at) >= datetime('now', ?)
         AND fee_to_self = 1`,
      [platform, id, DEAD_FEE_LOWER, timeMod],
      (err, row: { c: number } | undefined) => {
        if (err) {
          logger.warn('deploymentCatalog: countSelfFee rolling (platform) failed:', err.message);
          resolve(0);
          return;
        }
        resolve(Number(row?.c ?? 0));
      },
    );
  });
}

/**
 * All successful deploys for a deployer in the current US Eastern day (any fee_to_self).
 */
export async function countDeployerDeploymentsCurrentEasternDay(
  platform: string,
  deployerId: string,
): Promise<number> {
  if (!db) return 0;
  const { start, end } = getEasternDayRangeUtc();
  const startSql = toSqliteUtc(start);
  const endSql = toSqliteUtc(end);
  const plat = platform.slice(0, 64);
  const id = deployerId.slice(0, 256);
  return new Promise((resolve) => {
    db!.get(
      `SELECT COUNT(*) AS c FROM deployment_catalog
       WHERE platform = ?
         AND deployer_id = ?
         AND lower(fee_recipient_address) != ?
         AND created_at >= ? AND created_at < ?`,
      [plat, id, DEAD_FEE_LOWER, startSql, endSql],
      (err, row: { c: number } | undefined) => {
        if (err) {
          logger.warn('deploymentCatalog: countDeployer eastern failed:', err.message);
          resolve(0);
          return;
        }
        resolve(Number(row?.c ?? 0));
      },
    );
  });
}

/** Newest catalog row for this deployer in the current US Eastern day. */
export async function getNewestDeployerDeploymentCurrentEasternDay(
  platform: string,
  deployerId: string,
): Promise<DeploymentCatalogRow | null> {
  if (!db) return null;
  const { start, end } = getEasternDayRangeUtc();
  const startSql = toSqliteUtc(start);
  const endSql = toSqliteUtc(end);
  const plat = platform.slice(0, 64);
  const id = deployerId.slice(0, 256);
  return new Promise((resolve) => {
    db!.get(
      `SELECT ${SELECT_DEPLOYMENT_ROW}
       FROM deployment_catalog AS dc
       WHERE dc.platform = ?
         AND dc.deployer_id = ?
         AND lower(dc.fee_recipient_address) != ?
         AND dc.created_at >= ? AND dc.created_at < ?
       ORDER BY dc.created_at DESC
       LIMIT 1`,
      [plat, id, DEAD_FEE_LOWER, startSql, endSql],
      (err, row: DeploymentCatalogRow | undefined) => {
        if (err) {
          logger.warn('deploymentCatalog: newestDeployer eastern failed:', err.message);
          resolve(null);
          return;
        }
        resolve(hydrateDeploymentCatalogRow(row));
      },
    );
  });
}

/**
 * All successful deploys for a deployer in the rolling window (any fee_to_self).
 * Used for `agent:0x…` deployer ids so Bankr launches share the same rate limit as web self-fee.
 */
export async function countDeployerDeploymentsRollingHours(
  platform: string,
  deployerId: string,
  hours: number,
): Promise<number> {
  if (!db) return 0;
  const timeMod = rollingHoursSqlMod(hours);
  const plat = platform.slice(0, 64);
  const id = deployerId.slice(0, 256);
  return new Promise((resolve) => {
    db!.get(
      `SELECT COUNT(*) AS c FROM deployment_catalog
       WHERE platform = ?
         AND deployer_id = ?
         AND lower(fee_recipient_address) != ?
         AND datetime(created_at) >= datetime('now', ?)`,
      [plat, id, DEAD_FEE_LOWER, timeMod],
      (err, row: { c: number } | undefined) => {
        if (err) {
          logger.warn('deploymentCatalog: countDeployer rolling failed:', err.message);
          resolve(0);
          return;
        }
        resolve(Number(row?.c ?? 0));
      },
    );
  });
}

/**
 * Third-party fee assignments (`fee_to_self = 0`) to this wallet in the current US Eastern day.
 */
export async function countThirdPartyFeeRecipientDeploymentsCurrentEasternDay(
  feeRecipientAddress: string,
): Promise<number> {
  if (!db) return 0;
  let fee: string;
  try {
    fee = getAddress(feeRecipientAddress);
  } catch {
    return 0;
  }
  if (fee.toLowerCase() === DEAD_FEE_LOWER) return 0;
  const { start, end } = getEasternDayRangeUtc();
  const startSql = toSqliteUtc(start);
  const endSql = toSqliteUtc(end);
  return new Promise((resolve) => {
    db!.get(
      `SELECT COUNT(*) AS c FROM deployment_catalog
       WHERE lower(fee_recipient_address) = lower(?)
         AND lower(fee_recipient_address) != ?
         AND created_at >= ? AND created_at < ?
         AND fee_to_self = 0`,
      [fee, DEAD_FEE_LOWER, startSql, endSql],
      (err, row: { c: number } | undefined) => {
        if (err) {
          logger.warn('deploymentCatalog: count third-party fee wallet day failed:', err.message);
          resolve(0);
          return;
        }
        resolve(Number(row?.c ?? 0));
      },
    );
  });
}

/**
 * Third-party fee assignments (`fee_to_self = 0`) to this wallet in the rolling window — excludes burn.
 * Used to cap how often others can point launch fees at the same address.
 */
export async function countThirdPartyFeeRecipientDeploymentsRollingHours(
  feeRecipientAddress: string,
  hours: number,
): Promise<number> {
  if (!db) return 0;
  let fee: string;
  try {
    fee = getAddress(feeRecipientAddress);
  } catch {
    return 0;
  }
  if (fee.toLowerCase() === DEAD_FEE_LOWER) return 0;
  const timeMod = rollingHoursSqlMod(hours);
  return new Promise((resolve) => {
    db!.get(
      `SELECT COUNT(*) AS c FROM deployment_catalog
       WHERE lower(fee_recipient_address) = lower(?)
         AND lower(fee_recipient_address) != ?
         AND fee_to_self = 0
         AND datetime(created_at) >= datetime('now', ?)`,
      [fee, DEAD_FEE_LOWER, timeMod],
      (err, row: { c: number } | undefined) => {
        if (err) {
          logger.warn('deploymentCatalog: count third-party fee wallet rolling failed:', err.message);
          resolve(0);
          return;
        }
        resolve(Number(row?.c ?? 0));
      },
    );
  });
}

/**
 * Newest third-party catalog row for this fee wallet in the rolling window — for cooldown error text.
 */
export async function getMostRecentThirdPartyFeeRecipientDeploymentInRollingHours(
  feeRecipientAddress: string,
  hours: number,
): Promise<{ tokenAddress: string; tokenName: string; tokenSymbol: string } | null> {
  if (!db) return null;
  let fee: string;
  try {
    fee = getAddress(feeRecipientAddress);
  } catch {
    return null;
  }
  if (fee.toLowerCase() === DEAD_FEE_LOWER) return null;
  const timeMod = rollingHoursSqlMod(hours);

  return new Promise((resolve) => {
    db!.get(
      `SELECT token_address AS tokenAddress, token_name AS tokenName, token_symbol AS tokenSymbol
       FROM deployment_catalog
       WHERE lower(fee_recipient_address) = lower(?)
         AND lower(fee_recipient_address) != ?
         AND fee_to_self = 0
         AND datetime(created_at) >= datetime('now', ?)
       ORDER BY datetime(created_at) DESC
       LIMIT 1`,
      [fee, DEAD_FEE_LOWER, timeMod],
      (
        err,
        row:
          | { tokenAddress?: string; tokenName?: string; tokenSymbol?: string }
          | undefined,
      ) => {
        if (err) {
          logger.warn(
            'deploymentCatalog: third-party fee wallet recent row lookup failed:',
            err.message,
          );
          resolve(null);
          return;
        }
        const raw = row?.tokenAddress?.trim();
        if (!raw) {
          resolve(null);
          return;
        }
        try {
          const tokenAddress = getAddress(raw);
          const tokenName = (row?.tokenName ?? '').trim().slice(0, 128) || '(no name)';
          const tokenSymbol = normalizeCatalogTickerSymbol(row?.tokenSymbol ?? '') || '?';
          resolve({ tokenAddress, tokenName, tokenSymbol });
        } catch {
          resolve(null);
        }
      },
    );
  });
}

/** Idempotent init — safe to call after deployDedup init. */
export function initDeploymentCatalogDb(): void {
  if (db) return;

  try {
    mkdirSync(dataDir, { recursive: true });
  } catch (err: unknown) {
    logger.warn('deploymentCatalog: failed to create .data directory:', (err as Error).message);
  }

  db = new sqlite3.Database(dbPath, (err) => {
    if (err) {
      logger.error('deploymentCatalog: failed to open database:', err.message);
      return;
    }
    logger.info('Deployment catalog DB ready:', dbPath);
  });

  db.serialize(() => {
    db!.run(
      `CREATE TABLE IF NOT EXISTS deployment_catalog (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        platform TEXT NOT NULL,
        deployer_id TEXT NOT NULL DEFAULT '',
        deployer_label TEXT NOT NULL DEFAULT '',
        fee_recipient_address TEXT NOT NULL,
        token_name TEXT NOT NULL,
        token_symbol TEXT NOT NULL,
        token_address TEXT NOT NULL,
        pool_id TEXT NOT NULL,
        transaction_hash TEXT NOT NULL,
        block_number TEXT NOT NULL DEFAULT '',
        source_url TEXT NOT NULL DEFAULT ''
      )`,
      (err) => {
        if (err) logger.error('deployment_catalog table create failed:', err.message);
      },
    );
    db!.run(
      'CREATE INDEX IF NOT EXISTS idx_deployment_catalog_created ON deployment_catalog(created_at DESC)',
      (err) => {
        if (err) logger.error('deployment_catalog index created_at failed:', err.message);
      },
    );
    db!.run(
      'CREATE INDEX IF NOT EXISTS idx_deployment_catalog_deployer ON deployment_catalog(platform, deployer_id)',
      (err) => {
        if (err) logger.error('deployment_catalog index deployer failed:', err.message);
      },
    );
    db!.run(
      'CREATE UNIQUE INDEX IF NOT EXISTS idx_deployment_catalog_token ON deployment_catalog(token_address)',
      (err) => {
        if (err) logger.error('deployment_catalog unique token index failed:', err.message);
      },
    );
    db!.run(
      'CREATE INDEX IF NOT EXISTS idx_deployment_catalog_fee_recipient ON deployment_catalog(fee_recipient_address)',
      (err) => {
        if (err) logger.error('deployment_catalog index fee_recipient failed:', err.message);
      },
    );
    // Existing DBs created before source_url: add column (ignore if already present).
    db!.run(
      `ALTER TABLE deployment_catalog ADD COLUMN source_url TEXT NOT NULL DEFAULT ''`,
      (err) => {
        if (
          err &&
          !String(err.message).toLowerCase().includes('duplicate') &&
          !String(err.message).toLowerCase().includes('already exists')
        ) {
          logger.warn('deploymentCatalog: source_url column migration:', err.message);
        }
      },
    );
    db!.run(
      `ALTER TABLE deployment_catalog ADD COLUMN fee_recipient_label TEXT NOT NULL DEFAULT ''`,
      (err) => {
        if (
          err &&
          !String(err.message).toLowerCase().includes('duplicate') &&
          !String(err.message).toLowerCase().includes('already exists')
        ) {
          logger.warn('deploymentCatalog: fee_recipient_label column migration:', err.message);
        }
      },
    );
    db!.run(
      `ALTER TABLE deployment_catalog ADD COLUMN fee_to_self INTEGER NOT NULL DEFAULT 0`,
      (err) => {
        if (
          err &&
          !String(err.message).toLowerCase().includes('duplicate') &&
          !String(err.message).toLowerCase().includes('already exists')
        ) {
          logger.warn('deploymentCatalog: fee_to_self column migration:', err.message);
        }
      },
    );
    db!.run(
      `ALTER TABLE deployment_catalog ADD COLUMN privy_user_id TEXT NOT NULL DEFAULT ''`,
      (err) => {
        if (
          err &&
          !String(err.message).toLowerCase().includes('duplicate') &&
          !String(err.message).toLowerCase().includes('already exists')
        ) {
          logger.warn('deploymentCatalog: privy_user_id column migration:', err.message);
        }
      },
    );
    db!.run(
      `UPDATE deployment_catalog SET fee_to_self = 1
       WHERE platform = 'x' AND lower(fee_recipient_address) != ? AND fee_to_self = 0`,
      [DEAD_FEE_LOWER],
      (err) => {
        if (err) {
          logger.warn('deploymentCatalog: fee_to_self backfill for X failed:', err.message);
        }
      },
    );
    db!.run(
      `ALTER TABLE deployment_catalog ADD COLUMN client_kind TEXT NOT NULL DEFAULT 'web'`,
      (err) => {
        if (
          err &&
          !String(err.message).toLowerCase().includes('duplicate') &&
          !String(err.message).toLowerCase().includes('already exists')
        ) {
          logger.warn('deploymentCatalog: client_kind column migration:', err.message);
        }
      },
    );
    db!.run(
      `ALTER TABLE deployment_catalog ADD COLUMN agent_metadata TEXT NOT NULL DEFAULT ''`,
      (err) => {
        if (
          err &&
          !String(err.message).toLowerCase().includes('duplicate') &&
          !String(err.message).toLowerCase().includes('already exists')
        ) {
          logger.warn('deploymentCatalog: agent_metadata column migration:', err.message);
        }
      },
    );
    db!.run(
      `ALTER TABLE deployment_catalog ADD COLUMN fee_claimed_at TEXT NOT NULL DEFAULT ''`,
      (err) => {
        if (
          err &&
          !String(err.message).toLowerCase().includes('duplicate') &&
          !String(err.message).toLowerCase().includes('already exists')
        ) {
          logger.warn('deploymentCatalog: fee_claimed_at column migration:', err.message);
        }
      },
    );
    db!.run(
      `ALTER TABLE deployment_catalog ADD COLUMN fee_claim_tx_hash TEXT NOT NULL DEFAULT ''`,
      (err) => {
        if (
          err &&
          !String(err.message).toLowerCase().includes('duplicate') &&
          !String(err.message).toLowerCase().includes('already exists')
        ) {
          logger.warn('deploymentCatalog: fee_claim_tx_hash column migration:', err.message);
        }
      },
    );
    db!.run(
      `ALTER TABLE deployment_catalog ADD COLUMN chain TEXT NOT NULL DEFAULT 'base'`,
      (err) => {
        if (
          err &&
          !String(err.message).toLowerCase().includes('duplicate') &&
          !String(err.message).toLowerCase().includes('already exists')
        ) {
          logger.warn('deploymentCatalog: chain column migration:', err.message);
        }
      },
    );
    db!.run(
      `ALTER TABLE deployment_catalog ADD COLUMN token_image_url TEXT NOT NULL DEFAULT ''`,
      (err) => {
        if (
          err &&
          !String(err.message).toLowerCase().includes('duplicate') &&
          !String(err.message).toLowerCase().includes('already exists')
        ) {
          logger.warn('deploymentCatalog: token_image_url column migration:', err.message);
        }
      },
    );
    db!.run(
      `ALTER TABLE deployment_catalog ADD COLUMN token_website_url TEXT NOT NULL DEFAULT ''`,
      (err) => {
        if (
          err &&
          !String(err.message).toLowerCase().includes('duplicate') &&
          !String(err.message).toLowerCase().includes('already exists')
        ) {
          logger.warn('deploymentCatalog: token_website_url column migration:', err.message);
        }
      },
    );
    db!.run(
      `ALTER TABLE deployment_catalog ADD COLUMN token_x_url TEXT NOT NULL DEFAULT ''`,
      (err) => {
        if (
          err &&
          !String(err.message).toLowerCase().includes('duplicate') &&
          !String(err.message).toLowerCase().includes('already exists')
        ) {
          logger.warn('deploymentCatalog: token_x_url column migration:', err.message);
        }
      },
    );
    db!.run(
      `ALTER TABLE deployment_catalog ADD COLUMN token_description TEXT NOT NULL DEFAULT ''`,
      (err) => {
        if (
          err &&
          !String(err.message).toLowerCase().includes('duplicate') &&
          !String(err.message).toLowerCase().includes('already exists')
        ) {
          logger.warn('deploymentCatalog: token_description column migration:', err.message);
        }
      },
    );
    db!.run(
      `ALTER TABLE deployment_catalog ADD COLUMN token_banner_url TEXT NOT NULL DEFAULT ''`,
      (err) => {
        if (
          err &&
          !String(err.message).toLowerCase().includes('duplicate') &&
          !String(err.message).toLowerCase().includes('already exists')
        ) {
          logger.warn('deploymentCatalog: token_banner_url column migration:', err.message);
        }
      },
    );
    db!.run(
      `ALTER TABLE deployment_catalog ADD COLUMN factory_address TEXT NOT NULL DEFAULT ''`,
      (err) => {
        if (
          err &&
          !String(err.message).toLowerCase().includes('duplicate') &&
          !String(err.message).toLowerCase().includes('already exists')
        ) {
          logger.warn('deploymentCatalog: factory_address column migration:', err.message);
        }
      },
    );
    db!.run(
      `CREATE TABLE IF NOT EXISTS agent_payment_tx (
        tx_hash TEXT PRIMARY KEY NOT NULL,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP
      )`,
      (err) => {
        if (err) logger.error('agent_payment_tx table create failed:', err.message);
        else void runBackfillLaunchTweetSources();
      },
    );
  });
}

/** Known Bankr-on-X launches missing `source_url` before tweet persistence shipped. */
const BACKFILL_LAUNCH_TWEET_SOURCES: { tokenAddress: string; sourceUrl: string }[] = [
  {
    tokenAddress: '0xA04914F30eC1C3d83DF000c8cB77F136348D4C69',
    sourceUrl: 'https://x.com/Rayblancoeth/status/2072721381633016095',
  },
];

async function runBackfillLaunchTweetSources(): Promise<void> {
  for (const row of BACKFILL_LAUNCH_TWEET_SOURCES) {
    try {
      const updated = await updateDeploymentCatalogLaunchSource(row.tokenAddress, row.sourceUrl);
      if (updated) {
        logger.info('deploymentCatalog: backfilled launch tweet source', {
          tokenAddress: row.tokenAddress,
          sourceUrl: row.sourceUrl,
        });
      }
    } catch (err) {
      logger.warn('deploymentCatalog: launch tweet backfill failed', {
        tokenAddress: row.tokenAddress,
        err: err instanceof Error ? err.message : String(err),
      });
    }
  }
}

/** Reserve agent payment tx (one deploy per payment). Returns false if tx already used. */
export async function tryReserveAgentPaymentTx(txHash: string): Promise<boolean> {
  if (!db) return true;
  const h = txHash.trim().toLowerCase();
  if (!/^0x[0-9a-f]{64}$/.test(h)) return false;
  return new Promise((resolve) => {
    db!.run(
      `INSERT OR IGNORE INTO agent_payment_tx (tx_hash) VALUES (?)`,
      [h],
      function (this: { changes: number }, err: Error | null) {
        if (err) {
          logger.warn('deploymentCatalog: agent_payment_tx insert failed:', err.message);
          resolve(false);
          return;
        }
        resolve(this.changes > 0);
      },
    );
  });
}

/** If deploy fails after reserve, release so the same payment can be retried. */
export async function releaseAgentPaymentTx(txHash: string): Promise<void> {
  if (!db) return;
  const h = txHash.trim().toLowerCase();
  return new Promise((resolve) => {
    db!.run(`DELETE FROM agent_payment_tx WHERE tx_hash = ?`, [h], () => resolve());
  });
}

/**
 * Append one successful deployment for analytics / “all tokens” views.
 * Errors are logged only — never fails the deploy flow.
 */
export async function recordDeploymentCatalog(
  input: RecordDeploymentCatalogInput,
): Promise<void> {
  if (!db) {
    logger.warn('deploymentCatalog: DB not ready, skipping catalog row');
    return;
  }

  let fee: string;
  let token: string;
  try {
    fee = getAddress(input.feeRecipientAddress);
    token = getAddress(input.tokenAddress);
  } catch {
    logger.warn('deploymentCatalog: invalid address, skipping', {
      feeRecipient: input.feeRecipientAddress,
      token: input.tokenAddress,
    });
    return;
  }

  const blockNumber = input.blockNumber.toString();
  const sourceUrl = (input.sourceUrl ?? '').trim().slice(0, 1024);
  const feeRecipientLabel = (input.feeRecipientLabel ?? '').trim().slice(0, 256);
  const feeToSelf = input.feeToSelf === true ? 1 : 0;
  const privyUserId = (input.privyUserId ?? '').trim().slice(0, 256);
  const clientKind =
    input.clientKind === 'agent' ? 'agent' : 'web';
  const agentMetadata = (input.agentMetadataJson ?? '').trim().slice(0, 1024);
  const rawImage = (input.tokenImageUrl ?? '').trim().slice(0, 1024);
  const tokenImageUrl = resolveTokenImageUrl(rawImage)?.slice(0, 1024) ?? rawImage;
  const tokenWebsiteUrl = (input.tokenWebsiteUrl ?? '').trim().slice(0, 1024);
  const tokenXUrl = (input.tokenXUrl ?? '').trim().slice(0, 1024);
  const tokenDescription = (input.tokenDescription ?? '').trim().slice(0, 2000);
  const chain =
    input.chain === 'ethereum'
      ? 'ethereum'
      : input.chain === 'robinhood'
        ? 'robinhood'
        : 'base';
  let factoryAddress = '';
  if (input.factoryAddress?.trim()) {
    try {
      factoryAddress = getAddress(input.factoryAddress.trim());
    } catch {
      factoryAddress = '';
    }
  }

  return new Promise((resolve) => {
    db!.run(
      `INSERT INTO deployment_catalog (
        platform, deployer_id, deployer_label, fee_recipient_address,
        token_name, token_symbol, token_address, pool_id, transaction_hash, block_number, source_url,
        fee_recipient_label, fee_to_self, privy_user_id, client_kind, agent_metadata, chain, token_image_url,
        token_website_url, token_x_url, token_description, factory_address
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        input.platform.slice(0, 64),
        input.deployerId.slice(0, 256),
        input.deployerLabel.slice(0, 256),
        fee,
        input.tokenName.slice(0, 128),
        input.tokenSymbol.slice(0, 32),
        token,
        input.poolId,
        input.transactionHash,
        blockNumber,
        sourceUrl,
        feeRecipientLabel,
        feeToSelf,
        privyUserId,
        clientKind,
        agentMetadata,
        chain,
        tokenImageUrl,
        tokenWebsiteUrl,
        tokenXUrl,
        tokenDescription,
        factoryAddress,
      ],
      (err) => {
        if (err) {
          if (err.message.includes('UNIQUE')) {
            logger.debug('deploymentCatalog: duplicate token_address, skip');
          } else {
            logger.warn('deploymentCatalog insert failed:', err.message);
          }
          resolve();
          return;
        }
        void notifyTelegramDeploymentFeed({
          platform: input.platform.slice(0, 64),
          tokenName: input.tokenName,
          tokenSymbol: input.tokenSymbol,
          tokenAddress: token,
          feeRecipientAddress: fee,
          deployerLabel: input.deployerLabel,
          feeRecipientLabel: feeRecipientLabel || undefined,
          transactionHash: input.transactionHash,
          sourceUrl: sourceUrl || undefined,
          tokenDescription: tokenDescription || undefined,
          tokenWebsiteUrl: tokenWebsiteUrl || undefined,
          tokenXUrl: tokenXUrl || undefined,
          feeToSelf: input.feeToSelf,
          clientKind: input.clientKind,
        }).catch((e: unknown) =>
          logger.warn('Telegram deployment feed failed:', e instanceof Error ? e.message : e),
        );
        resolve();
      },
    );
  });
}

/** Record first successful WETH fee claim for this token (idempotent). */
export async function markDeploymentFeeClaimed(tokenAddress: string, txHash: string): Promise<void> {
  if (!db) return;
  let tok: string;
  try {
    tok = getAddress(tokenAddress).toLowerCase();
  } catch {
    logger.warn('markDeploymentFeeClaimed: invalid tokenAddress skipped', { tokenAddress });
    return;
  }
  const h = txHash.trim().toLowerCase();
  if (!/^0x[0-9a-f]{64}$/.test(h)) {
    logger.warn('markDeploymentFeeClaimed: invalid txHash skipped', { txHash });
    return;
  }
  const now = new Date().toISOString();
  return new Promise((resolve) => {
    db!.run(
      `UPDATE deployment_catalog
       SET fee_claimed_at = ?,
           fee_claim_tx_hash = ?
       WHERE lower(token_address) = ?`,
      [now, h, tok],
      function (this: { changes: number }, err) {
        if (err) {
          logger.warn('markDeploymentFeeClaimed DB error:', err.message);
        } else if (this.changes === 0) {
          logger.warn('markDeploymentFeeClaimed: no rows updated — token may not be in catalog', { tokenAddress });
        }
        resolve();
      },
    );
  });
}

/**
 * Set launch tweet / post URL on a catalog row (idempotent when source already set).
 * Merges `launchTweetUrl` into agent_metadata when present.
 */
export async function updateDeploymentCatalogLaunchSource(
  tokenAddress: string,
  sourceUrl: string,
): Promise<boolean> {
  if (!db) return false;
  let tok: string;
  try {
    tok = getAddress(tokenAddress).toLowerCase();
  } catch {
    return false;
  }
  const url = sourceUrl.trim().slice(0, 1024);
  if (!url) return false;

  const existing = await getDeploymentByTokenAddress(tok);
  if (!existing) return false;
  if (existing.sourceUrl?.trim()) return false;

  const meta = parseAgentMetadataJson(existing.agentMetadata) ?? {};
  meta.launchTweetUrl = url;
  const agentMetadataJson = JSON.stringify(meta).slice(0, 1024);

  return new Promise((resolve) => {
    db!.run(
      `UPDATE deployment_catalog
       SET source_url = ?, agent_metadata = ?
       WHERE lower(token_address) = ? AND TRIM(COALESCE(source_url, '')) = ''`,
      [url, agentMetadataJson, tok],
      function (this: { changes: number }, err) {
        if (err) {
          logger.warn('updateDeploymentCatalogLaunchSource failed:', err.message);
          resolve(false);
          return;
        }
        resolve(this.changes > 0);
      },
    );
  });
}

export async function updateDeploymentCatalogBranding(
  tokenAddress: string,
  patch: { tokenImageUrl?: string; tokenBannerUrl?: string },
): Promise<boolean> {
  if (!db) return false;
  let tok: string;
  try {
    tok = getAddress(tokenAddress).toLowerCase();
  } catch {
    return false;
  }

  const sets: string[] = [];
  const params: string[] = [];

  if (patch.tokenImageUrl !== undefined) {
    const image = resolveTokenImageUrl(patch.tokenImageUrl.trim())?.slice(0, 1024) ?? '';
    sets.push('token_image_url = ?');
    params.push(image);
  }
  if (patch.tokenBannerUrl !== undefined) {
    const banner = patch.tokenBannerUrl.trim().slice(0, 1024);
    sets.push('token_banner_url = ?');
    params.push(banner);
  }
  if (!sets.length) return false;

  params.push(tok);

  return new Promise((resolve) => {
    db!.run(
      `UPDATE deployment_catalog SET ${sets.join(', ')} WHERE lower(token_address) = ?`,
      params,
      function (this: { changes: number }, err) {
        if (err) {
          logger.warn('updateDeploymentCatalogBranding failed:', err.message);
          resolve(false);
          return;
        }
        resolve(this.changes > 0);
      },
    );
  });
}

export type DeploymentCatalogClaimedFilter = 'any' | 'yes' | 'no';

export async function countVisibleDeploymentCatalog(
  claimed: DeploymentCatalogClaimedFilter = 'any',
): Promise<number> {
  if (!db) return 0;

  let whereClaimed = '';
  if (claimed === 'yes') {
    whereClaimed = ' WHERE TRIM(COALESCE(dc.fee_claimed_at, \'\')) != \'\' ';
  } else if (claimed === 'no') {
    whereClaimed = ' WHERE TRIM(COALESCE(dc.fee_claimed_at, \'\')) = \'\' ';
  }
  const whereVisible =
    whereClaimed === '' ? ` WHERE 1=1${visibleCatalogSql()}` : `${whereClaimed}${visibleCatalogSql()}`;

  return new Promise((resolve) => {
    db!.get(
      `SELECT COUNT(*) AS c FROM deployment_catalog AS dc ${whereVisible}`,
      [visibleCatalogParam()],
      (err, row: { c: number } | undefined) => {
        if (err) {
          logger.warn('deploymentCatalog count failed:', err.message);
          resolve(0);
          return;
        }
        resolve(Number(row?.c ?? 0));
      },
    );
  });
}

export async function listDeploymentCatalog(
  limit = 100,
  offset = 0,
  claimed: DeploymentCatalogClaimedFilter = 'any',
): Promise<DeploymentCatalogRow[]> {
  if (!db) return [];

  const lim = Math.min(Math.max(1, limit), 500);
  const off = Math.max(0, offset);

  let whereClaimed = '';
  if (claimed === 'yes') {
    whereClaimed = ' WHERE TRIM(COALESCE(dc.fee_claimed_at, \'\')) != \'\' ';
  } else if (claimed === 'no') {
    whereClaimed = ' WHERE TRIM(COALESCE(dc.fee_claimed_at, \'\')) = \'\' ';
  }
  const whereVisible =
    whereClaimed === '' ? ` WHERE 1=1${visibleCatalogSql()}` : `${whereClaimed}${visibleCatalogSql()}`;

  return new Promise((resolve) => {
    db!.all(
      `SELECT dc.id, dc.created_at AS createdAt, dc.platform, dc.deployer_id AS deployerId, dc.deployer_label AS deployerLabel,
              dc.fee_recipient_address AS feeRecipientAddress,
              COALESCE(dc.chain, 'base') AS chain,
              COALESCE(dc.factory_address, '') AS factoryAddress,
              dc.token_name AS tokenName, dc.token_symbol AS tokenSymbol,
              COALESCE(dc.token_image_url, '') AS tokenImageUrl,
              COALESCE(dc.token_banner_url, '') AS tokenBannerUrl,
              COALESCE(dc.token_website_url, '') AS tokenWebsiteUrl,
              COALESCE(dc.token_x_url, '') AS tokenXUrl,
              COALESCE(dc.token_description, '') AS tokenDescription,
              dc.token_address AS tokenAddress, dc.pool_id AS poolId, dc.transaction_hash AS transactionHash,
              dc.block_number AS blockNumber,
              COALESCE(dc.source_url, '') AS sourceUrl,
              COALESCE(dc.fee_recipient_label, '') AS feeRecipientLabel,
              COALESCE(dc.client_kind, 'web') AS clientKind,
              COALESCE(dc.agent_metadata, '') AS agentMetadata,
              COALESCE(dc.fee_claimed_at, '') AS feeClaimedAt,
              COALESCE(dc.fee_claim_tx_hash, '') AS feeClaimTxHash,
              (dc.fee_to_self = 1) AS feeToSelf,
              (SELECT COUNT(*) FROM deployment_catalog d2
               WHERE d2.deployer_id = dc.deployer_id AND d2.platform = dc.platform) AS deployerDeploymentCount,
              (SELECT COUNT(DISTINCT d3.fee_recipient_address) FROM deployment_catalog d3
               WHERE d3.deployer_id = dc.deployer_id AND d3.platform = dc.platform) AS deployerDistinctRecipientCount,
              (SELECT COUNT(*) FROM deployment_catalog d4
               WHERE d4.fee_recipient_address = dc.fee_recipient_address) AS feeRecipientDeploymentCount
       FROM deployment_catalog AS dc
       ${whereVisible}
       ORDER BY dc.created_at DESC
       LIMIT ? OFFSET ?`,
      [visibleCatalogParam(), lim, off],
      (err, rows: DeploymentCatalogRow[]) => {
        if (err) {
          logger.warn('deploymentCatalog list failed:', err.message);
          resolve([]);
          return;
        }
        resolve(hydrateDeploymentCatalogRows(rows ?? []));
      },
    );
  });
}

/**
 * Incremental deployment feed for bots and monitors.
 * Returns rows with id > sinceId, oldest-first (ascending id).
 */
export async function listDeploymentFeedSince(
  sinceId = 0,
  limit = 50,
): Promise<DeploymentCatalogRow[]> {
  if (!db) return [];

  const cursor = Math.max(0, Math.floor(sinceId));
  const lim = Math.min(Math.max(1, limit), 100);

  return new Promise((resolve) => {
    db!.all(
      `SELECT dc.id, dc.created_at AS createdAt, dc.platform, dc.deployer_id AS deployerId, dc.deployer_label AS deployerLabel,
              dc.fee_recipient_address AS feeRecipientAddress,
              COALESCE(dc.chain, 'robinhood') AS chain,
              COALESCE(dc.factory_address, '') AS factoryAddress,
              dc.token_name AS tokenName, dc.token_symbol AS tokenSymbol,
              COALESCE(dc.token_image_url, '') AS tokenImageUrl,
              COALESCE(dc.token_banner_url, '') AS tokenBannerUrl,
              COALESCE(dc.token_website_url, '') AS tokenWebsiteUrl,
              COALESCE(dc.token_x_url, '') AS tokenXUrl,
              COALESCE(dc.token_description, '') AS tokenDescription,
              dc.token_address AS tokenAddress, dc.pool_id AS poolId, dc.transaction_hash AS transactionHash,
              dc.block_number AS blockNumber,
              COALESCE(dc.source_url, '') AS sourceUrl,
              COALESCE(dc.fee_recipient_label, '') AS feeRecipientLabel,
              COALESCE(dc.client_kind, 'web') AS clientKind,
              COALESCE(dc.agent_metadata, '') AS agentMetadata,
              COALESCE(dc.fee_claimed_at, '') AS feeClaimedAt,
              COALESCE(dc.fee_claim_tx_hash, '') AS feeClaimTxHash,
              (dc.fee_to_self = 1) AS feeToSelf,
              (SELECT COUNT(*) FROM deployment_catalog d2
               WHERE d2.deployer_id = dc.deployer_id AND d2.platform = dc.platform) AS deployerDeploymentCount,
              (SELECT COUNT(DISTINCT d3.fee_recipient_address) FROM deployment_catalog d3
               WHERE d3.deployer_id = dc.deployer_id AND d3.platform = dc.platform) AS deployerDistinctRecipientCount,
              (SELECT COUNT(*) FROM deployment_catalog d4
               WHERE d4.fee_recipient_address = dc.fee_recipient_address) AS feeRecipientDeploymentCount
       FROM deployment_catalog AS dc
       WHERE dc.id > ?${visibleCatalogSql()}
       ORDER BY dc.id ASC
       LIMIT ?`,
      [cursor, visibleCatalogParam(), lim],
      (err, rows: DeploymentCatalogRow[]) => {
        if (err) {
          logger.warn('deploymentCatalog feed failed:', err.message);
          resolve([]);
          return;
        }
        resolve(hydrateDeploymentCatalogRows(rows ?? []));
      },
    );
  });
}

/**
 * Public catalog rows where trading fees go to this wallet (on-chain fee recipient).
 * Used for wallet profile pages — does not include tokens where this wallet only deployed but sent fees elsewhere.
 */
export async function listDeploymentCatalogByFeeRecipient(
  feeRecipientAddress: string,
  limit = 100,
  offset = 0,
  claimed: DeploymentCatalogClaimedFilter = 'any',
): Promise<DeploymentCatalogRow[]> {
  if (!db) return [];
  let addr: string;
  try {
    addr = getAddress(feeRecipientAddress).toLowerCase();
  } catch {
    return [];
  }

  const lim = Math.min(Math.max(1, limit), 500);
  const off = Math.max(0, offset);

  let whereClaimed = '';
  if (claimed === 'yes') {
    whereClaimed = ' AND TRIM(COALESCE(dc.fee_claimed_at, \'\')) != \'\' ';
  } else if (claimed === 'no') {
    whereClaimed = ' AND TRIM(COALESCE(dc.fee_claimed_at, \'\')) = \'\' ';
  }

  return new Promise((resolve) => {
    db!.all(
      `SELECT dc.id, dc.created_at AS createdAt, dc.platform, dc.deployer_id AS deployerId, dc.deployer_label AS deployerLabel,
              dc.fee_recipient_address AS feeRecipientAddress,
              COALESCE(dc.chain, 'base') AS chain,
              dc.token_name AS tokenName, dc.token_symbol AS tokenSymbol,
              COALESCE(dc.token_image_url, '') AS tokenImageUrl,
              COALESCE(dc.token_banner_url, '') AS tokenBannerUrl,
              COALESCE(dc.token_website_url, '') AS tokenWebsiteUrl,
              COALESCE(dc.token_x_url, '') AS tokenXUrl,
              COALESCE(dc.token_description, '') AS tokenDescription,
              dc.token_address AS tokenAddress, dc.pool_id AS poolId, dc.transaction_hash AS transactionHash,
              dc.block_number AS blockNumber,
              COALESCE(dc.source_url, '') AS sourceUrl,
              COALESCE(dc.fee_recipient_label, '') AS feeRecipientLabel,
              COALESCE(dc.client_kind, 'web') AS clientKind,
              COALESCE(dc.agent_metadata, '') AS agentMetadata,
              COALESCE(dc.fee_claimed_at, '') AS feeClaimedAt,
              COALESCE(dc.fee_claim_tx_hash, '') AS feeClaimTxHash,
              (dc.fee_to_self = 1) AS feeToSelf,
              (SELECT COUNT(*) FROM deployment_catalog d2
               WHERE d2.deployer_id = dc.deployer_id AND d2.platform = dc.platform) AS deployerDeploymentCount,
              (SELECT COUNT(DISTINCT d3.fee_recipient_address) FROM deployment_catalog d3
               WHERE d3.deployer_id = dc.deployer_id AND d3.platform = dc.platform) AS deployerDistinctRecipientCount,
              (SELECT COUNT(*) FROM deployment_catalog d4
               WHERE d4.fee_recipient_address = dc.fee_recipient_address) AS feeRecipientDeploymentCount
       FROM deployment_catalog AS dc
       WHERE lower(dc.fee_recipient_address) = ? ${whereClaimed}${visibleCatalogSql()}
       ORDER BY dc.created_at DESC
       LIMIT ? OFFSET ?`,
      [addr, visibleCatalogParam(), lim, off],
      (err, rows: DeploymentCatalogRow[]) => {
        if (err) {
          logger.warn('deploymentCatalog listByFeeRecipient failed:', err.message);
          resolve([]);
          return;
        }
        resolve(hydrateDeploymentCatalogRows(rows ?? []));
      },
    );
  });
}

/**
 * Catalog rows for a deployer matched by platform + public handle (X @user, Farcaster, etc.).
 * Used for in-app deployer profile pages (`/p/:platform/:handle`).
 */
export async function listDeploymentCatalogByDeployerPlatformHandle(
  platform: string,
  deployerHandle: string,
  limit = 100,
  offset = 0,
  claimed: DeploymentCatalogClaimedFilter = 'any',
): Promise<DeploymentCatalogRow[]> {
  if (!db) return [];
  const plat = platform.trim().toLowerCase().slice(0, 32);
  const handle = deployerHandle.trim().replace(/^@/, '').toLowerCase().slice(0, 128);
  if (!plat || !handle) return [];

  const lim = Math.min(Math.max(1, limit), 500);
  const off = Math.max(0, offset);
  const needle = `@${handle}`;
  const normalizedLabel = handle;

  /** Web catalog stores Privy DID in `deployer_id`, not the wallet — match self-fee rows by fee wallet. */
  let webWalletAddrLower: string | null = null;
  if (plat === 'web') {
    try {
      webWalletAddrLower = getAddress(handle).toLowerCase();
    } catch {
      webWalletAddrLower = null;
    }
  }

  const webWalletClause =
    webWalletAddrLower != null
      ? ' OR (lower(dc.fee_recipient_address) = ? AND dc.fee_to_self = 1) '
      : '';

  let whereClaimed = '';
  if (claimed === 'yes') {
    whereClaimed = ' AND TRIM(COALESCE(dc.fee_claimed_at, \'\')) != \'\' ';
  } else if (claimed === 'no') {
    whereClaimed = ' AND TRIM(COALESCE(dc.fee_claimed_at, \'\')) = \'\' ';
  }

  return new Promise((resolve) => {
    db!.all(
      `SELECT dc.id, dc.created_at AS createdAt, dc.platform, dc.deployer_id AS deployerId, dc.deployer_label AS deployerLabel,
              dc.fee_recipient_address AS feeRecipientAddress,
              COALESCE(dc.chain, 'base') AS chain,
              dc.token_name AS tokenName, dc.token_symbol AS tokenSymbol,
              COALESCE(dc.token_image_url, '') AS tokenImageUrl,
              COALESCE(dc.token_banner_url, '') AS tokenBannerUrl,
              COALESCE(dc.token_website_url, '') AS tokenWebsiteUrl,
              COALESCE(dc.token_x_url, '') AS tokenXUrl,
              COALESCE(dc.token_description, '') AS tokenDescription,
              dc.token_address AS tokenAddress, dc.pool_id AS poolId, dc.transaction_hash AS transactionHash,
              dc.block_number AS blockNumber,
              COALESCE(dc.source_url, '') AS sourceUrl,
              COALESCE(dc.fee_recipient_label, '') AS feeRecipientLabel,
              COALESCE(dc.client_kind, 'web') AS clientKind,
              COALESCE(dc.agent_metadata, '') AS agentMetadata,
              COALESCE(dc.fee_claimed_at, '') AS feeClaimedAt,
              COALESCE(dc.fee_claim_tx_hash, '') AS feeClaimTxHash,
              (dc.fee_to_self = 1) AS feeToSelf,
              (SELECT COUNT(*) FROM deployment_catalog d2
               WHERE d2.deployer_id = dc.deployer_id AND d2.platform = dc.platform) AS deployerDeploymentCount,
              (SELECT COUNT(DISTINCT d3.fee_recipient_address) FROM deployment_catalog d3
               WHERE d3.deployer_id = dc.deployer_id AND d3.platform = dc.platform) AS deployerDistinctRecipientCount,
              (SELECT COUNT(*) FROM deployment_catalog d4
               WHERE d4.fee_recipient_address = dc.fee_recipient_address) AS feeRecipientDeploymentCount
       FROM deployment_catalog AS dc
       WHERE lower(dc.platform) = ?
         AND (
           instr(lower(COALESCE(dc.deployer_label, '')), ?) > 0
           OR lower(trim(replace(dc.deployer_label, '@', ''))) = ?
           OR lower(trim(dc.deployer_label)) = ?
           OR dc.deployer_id = ?
           ${webWalletClause}
         )
         ${whereClaimed}
       ORDER BY dc.created_at DESC
       LIMIT ? OFFSET ?`,
      webWalletAddrLower != null
        ? [plat, needle, normalizedLabel, needle, handle, webWalletAddrLower, lim, off]
        : [plat, needle, normalizedLabel, needle, handle, lim, off],
      (err, rows: DeploymentCatalogRow[]) => {
        if (err) {
          logger.warn('deploymentCatalog listByDeployerPlatformHandle failed:', err.message);
          resolve([]);
          return;
        }
        resolve(hydrateDeploymentCatalogRows(rows ?? []));
      },
    );
  });
}

/** Deployments initiated by this Privy user id (web + any route that records the same id). */
export async function listDeploymentCatalogByDeployer(
  deployerId: string,
  limit = 50,
  offset = 0,
): Promise<DeploymentCatalogRow[]> {
  if (!db) return [];
  const id = deployerId.trim();
  if (!id) return [];

  const lim = Math.min(Math.max(1, limit), 100);
  const off = Math.max(0, offset);

  return new Promise((resolve) => {
    db!.all(
      `SELECT dc.id, dc.created_at AS createdAt, dc.platform, dc.deployer_id AS deployerId, dc.deployer_label AS deployerLabel,
              dc.fee_recipient_address AS feeRecipientAddress,
              COALESCE(dc.chain, 'base') AS chain,
              dc.token_name AS tokenName, dc.token_symbol AS tokenSymbol,
              COALESCE(dc.token_image_url, '') AS tokenImageUrl,
              COALESCE(dc.token_banner_url, '') AS tokenBannerUrl,
              COALESCE(dc.token_website_url, '') AS tokenWebsiteUrl,
              COALESCE(dc.token_x_url, '') AS tokenXUrl,
              COALESCE(dc.token_description, '') AS tokenDescription,
              dc.token_address AS tokenAddress, dc.pool_id AS poolId, dc.transaction_hash AS transactionHash,
              dc.block_number AS blockNumber,
              COALESCE(dc.source_url, '') AS sourceUrl,
              COALESCE(dc.fee_recipient_label, '') AS feeRecipientLabel,
              COALESCE(dc.client_kind, 'web') AS clientKind,
              COALESCE(dc.agent_metadata, '') AS agentMetadata,
              COALESCE(dc.fee_claimed_at, '') AS feeClaimedAt,
              COALESCE(dc.fee_claim_tx_hash, '') AS feeClaimTxHash,
              (dc.fee_to_self = 1) AS feeToSelf,
              (SELECT COUNT(*) FROM deployment_catalog d2
               WHERE d2.deployer_id = dc.deployer_id AND d2.platform = dc.platform) AS deployerDeploymentCount,
              (SELECT COUNT(DISTINCT d3.fee_recipient_address) FROM deployment_catalog d3
               WHERE d3.deployer_id = dc.deployer_id AND d3.platform = dc.platform) AS deployerDistinctRecipientCount,
              (SELECT COUNT(*) FROM deployment_catalog d4
               WHERE d4.fee_recipient_address = dc.fee_recipient_address) AS feeRecipientDeploymentCount
       FROM deployment_catalog AS dc
       WHERE dc.deployer_id = ?
       ORDER BY dc.created_at DESC
       LIMIT ? OFFSET ?`,
      [id, lim, off],
      (err, rows: DeploymentCatalogRow[]) => {
        if (err) {
          logger.warn('deploymentCatalog list by deployer failed:', err.message);
          resolve([]);
          return;
        }
        resolve(hydrateDeploymentCatalogRows(rows ?? []));
      },
    );
  });
}

/**
 * Deployments associated with this user by any of three criteria, merged and deduplicated:
 *   1. deployer_id = privyUserId          → tokens they deployed from the website
 *   2. privy_user_id = privyUserId        → tokens deployed via social bots where their Privy ID was resolved
 *   3. fee_recipient_address = wallet     → tokens deployed FOR them by anyone (they are the fee recipient)
 */
export async function listDeploymentCatalogForUser(
  privyUserId: string,
  feeRecipientAddress: string,
  limit = 50,
  offset = 0,
): Promise<DeploymentCatalogRow[]> {
  if (!db) return [];
  const id = privyUserId.trim();
  if (!id) return [];

  const lim = Math.min(Math.max(1, limit), 100);
  const off = Math.max(0, offset);
  const addr = feeRecipientAddress.trim().toLowerCase();

  return new Promise((resolve) => {
    db!.all(
      `SELECT (CASE
                 WHEN dc.deployer_id = ? OR (TRIM(COALESCE(dc.privy_user_id, '')) != '' AND dc.privy_user_id = ?)
                 THEN 1 ELSE 0 END) AS deployedByViewer,
              dc.id, dc.created_at AS createdAt, dc.platform, dc.deployer_id AS deployerId, dc.deployer_label AS deployerLabel,
              dc.fee_recipient_address AS feeRecipientAddress,
              COALESCE(dc.chain, 'base') AS chain,
              dc.token_name AS tokenName, dc.token_symbol AS tokenSymbol,
              COALESCE(dc.token_image_url, '') AS tokenImageUrl,
              COALESCE(dc.token_banner_url, '') AS tokenBannerUrl,
              COALESCE(dc.token_website_url, '') AS tokenWebsiteUrl,
              COALESCE(dc.token_x_url, '') AS tokenXUrl,
              COALESCE(dc.token_description, '') AS tokenDescription,
              dc.token_address AS tokenAddress, dc.pool_id AS poolId, dc.transaction_hash AS transactionHash,
              dc.block_number AS blockNumber,
              COALESCE(dc.source_url, '') AS sourceUrl,
              COALESCE(dc.fee_recipient_label, '') AS feeRecipientLabel,
              COALESCE(dc.client_kind, 'web') AS clientKind,
              COALESCE(dc.agent_metadata, '') AS agentMetadata,
              COALESCE(dc.fee_claimed_at, '') AS feeClaimedAt,
              COALESCE(dc.fee_claim_tx_hash, '') AS feeClaimTxHash,
              (dc.fee_to_self = 1) AS feeToSelf,
              (SELECT COUNT(*) FROM deployment_catalog d2
               WHERE d2.deployer_id = dc.deployer_id AND d2.platform = dc.platform) AS deployerDeploymentCount,
              (SELECT COUNT(DISTINCT d3.fee_recipient_address) FROM deployment_catalog d3
               WHERE d3.deployer_id = dc.deployer_id AND d3.platform = dc.platform) AS deployerDistinctRecipientCount,
              (SELECT COUNT(*) FROM deployment_catalog d4
               WHERE d4.fee_recipient_address = dc.fee_recipient_address) AS feeRecipientDeploymentCount
       FROM deployment_catalog AS dc
       WHERE dc.deployer_id = ?
          OR (TRIM(COALESCE(dc.privy_user_id, '')) != '' AND dc.privy_user_id = ?)
          OR (? != '' AND lower(dc.fee_recipient_address) = ?)
          ${visibleCatalogSql()}
       ORDER BY dc.created_at DESC
       LIMIT ? OFFSET ?`,
      [id, id, id, id, addr, addr, visibleCatalogParam(), lim, off],
      (err, rows: (DeploymentCatalogRow & { deployedByViewer?: number })[]) => {
        if (err) {
          logger.warn('deploymentCatalog listForUser failed:', err.message);
          resolve([]);
          return;
        }
        const normalized = (rows ?? []).map((r) => ({
          ...r,
          deployedByViewer: Number(r.deployedByViewer) === 1,
        }));
        resolve(normalized);
      },
    );
  });
}

const SELECT_DEPLOYMENT_ROW = `dc.id, dc.created_at AS createdAt, dc.platform, dc.deployer_id AS deployerId, dc.deployer_label AS deployerLabel,
              dc.fee_recipient_address AS feeRecipientAddress,
              COALESCE(dc.chain, 'base') AS chain,
              COALESCE(dc.factory_address, '') AS factoryAddress,
              dc.token_name AS tokenName, dc.token_symbol AS tokenSymbol,
              COALESCE(dc.token_image_url, '') AS tokenImageUrl,
              COALESCE(dc.token_banner_url, '') AS tokenBannerUrl,
              COALESCE(dc.token_website_url, '') AS tokenWebsiteUrl,
              COALESCE(dc.token_x_url, '') AS tokenXUrl,
              COALESCE(dc.token_description, '') AS tokenDescription,
              dc.token_address AS tokenAddress, dc.pool_id AS poolId, dc.transaction_hash AS transactionHash,
              dc.block_number AS blockNumber,
              COALESCE(dc.source_url, '') AS sourceUrl,
              COALESCE(dc.fee_recipient_label, '') AS feeRecipientLabel,
              COALESCE(dc.client_kind, 'web') AS clientKind,
              COALESCE(dc.agent_metadata, '') AS agentMetadata,
              COALESCE(dc.fee_claimed_at, '') AS feeClaimedAt,
              COALESCE(dc.fee_claim_tx_hash, '') AS feeClaimTxHash,
              (dc.fee_to_self = 1) AS feeToSelf,
              (SELECT COUNT(*) FROM deployment_catalog d2
               WHERE d2.deployer_id = dc.deployer_id AND d2.platform = dc.platform) AS deployerDeploymentCount,
              (SELECT COUNT(DISTINCT d3.fee_recipient_address) FROM deployment_catalog d3
               WHERE d3.deployer_id = dc.deployer_id AND d3.platform = dc.platform) AS deployerDistinctRecipientCount,
              (SELECT COUNT(*) FROM deployment_catalog d4
               WHERE d4.fee_recipient_address = dc.fee_recipient_address) AS feeRecipientDeploymentCount`;

/** One deployment for this catalog deployer id (e.g. Privy user id on web) and token contract. */
export async function getDeploymentByDeployerAndTokenAddress(
  deployerId: string,
  tokenAddress: string,
): Promise<DeploymentCatalogRow | null> {
  if (!db) return null;
  const id = deployerId.trim().slice(0, 256);
  let tok: string;
  try {
    tok = getAddress(tokenAddress).toLowerCase();
  } catch {
    return null;
  }
  if (!id) return null;

  return new Promise((resolve) => {
    db!.get(
      `SELECT ${SELECT_DEPLOYMENT_ROW}
       FROM deployment_catalog AS dc
       WHERE dc.deployer_id = ? AND lower(dc.token_address) = ?
       LIMIT 1`,
      [id, tok],
      (err, row: DeploymentCatalogRow | undefined) => {
        if (err) {
          logger.warn('deploymentCatalog get by deployer+token failed:', err.message);
          resolve(null);
          return;
        }
        resolve(hydrateDeploymentCatalogRow(row));
      },
    );
  });
}

/**
 * Whether this Privy user already recorded a third-party fee deploy (same ticker + fee wallet) within the window.
 * Excludes burn / dead fee recipient. Used by web deploy to return a clear message instead of a generic dedup error.
 */
export async function hasRecentThirdPartyFeeDeployForSymbol(
  privyUserId: string,
  feeRecipientAddress: string,
  tokenSymbol: string,
  withinHours = 24,
): Promise<boolean> {
  if (!db) return false;
  const pid = privyUserId.trim();
  if (!pid) return false;
  let fee: string;
  try {
    fee = getAddress(feeRecipientAddress).toLowerCase();
  } catch {
    return false;
  }
  if (fee === DEAD_FEE_LOWER) return false;
  const sym = tokenSymbol.trim().replace(/^\$/u, '').toUpperCase();
  if (!sym) return false;
  const hours = Math.min(Math.max(1, Math.floor(withinHours)), 168);
  const timeMod = `-${hours} hours`;

  return new Promise((resolve) => {
    db!.get(
      `SELECT 1 AS ok FROM deployment_catalog
       WHERE TRIM(COALESCE(privy_user_id, '')) = ?
         AND lower(fee_recipient_address) = ?
         AND upper(trim(replace(token_symbol, '$', ''))) = ?
         AND fee_to_self = 0
         AND lower(fee_recipient_address) != ?
         AND datetime(created_at) >= datetime('now', ?)
       LIMIT 1`,
      [pid, fee, sym, DEAD_FEE_LOWER, timeMod],
      (err, row: { ok: number } | undefined) => {
        if (err) {
          logger.warn('deploymentCatalog third-party recent deploy check failed:', err.message);
          resolve(false);
          return;
        }
        resolve(row != null);
      },
    );
  });
}

/** One deployment where this fee wallet receives fees for this token contract (Liquid Launcher catalog). */
export async function getDeploymentByFeeRecipientAndTokenAddress(
  feeRecipientAddress: string,
  tokenAddress: string,
): Promise<DeploymentCatalogRow | null> {
  if (!db) return null;
  const fee = feeRecipientAddress.trim().toLowerCase();
  const tok = tokenAddress.trim().toLowerCase();
  if (!fee || !tok) return null;

  return new Promise((resolve) => {
    db!.get(
      `SELECT ${SELECT_DEPLOYMENT_ROW}
       FROM deployment_catalog AS dc
       WHERE lower(dc.fee_recipient_address) = ? AND lower(dc.token_address) = ?
       LIMIT 1`,
      [fee, tok],
      (err, row: DeploymentCatalogRow | undefined) => {
        if (err) {
          logger.warn('deploymentCatalog get by fee+token failed:', err.message);
          resolve(null);
          return;
        }
        resolve(hydrateDeploymentCatalogRow(row));
      },
    );
  });
}

/** Newest catalog row for a ticker symbol (global, any fee recipient). */
export async function getNewestDeploymentByTickerSymbol(
  tokenSymbol: string,
): Promise<DeploymentCatalogRow | null> {
  if (!db) return null;
  const sym = normalizeCatalogTickerSymbol(tokenSymbol);
  if (!sym) return null;

  return new Promise((resolve) => {
    db!.get(
      `SELECT ${SELECT_DEPLOYMENT_ROW}
       FROM deployment_catalog AS dc
       WHERE upper(trim(replace(dc.token_symbol, '$', ''))) = ?${visibleCatalogSql()}
       ORDER BY datetime(dc.created_at) DESC
       LIMIT 1`,
      [sym, visibleCatalogParam()],
      (err, row: DeploymentCatalogRow | undefined) => {
        if (err) {
          logger.warn('deploymentCatalog get by ticker failed:', err.message);
          resolve(null);
          return;
        }
        resolve(hydrateDeploymentCatalogRow(row));
      },
    );
  });
}

/** Lookup by deploy tx hash — used to finalize wallet deploy idempotently after on-chain success. */
export async function getDeploymentByTransactionHash(
  transactionHash: string,
): Promise<DeploymentCatalogRow | null> {
  if (!db) return null;
  const tx = transactionHash.trim().toLowerCase();
  if (!/^0x[a-f0-9]{64}$/.test(tx)) return null;
  return new Promise((resolve) => {
    db!.get(
      `SELECT ${SELECT_DEPLOYMENT_ROW}
       FROM deployment_catalog AS dc
       WHERE lower(dc.transaction_hash) = ?${visibleCatalogSql()}
       LIMIT 1`,
      [tx, visibleCatalogParam()],
      (err, row: DeploymentCatalogRow | undefined) => {
        if (err) {
          logger.warn('deploymentCatalog get by tx failed:', err.message);
          resolve(null);
          return;
        }
        resolve(hydrateDeploymentCatalogRow(row));
      },
    );
  });
}

/** Tokens in catalog where this wallet receives trading fees. */
export async function countDeploymentsAsFeeRecipient(walletAddress: string): Promise<number> {
  if (!db) return 0;
  let addr: string;
  try {
    addr = getAddress(walletAddress).toLowerCase();
  } catch {
    return 0;
  }
  return new Promise((resolve) => {
    db!.get(
      `SELECT COUNT(*) AS n FROM deployment_catalog AS dc
       WHERE lower(dc.fee_recipient_address) = ?${visibleCatalogSql()}`,
      [addr, visibleCatalogParam()],
      (err, row: { n?: number } | undefined) => {
        if (err) {
          logger.warn('countDeploymentsAsFeeRecipient failed:', err.message);
          resolve(0);
          return;
        }
        resolve(typeof row?.n === 'number' ? row.n : 0);
      },
    );
  });
}

/** Server-side launches initiated from an agent wallet (`deployer_id = agent:0x…`). */
export async function countDeploymentsByAgentWallet(walletAddress: string): Promise<number> {
  if (!db) return 0;
  let dep: string;
  try {
    dep = `agent:${getAddress(walletAddress)}`;
  } catch {
    return 0;
  }
  return new Promise((resolve) => {
    db!.get(
      `SELECT COUNT(*) AS n FROM deployment_catalog AS dc
       WHERE dc.deployer_id = ?${visibleCatalogSql()}`,
      [dep, visibleCatalogParam()],
      (err, row: { n?: number } | undefined) => {
        if (err) {
          logger.warn('countDeploymentsByAgentWallet failed:', err.message);
          resolve(0);
          return;
        }
        resolve(typeof row?.n === 'number' ? row.n : 0);
      },
    );
  });
}

type PrivyCatalogRow = DeploymentCatalogRow & { privyUserId: string };

function mergeDeploymentsByTokenAddress(
  ...groups: DeploymentCatalogRow[][]
): DeploymentCatalogRow[] {
  const seen = new Set<string>();
  const out: DeploymentCatalogRow[] = [];
  for (const group of groups) {
    for (const row of group) {
      const key = row.tokenAddress.toLowerCase();
      if (seen.has(key)) continue;
      seen.add(key);
      out.push(row);
    }
  }
  out.sort((a, b) => (a.createdAt < b.createdAt ? 1 : a.createdAt > b.createdAt ? -1 : 0));
  return out;
}

/** Launches this wallet initiated (agent deploys, self-fee, or Privy web deploys). */
export async function listDeploymentsInitiatedByWallet(
  walletAddress: string,
  limit = 50,
  offset = 0,
): Promise<DeploymentCatalogRow[]> {
  if (!db) return [];
  let walletLower: string;
  let agentDeployerId: string;
  try {
    walletLower = getAddress(walletAddress).toLowerCase();
    agentDeployerId = `agent:${getAddress(walletAddress)}`;
  } catch {
    return [];
  }

  const directRows = await new Promise<DeploymentCatalogRow[]>((resolve) => {
    db!.all(
      `SELECT ${SELECT_DEPLOYMENT_ROW}
       FROM deployment_catalog AS dc
       WHERE (
         dc.deployer_id = ?
         OR (dc.fee_to_self = 1 AND lower(dc.fee_recipient_address) = ?)
       )${visibleCatalogSql()}
       ORDER BY dc.created_at DESC`,
      [agentDeployerId, walletLower, visibleCatalogParam()],
      (err, rows: DeploymentCatalogRow[] | undefined) => {
        if (err) {
          logger.warn('listDeploymentsInitiatedByWallet direct failed:', err.message);
          resolve([]);
          return;
        }
        resolve(hydrateDeploymentCatalogRows(rows ?? []));
      },
    );
  });

  const privyRows = await new Promise<PrivyCatalogRow[]>((resolve) => {
    db!.all(
      `SELECT ${SELECT_DEPLOYMENT_ROW}, dc.privy_user_id AS privyUserId
       FROM deployment_catalog AS dc
       WHERE TRIM(COALESCE(dc.privy_user_id, '')) != ''
         AND dc.deployer_id = dc.privy_user_id
         AND dc.fee_to_self = 0${visibleCatalogSql()}
       ORDER BY dc.created_at DESC`,
      [visibleCatalogParam()],
      (err, rows: PrivyCatalogRow[] | undefined) => {
        if (err) {
          logger.warn('listDeploymentsInitiatedByWallet privy failed:', err.message);
          resolve([]);
          return;
        }
        resolve(rows ?? []);
      },
    );
  });

  const { getEmbeddedEthAddressForPrivyUserId } = await import('./privy.js');
  const walletByPrivy = new Map<string, string | null>();
  const privyMatches: DeploymentCatalogRow[] = [];
  for (const row of privyRows) {
    const uid = row.privyUserId?.trim();
    if (!uid) continue;
    let embedded = walletByPrivy.get(uid);
    if (embedded === undefined) {
      try {
        embedded = (await getEmbeddedEthAddressForPrivyUserId(uid))?.toLowerCase() ?? null;
      } catch {
        embedded = null;
      }
      walletByPrivy.set(uid, embedded);
    }
    if (embedded === walletLower) privyMatches.push(row);
  }

  const merged = mergeDeploymentsByTokenAddress(directRows, privyMatches);
  return merged.slice(
    Math.max(0, offset),
    Math.max(0, offset) + Math.min(Math.max(1, limit), 200),
  );
}

export async function countDeploymentsInitiatedByWallet(walletAddress: string): Promise<number> {
  const rows = await listDeploymentsInitiatedByWallet(walletAddress, 500, 0);
  return rows.length;
}

/**
 * Count catalog rows attributed to the same X @handle (agent metadata, deployer label, or tweet URL).
 */
export function xUsernameCatalogMatchParams(handle: string): string[] {
  const jsonNeedle = `%\"xUsername\":\"${handle}\"%`;
  return [jsonNeedle, `@${handle}`, handle, `/${handle}/status/`];
}

export const X_USERNAME_CATALOG_MATCH_SQL = `(
  lower(COALESCE(dc.agent_metadata, '')) LIKE ?
  OR instr(lower(COALESCE(dc.deployer_label, '')), ?) > 0
  OR lower(trim(replace(COALESCE(dc.deployer_label, ''), '@', ''))) = ?
  OR instr(lower(COALESCE(dc.source_url, '')), ?) > 0
)`;

/**
 * Count catalog rows attributed to the same X @handle (agent metadata, deployer label, or tweet URL).
 */
export async function countDeploymentsByXUsername(xUsername: string): Promise<number> {
  if (!db) return 0;
  const handle = normalizeXUsername(xUsername);
  if (!handle) return 0;

  return new Promise((resolve) => {
    db!.get(
      `SELECT COUNT(*) AS n FROM deployment_catalog AS dc
       WHERE ${X_USERNAME_CATALOG_MATCH_SQL}`,
      xUsernameCatalogMatchParams(handle),
      (err, row: { n?: number } | undefined) => {
        if (err) {
          logger.warn('countDeploymentsByXUsername failed:', err.message);
          resolve(0);
          return;
        }
        resolve(typeof row?.n === 'number' ? row.n : 0);
      },
    );
  });
}

/** All catalog rows attributed to an X @handle (Bankr agent, native X bot, web with label). */
export async function listDeploymentsByXUsername(
  xUsername: string,
  limit = 50,
  offset = 0,
): Promise<DeploymentCatalogRow[]> {
  if (!db) return [];
  const handle = normalizeXUsername(xUsername);
  if (!handle) return [];
  const lim = Math.min(Math.max(1, limit), 100);
  const off = Math.max(0, offset);

  return new Promise((resolve) => {
    db!.all(
      `SELECT ${SELECT_DEPLOYMENT_ROW}
       FROM deployment_catalog AS dc
       WHERE ${X_USERNAME_CATALOG_MATCH_SQL}${visibleCatalogSql()}
       ORDER BY dc.created_at DESC
       LIMIT ? OFFSET ?`,
      [...xUsernameCatalogMatchParams(handle), visibleCatalogParam(), lim, off],
      (err, rows: DeploymentCatalogRow[] | undefined) => {
        if (err) {
          logger.warn('listDeploymentsByXUsername failed:', err.message);
          resolve([]);
          return;
        }
        resolve(hydrateDeploymentCatalogRows(rows ?? []));
      },
    );
  });
}

export async function enrichDeploymentForPublicApi(
  row: DeploymentCatalogRow | null,
): Promise<(DeploymentCatalogRow & DeploymentPublicExtras) | null> {
  const { enrichDeploymentForPublicApi: enrich } = await import('./deploymentPartyEnrichment.js');
  return enrich(row);
}

/** Public token page: one catalog row by token contract address. */
export async function getDeploymentByTokenAddress(
  tokenAddress: string,
): Promise<DeploymentCatalogRow | null> {
  if (!db) return null;
  let tok: string;
  try {
    tok = getAddress(tokenAddress).toLowerCase();
  } catch {
    return null;
  }
  return new Promise((resolve) => {
    db!.get(
      `SELECT ${SELECT_DEPLOYMENT_ROW}
       FROM deployment_catalog AS dc
       WHERE lower(dc.token_address) = ?${visibleCatalogSql()}
       LIMIT 1`,
      [tok, visibleCatalogParam()],
      (err, row: DeploymentCatalogRow | undefined) => {
        if (err) {
          logger.warn('deploymentCatalog get by token failed:', err.message);
          resolve(null);
          return;
        }
        resolve(hydrateDeploymentCatalogRow(row));
      },
    );
  });
}

/**
 * Authorizes web claim / collect-pool-fees: the token must appear in catalog for this Privy user as
 * deployer, privy-linked deployer, or (when `feeRecipientWallet` is set) as fee recipient wallet.
 * Aligns with listDeploymentCatalogForUser visibility rules.
 */
export async function getDeploymentCatalogRowForPrivyClaimAuth(
  privyUserId: string,
  feeRecipientWallet: string,
  tokenAddress: string,
): Promise<DeploymentCatalogRow | null> {
  if (!db) return null;
  const uid = privyUserId.trim();
  let tok: string;
  try {
    tok = getAddress(tokenAddress).toLowerCase();
  } catch {
    return null;
  }
  if (!uid || !tok) return null;

  let walletLower = '';
  const w = feeRecipientWallet.trim();
  if (/^0x[0-9a-fA-F]{40}$/.test(w)) {
    try {
      walletLower = getAddress(w).toLowerCase();
    } catch {
      walletLower = '';
    }
  }

  return new Promise((resolve) => {
    db!.get(
      `SELECT ${SELECT_DEPLOYMENT_ROW}
       FROM deployment_catalog AS dc
       WHERE lower(dc.token_address) = ?
         AND (
           dc.deployer_id = ?
           OR (TRIM(COALESCE(dc.privy_user_id, '')) != '' AND dc.privy_user_id = ?)
           OR (? != '' AND lower(dc.fee_recipient_address) = ?)
         )
       LIMIT 1`,
      [tok, uid, uid, walletLower, walletLower],
      (err, row: DeploymentCatalogRow | undefined) => {
        if (err) {
          logger.warn('deploymentCatalog getDeploymentCatalogRowForPrivyClaimAuth failed:', err.message);
          resolve(null);
          return;
        }
        resolve(hydrateDeploymentCatalogRow(row));
      },
    );
  });
}

/** All catalog rows for this fee wallet + ticker (normalized, $ stripped). */
export async function listDeploymentsByFeeRecipientAndSymbol(
  feeRecipientAddress: string,
  tokenSymbol: string,
): Promise<DeploymentCatalogRow[]> {
  if (!db) return [];
  const fee = feeRecipientAddress.trim().toLowerCase();
  const sym = tokenSymbol.trim().replace(/^\$/u, '').toUpperCase();
  if (!fee || !sym) return [];

  return new Promise((resolve) => {
    db!.all(
      `SELECT ${SELECT_DEPLOYMENT_ROW}
       FROM deployment_catalog AS dc
       WHERE lower(dc.fee_recipient_address) = ?
         AND upper(trim(replace(dc.token_symbol, '$', ''))) = ?
       ORDER BY dc.created_at DESC`,
      [fee, sym],
      (err, rows: DeploymentCatalogRow[]) => {
        if (err) {
          logger.warn('deploymentCatalog list by fee+symbol failed:', err.message);
          resolve([]);
          return;
        }
        resolve(hydrateDeploymentCatalogRows(rows ?? []));
      },
    );
  });
}

/** All catalog rows for this fee wallet + exact token name (case-insensitive trim). */
export async function listDeploymentsByFeeRecipientAndName(
  feeRecipientAddress: string,
  tokenName: string,
): Promise<DeploymentCatalogRow[]> {
  if (!db) return [];
  const fee = feeRecipientAddress.trim().toLowerCase();
  const name = tokenName.trim().replace(/\s+/gu, ' ');
  if (!fee || !name) return [];

  return new Promise((resolve) => {
    db!.all(
      `SELECT ${SELECT_DEPLOYMENT_ROW}
       FROM deployment_catalog AS dc
       WHERE lower(dc.fee_recipient_address) = ?
         AND lower(trim(dc.token_name)) = lower(?)
       ORDER BY dc.created_at DESC`,
      [fee, name],
      (err, rows: DeploymentCatalogRow[]) => {
        if (err) {
          logger.warn('deploymentCatalog list by fee+name failed:', err.message);
          resolve([]);
          return;
        }
        resolve(hydrateDeploymentCatalogRows(rows ?? []));
      },
    );
  });
}

/** Scoped to a deployment you made on this platform as this deployer, with this fee wallet. */
export async function getDeploymentByPlatformDeployerFeeRecipientAndTokenAddress(
  platform: string,
  deployerId: string,
  feeRecipientAddress: string,
  tokenAddress: string,
): Promise<DeploymentCatalogRow | null> {
  if (!db) return null;
  const plat = platform.trim().slice(0, 64);
  const dep = deployerId.trim().slice(0, 256);
  let fee: string;
  let tok: string;
  try {
    fee = getAddress(feeRecipientAddress);
    tok = getAddress(tokenAddress);
  } catch {
    return null;
  }
  fee = fee.toLowerCase();
  tok = tok.toLowerCase();

  return new Promise((resolve) => {
    db!.get(
      `SELECT ${SELECT_DEPLOYMENT_ROW}
       FROM deployment_catalog AS dc
       WHERE dc.platform = ?
         AND dc.deployer_id = ?
         AND lower(dc.fee_recipient_address) = ?
         AND lower(dc.token_address) = ?
       LIMIT 1`,
      [plat, dep, fee, tok],
      (err, row: DeploymentCatalogRow | undefined) => {
        if (err) {
          logger.warn('deploymentCatalog get by platform+deployer+fee+token failed:', err.message);
          resolve(null);
          return;
        }
        resolve(hydrateDeploymentCatalogRow(row));
      },
    );
  });
}

export async function listDeploymentsByPlatformDeployerFeeRecipientAndSymbol(
  platform: string,
  deployerId: string,
  feeRecipientAddress: string,
  tokenSymbol: string,
): Promise<DeploymentCatalogRow[]> {
  if (!db) return [];
  const plat = platform.trim().slice(0, 64);
  const dep = deployerId.trim().slice(0, 256);
  let fee: string;
  try {
    fee = getAddress(feeRecipientAddress);
  } catch {
    return [];
  }
  fee = fee.toLowerCase();
  const sym = tokenSymbol.trim().replace(/^\$/u, '').toUpperCase();
  if (!sym) return [];

  return new Promise((resolve) => {
    db!.all(
      `SELECT ${SELECT_DEPLOYMENT_ROW}
       FROM deployment_catalog AS dc
       WHERE dc.platform = ?
         AND dc.deployer_id = ?
         AND lower(dc.fee_recipient_address) = ?
         AND upper(trim(replace(dc.token_symbol, '$', ''))) = ?
       ORDER BY dc.created_at DESC`,
      [plat, dep, fee, sym],
      (err, rows: DeploymentCatalogRow[]) => {
        if (err) {
          logger.warn('deploymentCatalog list by platform+deployer+fee+symbol failed:', err.message);
          resolve([]);
          return;
        }
        resolve(hydrateDeploymentCatalogRows(rows ?? []));
      },
    );
  });
}

export async function listDeploymentsByPlatformDeployerFeeRecipientAndName(
  platform: string,
  deployerId: string,
  feeRecipientAddress: string,
  tokenName: string,
): Promise<DeploymentCatalogRow[]> {
  if (!db) return [];
  const plat = platform.trim().slice(0, 64);
  const dep = deployerId.trim().slice(0, 256);
  let fee: string;
  try {
    fee = getAddress(feeRecipientAddress);
  } catch {
    return [];
  }
  fee = fee.toLowerCase();
  const name = tokenName.trim().replace(/\s+/gu, ' ');
  if (!name) return [];

  return new Promise((resolve) => {
    db!.all(
      `SELECT ${SELECT_DEPLOYMENT_ROW}
       FROM deployment_catalog AS dc
       WHERE dc.platform = ?
         AND dc.deployer_id = ?
         AND lower(dc.fee_recipient_address) = ?
         AND lower(trim(dc.token_name)) = lower(?)
       ORDER BY dc.created_at DESC`,
      [plat, dep, fee, name],
      (err, rows: DeploymentCatalogRow[]) => {
        if (err) {
          logger.warn('deploymentCatalog list by platform+deployer+fee+name failed:', err.message);
          resolve([]);
          return;
        }
        resolve(hydrateDeploymentCatalogRows(rows ?? []));
      },
    );
  });
}

/** Normalize ticker for catalog comparisons (uppercase, strip leading `$`, max 32 chars). */
export function normalizeCatalogTickerSymbol(symbol: string): string {
  return symbol.trim().replace(/^\$/u, '').toUpperCase().slice(0, 32);
}

/** Normalize token name for global cooldown comparisons (lowercase, collapsed spaces). */
export function normalizeCatalogTokenName(name: string): string {
  return name.trim().replace(/\s+/gu, ' ').toLowerCase().slice(0, 64);
}

/**
 * Newest catalog row for this ticker in the rolling window — used to show the existing contract in cooldown errors.
 */
export async function getMostRecentGlobalTickerDeploymentInRollingHours(
  symbol: string,
  hours: number,
): Promise<{ tokenAddress: string; tokenName: string; tokenSymbol: string } | null> {
  if (!db) return null;
  const sym = normalizeCatalogTickerSymbol(symbol);
  if (!sym) return null;
  const h = Math.min(Math.max(1, Math.floor(hours)), 168);
  const timeMod = `-${h} hours`;

  return new Promise((resolve) => {
    db!.get(
      `SELECT token_address AS tokenAddress, token_name AS tokenName, token_symbol AS tokenSymbol
       FROM deployment_catalog
       WHERE upper(trim(replace(token_symbol, '$', ''))) = ?
         AND datetime(created_at) >= datetime('now', ?)
       ORDER BY datetime(created_at) DESC
       LIMIT 1`,
      [sym, timeMod],
      (err, row: { tokenAddress?: string; tokenName?: string; tokenSymbol?: string } | undefined) => {
        if (err) {
          logger.warn('deploymentCatalog global ticker row lookup failed:', err.message);
          resolve(null);
          return;
        }
        const raw = row?.tokenAddress?.trim();
        if (!raw) {
          resolve(null);
          return;
        }
        try {
          const tokenAddress = getAddress(raw);
          const tokenName = (row?.tokenName ?? '').trim().slice(0, 128) || '(no name)';
          const tokenSymbol = normalizeCatalogTickerSymbol(row?.tokenSymbol ?? '') || sym;
          resolve({ tokenAddress, tokenName, tokenSymbol });
        } catch {
          resolve(null);
        }
      },
    );
  });
}

/**
 * Whether **any** successful catalog deploy used this ticker within the last `hours` (rolling window).
 * Global across platforms and users — used to prevent ticker squatting / duplicate symbols.
 */
export async function hasGlobalTickerDeploymentInRollingHours(
  symbol: string,
  hours: number,
): Promise<boolean> {
  if (!db) return false;
  const sym = normalizeCatalogTickerSymbol(symbol);
  if (!sym) return false;
  const h = Math.min(Math.max(1, Math.floor(hours)), 168);
  const timeMod = `-${h} hours`;

  return new Promise((resolve) => {
    db!.get(
      `SELECT 1 AS ok FROM deployment_catalog
       WHERE upper(trim(replace(token_symbol, '$', ''))) = ?
         AND datetime(created_at) >= datetime('now', ?)
         AND TRIM(COALESCE(factory_address, '')) != ''
         AND lower(factory_address) != lower(?)
       LIMIT 1`,
      [sym, timeMod, visibleCatalogParam()],
      (err, row: { ok: number } | undefined) => {
        if (err) {
          logger.warn('deploymentCatalog global ticker check failed:', err.message);
          resolve(false);
          return;
        }
        resolve(row != null);
      },
    );
  });
}

/**
 * Whether **any** successful catalog deploy used this token name within the last `hours` (rolling window).
 * Global across platforms and users — case-insensitive, whitespace-normalized.
 */
export async function hasGlobalNameDeploymentInRollingHours(
  name: string,
  hours: number,
): Promise<boolean> {
  if (!db) return false;
  const normalized = normalizeCatalogTokenName(name);
  if (normalized.length < 2) return false;
  const h = Math.min(Math.max(1, Math.floor(hours)), 168);
  const timeMod = `-${h} hours`;

  return new Promise((resolve) => {
    db!.get(
      `SELECT 1 AS ok FROM deployment_catalog
       WHERE lower(trim(replace(replace(token_name, char(9), ' '), char(10), ' '))) = ?
         AND datetime(created_at) >= datetime('now', ?)
         AND TRIM(COALESCE(factory_address, '')) != ''
         AND lower(factory_address) != lower(?)
       LIMIT 1`,
      [normalized, timeMod, visibleCatalogParam()],
      (err, row: { ok: number } | undefined) => {
        if (err) {
          logger.warn('deploymentCatalog global name check failed:', err.message);
          resolve(false);
          return;
        }
        resolve(row != null);
      },
    );
  });
}

/**
 * Newest catalog row for this name in the rolling window — used in cooldown errors.
 */
export async function getMostRecentGlobalNameDeploymentInRollingHours(
  name: string,
  hours: number,
): Promise<{ tokenAddress: string; tokenSymbol: string } | null> {
  if (!db) return null;
  const normalized = normalizeCatalogTokenName(name);
  if (!normalized) return null;
  const h = Math.min(Math.max(1, Math.floor(hours)), 168);
  const timeMod = `-${h} hours`;

  return new Promise((resolve) => {
    db!.get(
      `SELECT token_address AS tokenAddress, token_symbol AS tokenSymbol
       FROM deployment_catalog
       WHERE lower(trim(replace(replace(token_name, char(9), ' '), char(10), ' '))) = ?
         AND datetime(created_at) >= datetime('now', ?)
       ORDER BY datetime(created_at) DESC
       LIMIT 1`,
      [normalized, timeMod],
      (err, row: { tokenAddress?: string; tokenSymbol?: string } | undefined) => {
        if (err) {
          logger.warn('deploymentCatalog global name row lookup failed:', err.message);
          resolve(null);
          return;
        }
        const raw = row?.tokenAddress?.trim();
        if (!raw) {
          resolve(null);
          return;
        }
        try {
          const tokenAddress = getAddress(raw);
          const tokenSymbol = normalizeCatalogTickerSymbol(row?.tokenSymbol ?? '') || '?';
          resolve({ tokenAddress, tokenSymbol });
        } catch {
          resolve(null);
        }
      },
    );
  });
}

/** Distinct token names deployed in the rolling cooldown window (for fuzzy name checks). */
export async function listRecentDeployedNamesInRollingHours(
  hours: number,
  limit = 200,
): Promise<Array<{ tokenName: string; tokenSymbol: string; tokenAddress: string }>> {
  if (!db) return [];
  const h = Math.min(Math.max(1, Math.floor(hours)), 168);
  const lim = Math.min(Math.max(1, limit), 500);
  const timeMod = `-${h} hours`;

  return new Promise((resolve) => {
    db!.all(
      `SELECT token_address AS tokenAddress, token_name AS tokenName, token_symbol AS tokenSymbol
       FROM deployment_catalog
       WHERE datetime(created_at) >= datetime('now', ?)
         AND TRIM(COALESCE(factory_address, '')) != ''
         AND lower(factory_address) != lower(?)
         AND length(trim(token_name)) >= 2
       ORDER BY datetime(created_at) DESC
       LIMIT ?`,
      [timeMod, visibleCatalogParam(), lim],
      (err, rows: Array<{ tokenAddress?: string; tokenName?: string; tokenSymbol?: string }>) => {
        if (err) {
          logger.warn('deploymentCatalog recent names lookup failed:', err.message);
          resolve([]);
          return;
        }
        const out: Array<{ tokenName: string; tokenSymbol: string; tokenAddress: string }> = [];
        for (const row of rows ?? []) {
          const raw = row.tokenAddress?.trim();
          const tokenName = (row.tokenName ?? '').trim();
          if (!raw || tokenName.length < 2) continue;
          try {
            out.push({
              tokenAddress: getAddress(raw),
              tokenName,
              tokenSymbol: normalizeCatalogTickerSymbol(row.tokenSymbol ?? '') || '?',
            });
          } catch {
            /* skip */
          }
        }
        resolve(out);
      },
    );
  });
}

export interface FeeRecipientToken {
  tokenName: string;
  tokenSymbol: string;
  tokenAddress: string;
  createdAt: string;
}

/**
 * Returns the most recently deployed tokens where the given address is the fee recipient.
 * Used to warn deployers that someone already has a token before launching another one for them.
 */
export async function listTokensForFeeRecipient(
  feeRecipientAddress: string,
  limit = 5,
): Promise<FeeRecipientToken[]> {
  if (!db) return [];
  const addr = feeRecipientAddress.trim().toLowerCase();
  if (!addr) return [];
  const lim = Math.min(Math.max(1, limit), 20);

  return new Promise((resolve) => {
    db!.all(
      `SELECT dc.token_name AS tokenName, dc.token_symbol AS tokenSymbol,
              dc.token_address AS tokenAddress, dc.created_at AS createdAt
       FROM deployment_catalog AS dc
       WHERE lower(dc.fee_recipient_address) = ?
       ORDER BY dc.created_at DESC
       LIMIT ?`,
      [addr, lim],
      (err, rows: FeeRecipientToken[]) => {
        if (err) {
          logger.warn('deploymentCatalog listTokensForFeeRecipient failed:', err.message);
          resolve([]);
          return;
        }
        resolve(rows ?? []);
      },
    );
  });
}

/**
 * Prior launches where this wallet receives fees as **self** (`fee_to_self = 1`), newest first.
 */
export async function listSelfFeeTokensForFeeRecipient(
  feeRecipientAddress: string,
  limit = 10,
): Promise<FeeRecipientToken[]> {
  if (!db) return [];
  let fee: string;
  try {
    fee = getAddress(feeRecipientAddress);
  } catch {
    return [];
  }
  if (fee.toLowerCase() === DEAD_FEE_LOWER) return [];
  const lim = Math.min(Math.max(1, limit), 20);

  return new Promise((resolve) => {
    db!.all(
      `SELECT dc.token_name AS tokenName, dc.token_symbol AS tokenSymbol,
              dc.token_address AS tokenAddress, dc.created_at AS createdAt
       FROM deployment_catalog AS dc
       WHERE lower(dc.fee_recipient_address) = lower(?)
         AND lower(dc.fee_recipient_address) != ?
         AND dc.fee_to_self = 1
       ORDER BY datetime(dc.created_at) DESC
       LIMIT ?`,
      [fee, DEAD_FEE_LOWER, lim],
      (err, rows: FeeRecipientToken[]) => {
        if (err) {
          logger.warn('deploymentCatalog listSelfFeeTokensForFeeRecipient failed:', err.message);
          resolve([]);
          return;
        }
        resolve(rows ?? []);
      },
    );
  });
}

/**
 * Third-party launches (`fee_to_self = 0`) to this fee wallet within the rolling window — same filter as
 * `countThirdPartyFeeRecipientDeploymentsRollingHours`, newest first.
 */
export async function listThirdPartyFeeTokensForFeeRecipientRollingHours(
  feeRecipientAddress: string,
  hours: number,
  limit = 10,
): Promise<FeeRecipientToken[]> {
  if (!db) return [];
  let fee: string;
  try {
    fee = getAddress(feeRecipientAddress);
  } catch {
    return [];
  }
  if (fee.toLowerCase() === DEAD_FEE_LOWER) return [];
  const h = Math.min(Math.max(1, Math.floor(hours)), 168);
  const timeMod = rollingHoursSqlMod(h);
  const lim = Math.min(Math.max(1, limit), 20);

  return new Promise((resolve) => {
    db!.all(
      `SELECT dc.token_name AS tokenName, dc.token_symbol AS tokenSymbol,
              dc.token_address AS tokenAddress, dc.created_at AS createdAt
       FROM deployment_catalog AS dc
       WHERE lower(dc.fee_recipient_address) = lower(?)
         AND lower(dc.fee_recipient_address) != ?
         AND dc.fee_to_self = 0
         AND datetime(dc.created_at) >= datetime('now', ?)
       ORDER BY datetime(dc.created_at) DESC
       LIMIT ?`,
      [fee, DEAD_FEE_LOWER, timeMod, lim],
      (err, rows: FeeRecipientToken[]) => {
        if (err) {
          logger.warn(
            'deploymentCatalog listThirdPartyFeeTokensForFeeRecipientRollingHours failed:',
            err.message,
          );
          resolve([]);
          return;
        }
        resolve(rows ?? []);
      },
    );
  });
}

export function closeDeploymentCatalogDb(): void {
  if (db) {
    db.close((err) => {
      if (err) {
        logger.error('deploymentCatalog: error closing database:', err.message);
      }
    });
    db = null;
  }
}

/** Rows with V3 pool ids — candidates for deprecated-factory purge. */
export async function listV3CatalogRowsForPurge(): Promise<
  import('./deprecatedV3Catalog.js').CatalogRowForPurge[]
> {
  if (!db) return [];
  return new Promise((resolve) => {
    db!.all(
      `SELECT id, token_address AS tokenAddress, token_symbol AS tokenSymbol, pool_id AS poolId,
              transaction_hash AS transactionHash, COALESCE(factory_address, '') AS factoryAddress
       FROM deployment_catalog
       WHERE pool_id LIKE 'v3:%' OR lower(COALESCE(factory_address, '')) = lower(?)`,
      [visibleCatalogParam()],
      (err, rows) => {
        if (err) {
          logger.warn('deploymentCatalog listV3CatalogRowsForPurge failed:', err.message);
          resolve([]);
          return;
        }
        resolve((rows ?? []) as import('./deprecatedV3Catalog.js').CatalogRowForPurge[]);
      },
    );
  });
}

export async function deleteDeploymentCatalogByTokenAddresses(
  tokenAddresses: string[],
): Promise<number> {
  if (!db || tokenAddresses.length === 0) return 0;
  const lowered = [
    ...new Set(
      tokenAddresses
        .map((a) => {
          try {
            return getAddress(a).toLowerCase();
          } catch {
            return '';
          }
        })
        .filter(Boolean),
    ),
  ];
  if (lowered.length === 0) return 0;

  const placeholders = lowered.map(() => '?').join(', ');
  return new Promise((resolve) => {
    db!.run(
      `DELETE FROM deployment_catalog WHERE lower(token_address) IN (${placeholders})`,
      lowered,
      function (this: { changes: number }, err) {
        if (err) {
          logger.warn('deploymentCatalog deleteByTokenAddresses failed:', err.message);
          resolve(0);
          return;
        }
        resolve(this.changes);
      },
    );
  });
}

/** One-time purge of pre-production catalog rows (empty factory_address — V4 tests, etc.). */
export async function runLegacyTestCatalogPurgeIfNeeded(): Promise<void> {
  if (isLegacyTestCatalogPurgeComplete()) return;
  if (!db) return;

  try {
    const removed = await deleteLegacyTestCatalogRows();
    markLegacyTestCatalogPurgeComplete();
    logger.info('Legacy test catalog purge complete', { removed });
  } catch (err: unknown) {
    logger.warn('Legacy test catalog purge failed:', err instanceof Error ? err.message : err);
  }
}

export async function deleteLegacyTestCatalogRows(): Promise<number> {
  if (!db) return 0;
  return new Promise((resolve) => {
    db!.run(
      `DELETE FROM deployment_catalog WHERE TRIM(COALESCE(factory_address, '')) = ''`,
      function (this: { changes: number }, err) {
        if (err) {
          logger.warn('deploymentCatalog deleteLegacyTestCatalogRows failed:', err.message);
          resolve(0);
          return;
        }
        resolve(this.changes);
      },
    );
  });
}

export async function countLegacyTestCatalogRows(): Promise<number> {
  if (!db) return 0;
  return new Promise((resolve) => {
    db!.get(
      `SELECT COUNT(*) AS c FROM deployment_catalog WHERE TRIM(COALESCE(factory_address, '')) = ''`,
      (err, row: { c: number } | undefined) => {
        if (err) {
          logger.warn('deploymentCatalog countLegacyTestCatalogRows failed:', err.message);
          resolve(0);
          return;
        }
        resolve(Number(row?.c ?? 0));
      },
    );
  });
}

/** Run all one-time catalog purges (deprecated V3 factory, then legacy test rows). */
export async function runCatalogPurgesIfNeeded(rpcUrl: string): Promise<void> {
  await runDeprecatedV3CatalogPurgeIfNeeded(rpcUrl);
  await runLegacyTestCatalogPurgeIfNeeded();
}

/** One-time purge of test tokens from the deprecated V3 factory (idempotent marker in `.data`). */
export async function runDeprecatedV3CatalogPurgeIfNeeded(rpcUrl: string): Promise<void> {
  if (isDeprecatedV3CatalogPurgeComplete()) return;
  if (!db) return;

  try {
    const result = await purgeDeprecatedV3CatalogEntries(rpcUrl, {
      listV3CatalogRows: listV3CatalogRowsForPurge,
      deleteByTokenAddresses: deleteDeploymentCatalogByTokenAddresses,
    });
    markDeprecatedV3CatalogPurgeComplete();
    if (result.removed.length > 0) {
      logger.info('Removed deprecated V3 factory tokens from catalog', {
        count: result.removed.length,
        tokens: result.removed,
      });
    } else {
      logger.info('Deprecated V3 factory catalog purge complete (no rows removed)', {
        scanned: result.scanned,
      });
    }
  } catch (err: unknown) {
    logger.warn('Deprecated V3 catalog purge failed:', err instanceof Error ? err.message : err);
  }
}
