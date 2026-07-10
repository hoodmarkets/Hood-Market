import { existsSync, writeFileSync } from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { createPublicClient, decodeEventLog, getAddress, http, type Address } from 'viem';
import { HOODMARKETS_V3_ABI } from './hoodmarketsV3Abi.js';
import { logger } from '../logger.js';
import { robinhood } from './robinhoodChain.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const dataDir = path.join(__dirname, '../../.data');
const purgeMarkerPath = path.join(dataDir, 'deprecated-v3-catalog-purged.marker');
const legacyPurgeMarkerPath = path.join(dataDir, 'legacy-test-catalog-purged.marker');

/** Previous HoodMarketsV3 factory — test launches before 2026-07 cutover. */
export const DEPRECATED_HOODMARKETS_V3_FACTORY =
  '0xa77911C301b30283ca3dBc32812839AdF443b39f' as const;

export function deprecatedV3FactoryAddress(): Address {
  return getAddress(DEPRECATED_HOODMARKETS_V3_FACTORY);
}

/** SQL fragment: only catalog rows with a known factory, excluding deprecated V3. */
export function catalogProductionVisibleClause(
  tableAlias = 'dc',
): { sql: string; param: string } {
  return {
    sql: ` AND TRIM(COALESCE(${tableAlias}.factory_address, '')) != ''
           AND lower(${tableAlias}.factory_address) != lower(?) `,
    param: DEPRECATED_HOODMARKETS_V3_FACTORY,
  };
}

/** @deprecated Use {@link catalogProductionVisibleClause}. */
export function catalogNotDeprecatedFactoryClause(
  tableAlias = 'dc',
): { sql: string; param: string } {
  return catalogProductionVisibleClause(tableAlias);
}

export function isDeprecatedV3CatalogPurgeComplete(): boolean {
  return existsSync(purgeMarkerPath);
}

export function markDeprecatedV3CatalogPurgeComplete(): void {
  writeFileSync(purgeMarkerPath, new Date().toISOString(), 'utf8');
}

export function isLegacyTestCatalogPurgeComplete(): boolean {
  return existsSync(legacyPurgeMarkerPath);
}

export function markLegacyTestCatalogPurgeComplete(): void {
  writeFileSync(legacyPurgeMarkerPath, new Date().toISOString(), 'utf8');
}

/** True when the deploy tx emitted TokenCreated from the deprecated V3 factory. */
export async function isDeployTxFromDeprecatedV3Factory(
  rpcUrl: string,
  transactionHash: string,
): Promise<boolean> {
  const hash = transactionHash.trim().toLowerCase();
  if (!/^0x[0-9a-f]{64}$/.test(hash)) return false;

  const client = createPublicClient({
    chain: robinhood,
    transport: http(rpcUrl),
  });

  const receipt = await client.getTransactionReceipt({ hash: hash as `0x${string}` });
  const deprecated = deprecatedV3FactoryAddress().toLowerCase();

  for (const log of receipt.logs) {
    if (log.address.toLowerCase() !== deprecated) continue;
    try {
      const decoded = decodeEventLog({
        abi: HOODMARKETS_V3_ABI,
        data: log.data,
        topics: log.topics,
      });
      if (decoded.eventName === 'TokenCreated') return true;
    } catch {
      // not our event
    }
  }
  return false;
}

export interface CatalogRowForPurge {
  id: number;
  tokenAddress: string;
  tokenSymbol: string;
  poolId: string;
  transactionHash: string;
  factoryAddress: string;
}

export type PurgeDeprecatedV3CatalogDeps = {
  listV3CatalogRows: () => Promise<CatalogRowForPurge[]>;
  deleteByTokenAddresses: (addresses: string[]) => Promise<number>;
};

export async function purgeDeprecatedV3CatalogEntries(
  rpcUrl: string,
  deps: PurgeDeprecatedV3CatalogDeps,
  opts?: { dryRun?: boolean },
): Promise<{ scanned: number; removed: string[] }> {
  const rows = await deps.listV3CatalogRows();
  const deprecatedLower = deprecatedV3FactoryAddress().toLowerCase();
  const toRemove: string[] = [];

  for (const row of rows) {
    const factory = row.factoryAddress.trim().toLowerCase();
    if (factory === deprecatedLower) {
      toRemove.push(row.tokenAddress);
      continue;
    }
    if (row.poolId.startsWith('v3:')) {
      try {
        const fromOldFactory = await isDeployTxFromDeprecatedV3Factory(rpcUrl, row.transactionHash);
        if (fromOldFactory) toRemove.push(row.tokenAddress);
      } catch (err: unknown) {
        logger.warn('deprecatedV3Catalog: receipt check failed', {
          token: row.tokenAddress,
          tx: row.transactionHash,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }
  }

  const unique = [...new Set(toRemove.map((a) => getAddress(a).toLowerCase()))];

  if (!opts?.dryRun && unique.length > 0) {
    await deps.deleteByTokenAddresses(unique);
  }

  return { scanned: rows.length, removed: unique };
}
