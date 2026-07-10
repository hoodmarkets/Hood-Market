import { mkdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import sqlite3 from 'sqlite3';
import { getAddress, type Address, type Hex } from 'viem';
import { config } from '../config.js';
import { logger } from '../logger.js';
import {
  hashVanityLaunchConfig,
  mineVanitySaltsForLaunch,
  mineVanitySaltsLocal,
  predictHoodMarketsV3TokenAddress,
  type HoodMarketsV3TokenDeployParams,
} from './hoodmarketsV3Create2.js';
import type { HoodMarketsV3DeploymentConfig } from './hoodmarketsV3Deploy.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const dataDir = path.join(__dirname, '../../.data');
const dbPath = path.join(dataDir, 'vanity-salt-bank.db');

let db: sqlite3.Database | null = null;
const replenishInFlight = new Set<string>();

function bankSize(): number {
  const n = config.vanitySaltBankSize;
  return Number.isFinite(n) && n > 0 ? Math.min(100, Math.floor(n)) : 20;
}

function run(sql: string, params: unknown[] = []): Promise<void> {
  return new Promise((resolve, reject) => {
    if (!db) {
      reject(new Error('vanity salt bank database not initialized'));
      return;
    }
    db.run(sql, params, (err) => (err ? reject(err) : resolve()));
  });
}

function get<T>(sql: string, params: unknown[] = []): Promise<T | undefined> {
  return new Promise((resolve, reject) => {
    if (!db) {
      reject(new Error('vanity salt bank database not initialized'));
      return;
    }
    db.get(sql, params, (err, row) => (err ? reject(err) : resolve(row as T | undefined)));
  });
}

function all<T>(sql: string, params: unknown[] = []): Promise<T[]> {
  return new Promise((resolve, reject) => {
    if (!db) {
      reject(new Error('vanity salt bank database not initialized'));
      return;
    }
    db.all(sql, params, (err, rows) => (err ? reject(err) : resolve((rows ?? []) as T[])));
  });
}

export function initVanitySaltBankDb(): void {
  if (db) return;
  try {
    mkdirSync(dataDir, { recursive: true });
  } catch (err: unknown) {
    logger.warn('vanitySaltBank: failed to create .data directory:', err);
  }

  db = new sqlite3.Database(dbPath, (err) => {
    if (err) {
      logger.error('vanitySaltBank: failed to open database:', err.message);
      return;
    }
    logger.info('Vanity salt bank database initialized:', dbPath);
  });

  db.serialize(() => {
    db!.run(
      `CREATE TABLE IF NOT EXISTS vanity_bank_configs (
        config_key TEXT PRIMARY KEY NOT NULL,
        factory TEXT NOT NULL,
        admin TEXT NOT NULL,
        name TEXT NOT NULL,
        symbol TEXT NOT NULL,
        image TEXT NOT NULL,
        metadata TEXT NOT NULL,
        context TEXT NOT NULL,
        chain_id TEXT NOT NULL,
        suffix TEXT NOT NULL,
        updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
      )`,
      (err) => {
        if (err) logger.error('vanitySaltBank: failed to create vanity_bank_configs:', err.message);
      },
    );
    db!.run(
      `CREATE TABLE IF NOT EXISTS vanity_salts (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        config_key TEXT NOT NULL,
        suffix TEXT NOT NULL,
        salt TEXT NOT NULL,
        predicted_address TEXT NOT NULL,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        UNIQUE(config_key, salt)
      )`,
      (err) => {
        if (err) logger.error('vanitySaltBank: failed to create vanity_salts table:', err.message);
      },
    );
    db!.run(
      `CREATE INDEX IF NOT EXISTS idx_vanity_salts_config ON vanity_salts(config_key)`,
      (err) => {
        if (err) logger.error('vanitySaltBank: failed to create index:', err.message);
      },
    );
  });
}

export function closeVanitySaltBankDb(): void {
  if (!db) return;
  const closing = db;
  db = null;
  closing.close((err) => {
    if (err) logger.error('vanitySaltBank: error closing database:', err.message);
  });
}

type StoredBankConfig = {
  config_key: string;
  factory: string;
  admin: string;
  name: string;
  symbol: string;
  image: string;
  metadata: string;
  context: string;
  chain_id: string;
  suffix: string;
};

function toDeployParams(row: StoredBankConfig): HoodMarketsV3TokenDeployParams {
  return {
    factory: getAddress(row.factory),
    admin: getAddress(row.admin),
    name: row.name,
    symbol: row.symbol,
    image: row.image,
    metadata: row.metadata,
    context: row.context,
    originatingChainId: BigInt(row.chain_id),
    tokenSalt: `0x${'00'.repeat(32)}` as Hex,
  };
}

async function rememberConfig(
  configKey: string,
  suffix: string,
  params: HoodMarketsV3TokenDeployParams,
): Promise<void> {
  await run(
    `INSERT INTO vanity_bank_configs
      (config_key, factory, admin, name, symbol, image, metadata, context, chain_id, suffix, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
     ON CONFLICT(config_key) DO UPDATE SET
       suffix = excluded.suffix,
       updated_at = CURRENT_TIMESTAMP`,
    [
      configKey,
      params.factory,
      params.admin,
      params.name,
      params.symbol,
      params.image,
      params.metadata,
      params.context,
      (params.originatingChainId ?? 4663n).toString(),
      suffix,
    ],
  );
}

async function countBanked(configKey: string): Promise<number> {
  const row = await get<{ c: number }>(
    `SELECT COUNT(*) AS c FROM vanity_salts WHERE config_key = ?`,
    [configKey],
  );
  return row?.c ?? 0;
}

async function insertSalts(
  configKey: string,
  suffix: string,
  params: HoodMarketsV3TokenDeployParams,
  salts: Hex[],
): Promise<void> {
  for (const salt of salts) {
    const predicted = predictHoodMarketsV3TokenAddress({ ...params, tokenSalt: salt });
    await run(
      `INSERT OR IGNORE INTO vanity_salts (config_key, suffix, salt, predicted_address) VALUES (?, ?, ?, ?)`,
      [configKey, suffix, salt, predicted],
    ).catch(() => undefined);
  }
}

async function claimBankedSalt(configKey: string): Promise<Hex | null> {
  const row = await get<{ id: number; salt: string }>(
    `SELECT id, salt FROM vanity_salts WHERE config_key = ? ORDER BY id ASC LIMIT 1`,
    [configKey],
  );
  if (!row) return null;
  await run(`DELETE FROM vanity_salts WHERE id = ?`, [row.id]);
  return row.salt as Hex;
}

async function replenishBank(
  configKey: string,
  suffix: string,
  params: HoodMarketsV3TokenDeployParams,
): Promise<void> {
  if (replenishInFlight.has(configKey)) return;
  replenishInFlight.add(configKey);
  try {
    await rememberConfig(configKey, suffix, params);
    const target = bankSize();
    const existing = await countBanked(configKey);
    const needed = target - existing;
    if (needed <= 0) return;

    const mined = mineVanitySaltsForLaunch(params, suffix, {
      count: needed,
      maxAttempts: config.vanitySaltMaxAttempts,
    });
    const salts = [mined.primary, ...mined.extras];
    await insertSalts(configKey, suffix, params, salts);
    logger.info('Vanity salt bank replenished', {
      configKey: configKey.slice(0, 12),
      suffix,
      added: salts.length,
      attempts: mined.attempts,
      remaining: await countBanked(configKey),
    });
  } catch (err: unknown) {
    logger.warn('Vanity salt bank replenish failed', {
      configKey: configKey.slice(0, 12),
      error: err instanceof Error ? err.message : String(err),
    });
  } finally {
    replenishInFlight.delete(configKey);
  }
}

export type ClaimVanitySaltInput = {
  factory: Address;
  deploymentConfig: HoodMarketsV3DeploymentConfig;
  suffix: string;
};

export type ClaimVanitySaltResult = {
  salt: Hex;
  tokenAddress: Address;
  source: 'bank' | 'mined';
  bankedAfter: number;
};

/** Claim a …suffix salt for this launch config; refill bank to target size in background. */
export async function claimVanitySaltForLaunch(
  input: ClaimVanitySaltInput,
): Promise<ClaimVanitySaltResult> {
  const suffix = input.suffix.trim().toLowerCase();
  const configKey = hashVanityLaunchConfig(input.deploymentConfig);
  const params: HoodMarketsV3TokenDeployParams = {
    factory: getAddress(input.factory),
    admin: getAddress(input.deploymentConfig.rewardsConfig.creatorAdmin),
    name: input.deploymentConfig.tokenConfig.name,
    symbol: input.deploymentConfig.tokenConfig.symbol,
    image: input.deploymentConfig.tokenConfig.image,
    metadata: input.deploymentConfig.tokenConfig.metadata,
    context: input.deploymentConfig.tokenConfig.context,
    originatingChainId: input.deploymentConfig.tokenConfig.originatingChainId,
    tokenSalt: input.deploymentConfig.tokenConfig.salt,
  };

  const banked = await claimBankedSalt(configKey);
  if (banked) {
    const tokenAddress = predictHoodMarketsV3TokenAddress({ ...params, tokenSalt: banked });
    void replenishBank(configKey, suffix, params).catch(() => undefined);
    return {
      salt: banked,
      tokenAddress,
      source: 'bank',
      bankedAfter: await countBanked(configKey),
    };
  }

  const mined = mineVanitySaltsForLaunch(params, suffix, {
    count: 1,
    maxAttempts: config.vanitySaltMaxAttempts,
  });
  const tokenAddress = predictHoodMarketsV3TokenAddress({ ...params, tokenSalt: mined.primary });
  if (mined.extras.length > 0) {
    await insertSalts(configKey, suffix, params, mined.extras);
  }
  void replenishBank(configKey, suffix, params).catch(() => undefined);

  return {
    salt: mined.primary,
    tokenAddress,
    source: 'mined',
    bankedAfter: await countBanked(configKey),
  };
}

/** After restart, top up banks for launch configs seen before. */
export async function maintainVanitySaltBanks(): Promise<void> {
  if (!config.webWalletDeployVanity) return;
  const rows = await all<StoredBankConfig>(
    `SELECT config_key, factory, admin, name, symbol, image, metadata, context, chain_id, suffix
     FROM vanity_bank_configs ORDER BY updated_at DESC LIMIT 50`,
  );
  for (const row of rows) {
    const params = toDeployParams(row);
    const count = await countBanked(row.config_key);
    if (count >= bankSize()) continue;
    await replenishBank(row.config_key, row.suffix, params);
  }
}
