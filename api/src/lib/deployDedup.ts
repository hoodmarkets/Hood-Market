import crypto from 'crypto';
import sqlite3 from 'sqlite3';
import path from 'path';
import { fileURLToPath } from 'url';
import { mkdirSync } from 'fs';
import { logger } from '../logger.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const dataDir = path.join(__dirname, '../../.data');
const dbPath = path.join(dataDir, 'deploy-dedup.db');

let db: sqlite3.Database | null = null;

export interface DeployRequest {
  platform: string; // 'x', 'discord', 'telegram', 'farcaster'
  sourceId: string; // tweet id, message id, cast id, etc.
  authorId: string; // user id / author id
  name: string;
  symbol: string;
  walletAddress: string;
  /** Deployment chain — same ticker can exist on Base vs Ethereum. */
  chain?: string;
}

/** Hash of deploy request — invariant for the same (author + token params). */
export function hashDeployRequest(req: DeployRequest): string {
  const ch = (req.chain ?? 'base').trim() || 'base';
  const key = `${req.platform}:${req.authorId}:${req.name}:${req.symbol}:${req.walletAddress}:${ch}`;
  return crypto.createHash('sha256').update(key).digest('hex').slice(0, 16);
}

/** Hash by source ID to prevent reprocessing the same source message */
export function hashBySourceId(req: DeployRequest): string {
  const key = `${req.platform}:${req.sourceId}`;
  return crypto.createHash('sha256').update(key).digest('hex').slice(0, 16);
}

/** Initialize SQLite database for dedup tracking. */
export function initDedupDb(): void {
  if (db) return;

  // Ensure .data directory exists
  try {
    mkdirSync(dataDir, { recursive: true });
  } catch (err: any) {
    logger.warn('Failed to create .data directory:', err.message);
  }

  db = new sqlite3.Database(dbPath, (err) => {
    if (err) {
      logger.error('Failed to open deploy-dedup.db:', err.message);
      return;
    }
    logger.info('Deploy dedup database initialized:', dbPath);
  });

  db.serialize(() => {
    db!.run(
      `CREATE TABLE IF NOT EXISTS cursors (
        key TEXT PRIMARY KEY NOT NULL,
        value TEXT NOT NULL,
        updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
      )`,
      (err) => { if (err) logger.error('Failed to create cursors table:', err.message); }
    );
    db!.run(
      `CREATE TABLE IF NOT EXISTS deploy_attempts (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        hash TEXT UNIQUE NOT NULL,
        source_hash TEXT UNIQUE NOT NULL,
        platform TEXT NOT NULL,
        source_id TEXT NOT NULL,
        author_id TEXT NOT NULL,
        name TEXT NOT NULL,
        symbol TEXT NOT NULL,
        wallet_address TEXT NOT NULL,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP
      )`,
      (err) => {
        if (err) {
          logger.error('Failed to create deploy_attempts table:', err.message);
        }
      }
    );
  });
}

/**
 * Check if a deploy request is a duplicate (already deployed) + record it.
 * Returns { isDuplicate, hash, reason }.
 * Checks:
 * 1. Same source (tweet/message ID) - prevents reprocessing on restart
 * 2. Same author + token params - prevents double-deploy of same token
 */
export async function checkAndRecordDeploy(
  req: DeployRequest
): Promise<{ isDuplicate: boolean; hash: string; reason?: string }> {
  const hash = hashDeployRequest(req);
  const sourceHash = hashBySourceId(req);

  if (!db) {
    logger.warn('Deploy dedup: database not ready, allowing deploy');
    return { isDuplicate: false, hash };
  }

  return new Promise((resolve) => {
    // Check if this exact source has been processed before
    db!.get(
      'SELECT id FROM deploy_attempts WHERE source_hash = ?',
      [sourceHash],
      (err, sourceRow: { id: number } | undefined) => {
        if (err) {
          logger.warn('Deploy dedup source check error:', err.message);
          resolve({ isDuplicate: false, hash });
          return;
        }

        if (sourceRow) {
          logger.info('Deploy dedup: source already processed', { sourceHash, ...req });
          resolve({ isDuplicate: true, hash, reason: 'source_already_processed' });
          return;
        }

        // Check if same author deployed same token parameters before
        db!.get(
          'SELECT id FROM deploy_attempts WHERE hash = ?',
          [hash],
          (err, row: { id: number } | undefined) => {
            if (err) {
              logger.warn('Deploy dedup params check error:', err.message);
              resolve({ isDuplicate: false, hash });
              return;
            }

            if (row) {
              logger.info('Deploy dedup: duplicate request blocked', { hash, ...req });
              resolve({ isDuplicate: true, hash, reason: 'duplicate_params' });
              return;
            }

            // Insert new record
            db!.run(
              `INSERT INTO deploy_attempts (hash, source_hash, platform, source_id, author_id, name, symbol, wallet_address)
               VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
              [hash, sourceHash, req.platform, req.sourceId, req.authorId, req.name, req.symbol, req.walletAddress],
              (insertErr) => {
                if (insertErr) {
                  if (insertErr.message.includes('UNIQUE')) {
                    logger.info('Deploy dedup: race condition — duplicate detected', { hash });
                    resolve({ isDuplicate: true, hash, reason: 'race_condition' });
                  } else {
                    logger.warn('Deploy dedup insert error:', insertErr.message);
                    resolve({ isDuplicate: false, hash });
                  }
                } else {
                  resolve({ isDuplicate: false, hash });
                }
              }
            );
          }
        );
      }
    );
  });
}

/** Persist a key-value cursor (e.g. lastMentionId) that survives restarts. */
export async function saveCursor(key: string, value: string): Promise<void> {
  if (!db) return;
  db.run(
    `INSERT INTO cursors (key, value) VALUES (?, ?)
     ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = CURRENT_TIMESTAMP`,
    [key, value],
    (err) => {
      if (err) logger.warn('Cursor save error:', err.message);
    }
  );
}

/** Load a persisted cursor value. Returns null if not found. */
export async function loadCursor(key: string): Promise<string | null> {
  if (!db) return null;
  return new Promise((resolve) => {
    db!.get(
      'SELECT value FROM cursors WHERE key = ?',
      [key],
      (err, row: { value: string } | undefined) => {
        if (err) { resolve(null); return; }
        resolve(row?.value ?? null);
      }
    );
  });
}

/** Remove a deploy attempt record when on-chain deploy fails after dedup insert. */
export async function releaseDeployAttempt(hash: string): Promise<void> {
  if (!db || !hash) return;
  return new Promise((resolve) => {
    db!.run('DELETE FROM deploy_attempts WHERE hash = ?', [hash], (err) => {
      if (err) {
        logger.warn('Deploy dedup release error:', err.message);
      }
      resolve();
    });
  });
}

/** Cleanup: delete old records (older than 7 days) to prevent database bloat. */
export async function cleanupOldRecords(): Promise<void> {
  if (!db) return;

  db.run(
    `DELETE FROM deploy_attempts WHERE created_at < datetime('now', '-7 days')`,
    (err) => {
      if (err) {
        logger.warn('Deploy dedup cleanup error:', err.message);
      } else {
        logger.debug('Deploy dedup: cleaned up old records');
      }
    }
  );
}

/** Close database (e.g., on shutdown). */
export function closeDedupDb(): void {
  if (db) {
    db.close((err) => {
      if (err) {
        logger.error('Error closing deploy-dedup.db:', err.message);
      }
    });
    db = null;
  }
}
