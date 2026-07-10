import sqlite3 from 'sqlite3';
import path from 'path';
import { fileURLToPath } from 'url';
import { mkdirSync } from 'fs';
import { getAddress } from 'viem';
import { logger } from '../logger.js';
import { catalogProductionVisibleClause } from './deprecatedV3Catalog.js';
import type { DeploymentCatalogRow } from './deploymentCatalog.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const dataDir = path.join(__dirname, '../../.data');
const dbPath = path.join(dataDir, 'deploy-dedup.db');

let db: sqlite3.Database | null = null;

const VISIBLE = catalogProductionVisibleClause('dc');

export type TokenMarketStatsRow = {
  tokenAddress: string;
  volume24hUsd: number;
  mcapUsd: number;
  liquidityUsd: number;
  change24hPct: number | null;
  txnsH24: number;
  priceUsd: number | null;
  dexscreenerUrl: string | null;
  lastTradeAt: string | null;
  updatedAt: string;
};

export type TokenMarketStatsPatch = {
  volume24hUsd?: number;
  mcapUsd?: number;
  liquidityUsd?: number;
  change24hPct?: number | null;
  txnsH24?: number;
  priceUsd?: number | null;
  dexscreenerUrl?: string | null;
  lastTradeAt?: string | null;
};

function run(sql: string, params: unknown[] = []): Promise<void> {
  return new Promise((resolve, reject) => {
    if (!db) {
      reject(new Error('tokenMarketStats DB not initialized'));
      return;
    }
    db.run(sql, params, (err) => (err ? reject(err) : resolve()));
  });
}

function all<T>(sql: string, params: unknown[] = []): Promise<T[]> {
  return new Promise((resolve, reject) => {
    if (!db) {
      reject(new Error('tokenMarketStats DB not initialized'));
      return;
    }
    db.all(sql, params, (err, rows) => (err ? reject(err) : resolve((rows as T[]) ?? [])));
  });
}

function getDb(): sqlite3.Database {
  if (!db) throw new Error('tokenMarketStats DB not initialized');
  return db;
}

/** Shares the deployment catalog SQLite file. */
export function initTokenMarketStatsDb(): void {
  if (db) return;

  try {
    mkdirSync(dataDir, { recursive: true });
  } catch (err: unknown) {
    logger.warn('tokenMarketStats: failed to create .data directory:', (err as Error).message);
  }

  db = new sqlite3.Database(dbPath, (err) => {
    if (err) logger.error('tokenMarketStats: failed to open database:', err.message);
  });

  db.serialize(() => {
    getDb().run(
      `CREATE TABLE IF NOT EXISTS token_market_stats (
        token_address TEXT PRIMARY KEY,
        volume_24h_usd REAL NOT NULL DEFAULT 0,
        mcap_usd REAL NOT NULL DEFAULT 0,
        liquidity_usd REAL NOT NULL DEFAULT 0,
        change_24h_pct REAL,
        txns_h24 INTEGER NOT NULL DEFAULT 0,
        price_usd REAL,
        dexscreener_url TEXT NOT NULL DEFAULT '',
        last_trade_at TEXT,
        updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
      )`,
      (err) => {
        if (err) logger.error('token_market_stats table create failed:', err.message);
      },
    );
    getDb().run(
      'CREATE INDEX IF NOT EXISTS idx_token_market_stats_volume ON token_market_stats(volume_24h_usd DESC)',
    );
    getDb().run(
      'CREATE INDEX IF NOT EXISTS idx_token_market_stats_mcap ON token_market_stats(mcap_usd DESC)',
    );
    getDb().run(
      'CREATE INDEX IF NOT EXISTS idx_token_market_stats_last_trade ON token_market_stats(last_trade_at DESC)',
    );
  });
}

export function closeTokenMarketStatsDb(): void {
  if (!db) return;
  db.close();
  db = null;
}

export async function listVisibleCatalogTokenAddresses(): Promise<string[]> {
  if (!db) return [];
  const rows = await all<{ tokenAddress: string }>(
    `SELECT dc.token_address AS tokenAddress
     FROM deployment_catalog AS dc
     WHERE 1=1${VISIBLE.sql}
     ORDER BY dc.created_at DESC`,
    [VISIBLE.param],
  );
  return rows.map((r) => r.tokenAddress).filter(Boolean);
}

