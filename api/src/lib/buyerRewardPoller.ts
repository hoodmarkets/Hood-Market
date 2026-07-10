import { getAddress, type Address } from 'viem';
import { config } from '../config.js';
import { logger } from '../logger.js';
import { listDeploymentCatalog } from './deploymentCatalog.js';
import { getBuyerRewardStatus, processBuyerRewardShares } from './fractionBuyerRewards.js';

const POLL_MS = 60_000;
const CATALOG_SCAN = 80;

/** Background loop: issue escrowed buyer-reward shares when new pool buys appear (gas paid by launcher). */
export function startBuyerRewardPoller(): void {
  if (!config.hoodmarketsV3.factory) return;

  const tick = async () => {
    try {
      const rows = await listDeploymentCatalog(CATALOG_SCAN, 0);
      for (const row of rows) {
        const tokenRaw = row.tokenAddress?.trim();
        if (!tokenRaw || !/^0x[a-fA-F0-9]{40}$/.test(tokenRaw)) continue;
        let token: Address;
        try {
          token = getAddress(tokenRaw);
        } catch {
          continue;
        }

        const status = await getBuyerRewardStatus(token);
        if (!status.enabled || status.remaining <= 0) continue;

        const result = await processBuyerRewardShares(token, {
          fromBlock: row.blockNumber ? BigInt(row.blockNumber) : undefined,
        });
        if (result.issued > 0) {
          logger.info(
            `Buyer rewards: issued ${result.issued} share(s) for ${row.tokenSymbol ?? token} (${token})`,
          );
        }
      }
    } catch (e) {
      logger.warn('Buyer reward poller:', e instanceof Error ? e.message : e);
    }
  };

  setTimeout(() => void tick(), 15_000);
  setInterval(() => void tick(), POLL_MS);
  logger.info('Buyer reward poller started (escrowed first-buyer shares)');
}
