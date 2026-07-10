#!/usr/bin/env npx tsx
/**
 * Remove catalog rows for tokens deployed via the deprecated HoodMarkets V3 factory.
 *
 * Usage:
 *   cd api && npx tsx scripts/purge-deprecated-v3-catalog.ts
 *   cd api && npx tsx scripts/purge-deprecated-v3-catalog.ts --dry-run
 *
 * Production: runs automatically once on API startup (marker in `.data/deprecated-v3-catalog-purged.marker`).
 * Re-run manually: delete the marker file, then restart API or run this script.
 */
import dotenv from 'dotenv';
import { config } from '../src/config.js';
import { initDedupDb } from '../src/lib/deployDedup.js';
import {
  deleteDeploymentCatalogByTokenAddresses,
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

  const result = await purgeDeprecatedV3CatalogEntries(config.chainRpcUrl, {
    listV3CatalogRows: listV3CatalogRowsForPurge,
    deleteByTokenAddresses: deleteDeploymentCatalogByTokenAddresses,
  }, { dryRun });

  console.log(
    JSON.stringify(
      {
        dryRun,
        scanned: result.scanned,
        removedCount: result.removed.length,
        removed: result.removed,
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
