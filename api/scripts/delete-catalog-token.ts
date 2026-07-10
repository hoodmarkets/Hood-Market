#!/usr/bin/env npx tsx
/**
 * Delete one or more tokens from the deployment catalog (explore / API listings).
 *
 * Usage:
 *   cd api && npx tsx scripts/delete-catalog-token.ts 0x668Cb754e22912E1E24Dd05e04D415414c9be97e
 *   railway run -- npx tsx scripts/delete-catalog-token.ts 0x668Cb754...
 */
import dotenv from 'dotenv';
import { initDedupDb } from '../src/lib/deployDedup.js';
import {
  deleteDeploymentCatalogByTokenAddresses,
  initDeploymentCatalogDb,
} from '../src/lib/deploymentCatalog.js';

dotenv.config();

const tokens = process.argv.slice(2).filter((a) => a.startsWith('0x'));
if (tokens.length === 0) {
  console.error('Usage: npx tsx scripts/delete-catalog-token.ts <tokenAddress> [more...]');
  process.exit(1);
}

async function main() {
  initDedupDb();
  initDeploymentCatalogDb();
  await new Promise((r) => setTimeout(r, 1500));

  const removed = await deleteDeploymentCatalogByTokenAddresses(tokens);
  console.log(JSON.stringify({ removed, tokens }, null, 2));
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