export async function upsertTokenMarketStats(
  tokenAddress: string,
  patch: TokenMarketStatsPatch,
): Promise<void> {
  if (!db) return;
  let addr: string;
  try {
    addr = getAddress(tokenAddress);
  } catch {
    return;
  }

  const existing = await all<{ last_trade_at: string | null }>(
    `SELECT last_trade_at FROM token_market_stats WHERE lower(token_address) = lower(?)`,
    [addr],
  );
  const keepLastTrade =
    patch.lastTradeAt === undefined
      ? existing[0]?.last_trade_at ?? null
      : patch.lastTradeAt;

  await run(
    `INSERT INTO token_market_stats (
      token_address, volume_24h_usd, mcap_usd, liquidity_usd, change_24h_pct,
      txns_h24, price_usd, dexscreener_url, last_trade_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
    ON CONFLICT(token_address) DO UPDATE SET
      volume_24h_usd = excluded.volume_24h_usd,
      mcap_usd = excluded.mcap_usd,
      liquidity_usd = excluded.liquidity_usd,
      change_24h_pct = excluded.change_24h_pct,
      txns_h24 = excluded.txns_h24,
      price_usd = excluded.price_usd,
      dexscreener_url = excluded.dexscreener_url,
      last_trade_at = excluded.last_trade_at,
      updated_at = CURRENT_TIMESTAMP`,
    [
      addr,
      patch.volume24hUsd ?? 0,
      patch.mcapUsd ?? 0,
      patch.liquidityUsd ?? 0,
      patch.change24hPct ?? null,
      patch.txnsH24 ?? 0,
      patch.priceUsd ?? null,
      patch.dexscreenerUrl ?? '',
      keepLastTrade,
    ],
  );
}

export type ExploreCatalogRow = DeploymentCatalogRow & {
  volume24hUsd: number;
  mcapUsd: number;
  liquidityUsd: number;
  change24hPct: number | null;
  txnsH24: number;
  priceUsd: number | null;
  dexscreenerUrl: string | null;
  lastTradeAt: string | null;
  statsUpdatedAt: string | null;
};

export type ExploreSort = 'mcap' | 'volume' | 'launch' | 'lastTrade';
export type ExploreFilter = 'all' | 'live' | 'new';

export type ExploreQuery = {
  sort?: ExploreSort;
  filter?: ExploreFilter;
  minLiquidityUsd?: number;
  q?: string;
  limit?: number;
  offset?: number;
};

function exploreOrderBy(sort: ExploreSort): string {
  switch (sort) {
    case 'volume':
      return 'COALESCE(tms.volume_24h_usd, 0) DESC, dc.created_at DESC';
    case 'launch':
      return 'dc.created_at DESC';
    case 'lastTrade':
      return `CASE WHEN tms.last_trade_at IS NULL OR TRIM(tms.last_trade_at) = '' THEN 0 ELSE 1 END DESC,
              tms.last_trade_at DESC, dc.created_at DESC`;
    case 'mcap':
    default:
      return 'COALESCE(tms.mcap_usd, 0) DESC, dc.created_at DESC';
  }
}

function buildExploreWhere(query: ExploreQuery): { sql: string; params: unknown[] } {
  const params: unknown[] = [VISIBLE.param];
  let sql = ` WHERE 1=1${VISIBLE.sql}`;

  const filter = query.filter ?? 'all';
  if (filter === 'new') {
    sql += ` AND dc.created_at >= datetime('now', '-1 day')`;
  } else if (filter === 'live') {
    sql += ` AND tms.last_trade_at IS NOT NULL AND TRIM(tms.last_trade_at) != ''
             AND tms.last_trade_at >= datetime('now', '-15 minutes')`;
  }

  const minLiq = query.minLiquidityUsd;
  if (typeof minLiq === 'number' && Number.isFinite(minLiq) && minLiq > 0) {
    sql += ` AND COALESCE(tms.liquidity_usd, 0) >= ?`;
    params.push(minLiq);
  }

  const q = query.q?.trim().toLowerCase();
  if (q) {
    if (/^0x[a-f0-9]{40}$/.test(q)) {
      sql += ` AND lower(dc.token_address) = ?`;
      params.push(q);
    } else {
      sql += ` AND (
        lower(dc.token_name) LIKE ? OR
        lower(dc.token_symbol) LIKE ? OR
        lower(dc.token_address) LIKE ?
      )`;
      const needle = `%${q}%`;
      params.push(needle, needle, needle);
    }
  }

  return { sql, params };
}

const EXPLORE_SELECT = `
  SELECT dc.id, dc.created_at AS createdAt, dc.platform, dc.deployer_id AS deployerId,
         dc.deployer_label AS deployerLabel, dc.fee_recipient_address AS feeRecipientAddress,
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
          WHERE d4.fee_recipient_address = dc.fee_recipient_address) AS feeRecipientDeploymentCount,
         COALESCE(tms.volume_24h_usd, 0) AS volume24hUsd,
         COALESCE(tms.mcap_usd, 0) AS mcapUsd,
         COALESCE(tms.liquidity_usd, 0) AS liquidityUsd,
         tms.change_24h_pct AS change24hPct,
         COALESCE(tms.txns_h24, 0) AS txnsH24,
         tms.price_usd AS priceUsd,
         NULLIF(TRIM(tms.dexscreener_url), '') AS dexscreenerUrl,
         tms.last_trade_at AS lastTradeAt,
         tms.updated_at AS statsUpdatedAt
  FROM deployment_catalog AS dc
  LEFT JOIN token_market_stats AS tms ON lower(dc.token_address) = lower(tms.token_address)`;

