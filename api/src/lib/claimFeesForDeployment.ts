import type { DeploymentCatalogRow } from './deploymentCatalog.js';
import {
  claimWethFeesForLaunchedToken,
  collectPoolFeesForLaunchedToken,
} from './deploymentFeeActions.js';
import { claimV3RewardsForToken, isV3CatalogDeployment } from './hoodmarketsV3Fees.js';

export type ClaimFeesForDeploymentResult =
  | {
      ok: true;
      feeModel: 'v3' | 'v4';
      txHash: string;
      basescanUrl: string;
      feeAmountWei: bigint;
      message: string;
      collectTxHash?: string;
    }
  | {
      ok: false;
      feeModel: 'v3' | 'v4';
      error: string;
    };

/**
 * Claim trading fees for a catalog deployment — V3 (simple) or V4 (pro).
 * V3: Holder NFT `claimTradingFees()` — pull LP fees and pay all share holders pro-rata (one tx).
 * V4: collect pool fees into locker (best-effort), then claim WETH from locker.
 */
export async function claimFeesForDeployment(
  row: Pick<DeploymentCatalogRow, 'poolId' | 'factoryAddress' | 'feeRecipientAddress'>,
  tokenAddress: `0x${string}`,
): Promise<ClaimFeesForDeploymentResult> {
  const feeModel = isV3CatalogDeployment(row) ? 'v3' : 'v4';

  if (feeModel === 'v3') {
    try {
      const out = await claimV3RewardsForToken(tokenAddress);
      return {
        ok: true,
        feeModel: 'v3',
        txHash: out.txHash,
        basescanUrl: out.basescanUrl,
        feeAmountWei: 0n,
        message: out.message,
      };
    } catch (e: unknown) {
      const raw = e instanceof Error ? e.message : 'V3 claim failed';
      return { ok: false, feeModel: 'v3', error: raw };
    }
  }

  let collectTxHash: string | undefined;
  try {
    const collected = await collectPoolFeesForLaunchedToken(tokenAddress);
    collectTxHash = collected.txHash;
  } catch {
    /* pool may have nothing to collect yet — still try locker claim */
  }

  const feeOwner = row.feeRecipientAddress as `0x${string}`;
  const claimed = await claimWethFeesForLaunchedToken(feeOwner);
  if (!claimed.ok) {
    return {
      ok: false,
      feeModel: 'v4',
      error: claimed.error,
    };
  }

  return {
    ok: true,
    feeModel: 'v4',
    txHash: claimed.txHash,
    basescanUrl: claimed.basescanUrl,
    feeAmountWei: claimed.feeAmountWei,
    message: `Claimed ${(Number(claimed.feeAmountWei) / 1e18).toFixed(6)} ETH (WETH) to ${feeOwner}.`,
    ...(collectTxHash ? { collectTxHash } : {}),
  };
}
