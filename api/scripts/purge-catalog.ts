#!/usr/bin/env npx tsx
/**
 * Purge test tokens from the deployment catalog:
 * 1. Deprecated HoodMarkets V3 factory (on-chain tx check)
 * 2. Legacy rows with empty factory_address (pre-production V4 tests)
 *
 * Usage:
 *   cd api && npm run purge-catalog
 *   cd api && npm run purge-catalog:dry-run
 */
import dotenv from 'dotenv';
import { config } from '../src/config.js';
import { initDedupDb } from '../src/lib/deployDedup.js';
import {
  countLegacyTestCatalogRows,
  deleteDeploymentCatalogByTokenAddresses,
  deleteLegacyTestCatalogRows,
  initDeploymentCatalogDb,
  listV3CatalogRowsForPurge,
} from '../src/lib/deploymentCatalog.js';
import { purgeDeprecatedV3CatalogEntries } from '../src/lib/deprecatedV3Catalog.js';

dotenv.config();

const dryRun = process.argv.includes('--dry-run');

async function main() {
  initDedupDb();
  initDeploymentCatalogDb();
  await new Promise((r) => setTimeout(r, 1500));

  const v3 = await purgeDeprecatedV3CatalogEntries(
    config.chainRpcUrl,
    {
      listV3CatalogRows: listV3CatalogRowsForPurge,
      deleteByTokenAddresses: deleteDeploymentCatalogByTokenAddresses,
    },
    { dryRun },
  );

  const legacyCount = await countLegacyTestCatalogRows();
  let legacyRemoved = 0;
  if (!dryRun) {
    legacyRemoved = await deleteLegacyTestCatalogRows();
  }

  console.log(
    JSON.stringify(
      {
        dryRun,
        deprecatedV3: {
          scanned: v3.scanned,
          removedCount: v3.removed.length,
          removed: v3.removed,
        },
        legacyEmptyFactory: {
          scanned: legacyCount,
          removedCount: dryRun ? legacyCount : legacyRemoved,
        },
      },
      null,
      2,
    ),
  );
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