export async function countExploreTokens(query: ExploreQuery): Promise<number> {
  if (!db) return 0;
  const { sql, params } = buildExploreWhere(query);
  const rows = await all<{ c: number }>(
    `SELECT COUNT(*) AS c FROM deployment_catalog AS dc
     LEFT JOIN token_market_stats AS tms ON lower(dc.token_address) = lower(tms.token_address)
     ${sql}`,
    params,
  );
  return Number(rows[0]?.c ?? 0);
}

export async function listExploreTokens(query: ExploreQuery): Promise<ExploreCatalogRow[]> {
  if (!db) return [];
  const lim = Math.min(Math.max(1, query.limit ?? 20), 100);
  const off = Math.max(0, query.offset ?? 0);
  const sort = query.sort ?? 'mcap';
  const { sql, params } = buildExploreWhere(query);

  return all<ExploreCatalogRow>(
    `${EXPLORE_SELECT}
     ${sql}
     ORDER BY ${exploreOrderBy(sort)}
     LIMIT ? OFFSET ?`,
    [...params, lim, off],
  );
}

export async function countLiveExploreTokens(): Promise<number> {
  return countExploreTokens({ filter: 'live' });
}

export async function getExplorePlatformStats(): Promise<{
  tokensLaunched: number;
  volume24hUsd: number;
  liveCount: number;
  statsUpdatedAt: string | null;
}> {
  if (!db) {
    return { tokensLaunched: 0, volume24hUsd: 0, liveCount: 0, statsUpdatedAt: null };
  }

  const [tokensLaunched, liveCount, agg] = await Promise.all([
    countExploreTokens({ filter: 'all' }),
    countLiveExploreTokens(),
    all<{ volume24hUsd: number; statsUpdatedAt: string | null }>(
      `SELECT COALESCE(SUM(tms.volume_24h_usd), 0) AS volume24hUsd,
              MAX(tms.updated_at) AS statsUpdatedAt
       FROM deployment_catalog AS dc
       LEFT JOIN token_market_stats AS tms ON lower(dc.token_address) = lower(tms.token_address)
       WHERE 1=1${VISIBLE.sql}`,
      [VISIBLE.param],
    ),
  ]);

  return {
    tokensLaunched,
    volume24hUsd: Number(agg[0]?.volume24hUsd ?? 0),
    liveCount,
    statsUpdatedAt: agg[0]?.statsUpdatedAt ?? null,
  };
}

export async function getTokenMarketStatsByAddress(
  tokenAddress: string,
): Promise<TokenMarketStatsRow | null> {
  if (!db) return null;
  let addr: string;
  try {
    addr = getAddress(tokenAddress);
  } catch {
    return null;
  }
  const rows = await all<{
    tokenAddress: string;
    volume24hUsd: number;
    mcapUsd: number;
    liquidityUsd: number;
    change24hPct: number | null;
    txnsH24: number;
    priceUsd: number | null;
    dexscreenerUrl: string | null;
    lastTradeAt: string | null;
    updatedAt: string;
  }>(
    `SELECT token_address AS tokenAddress,
            volume_24h_usd AS volume24hUsd,
            mcap_usd AS mcapUsd,
            liquidity_usd AS liquidityUsd,
            change_24h_pct AS change24hPct,
            txns_h24 AS txnsH24,
            price_usd AS priceUsd,
            dexscreener_url AS dexscreenerUrl,
            last_trade_at AS lastTradeAt,
            updated_at AS updatedAt
     FROM token_market_stats
     WHERE lower(token_address) = lower(?)
     LIMIT 1`,
    [addr],
  );
  const row = rows[0];
  if (!row) return null;
  return {
    tokenAddress: row.tokenAddress,
    volume24hUsd: Number(row.volume24hUsd ?? 0),
    mcapUsd: Number(row.mcapUsd ?? 0),
    liquidityUsd: Number(row.liquidityUsd ?? 0),
    change24hPct: row.change24hPct,
    txnsH24: Number(row.txnsH24 ?? 0),
    priceUsd: row.priceUsd,
    dexscreenerUrl: row.dexscreenerUrl,
    lastTradeAt: row.lastTradeAt,
    updatedAt: row.updatedAt,
  };
}
