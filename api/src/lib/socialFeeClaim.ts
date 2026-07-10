import { getAddress } from 'viem';
import { resolveSocialClaimDeployment } from './claimDeploymentAuth.js';
import { claimFeesForDeployment } from './claimFeesForDeployment.js';
import { markDeploymentFeeClaimed } from './deploymentCatalog.js';
import { friendlyV3ClaimError } from './hoodmarketsV3Fees.js';

export type SocialFeeClaimOutcome =
  | {
      ok: true;
      basescanUrl: string;
      txHash: string;
      feeAmountHuman: string;
      tokenAddress: string;
      feeModel: 'v3' | 'v4';
    }
  | { ok: false; message: string };

/**
 * Resolve catalog + broadcast trading fee claim for a social deployer (X, Telegram, etc.).
 */
export async function runSocialTradingFeesClaim(params: {
  platform: string;
  deployerId: string;
  feeRecipientAddress: string;
  tokenAddress?: string;
  tokenSymbol?: string;
  tokenName?: string;
}): Promise<SocialFeeClaimOutcome> {
  let fee: string;
  try {
    fee = getAddress(params.feeRecipientAddress);
  } catch {
    return { ok: false, message: 'Could not resolve a valid fee wallet for your account.' };
  }

  const resolved = await resolveSocialClaimDeployment({
    platform: params.platform,
    deployerId: params.deployerId,
    feeRecipient: fee,
    tokenAddress: params.tokenAddress,
    tokenSymbol: params.tokenSymbol,
    tokenName: params.tokenName,
  });

  if (!resolved.ok) {
    return { ok: false, message: resolved.error };
  }

  const token = resolved.tokenAddress as `0x${string}`;
  const claimed = await claimFeesForDeployment(resolved.row, token);
  if (!claimed.ok) {
    const msg =
      claimed.feeModel === 'v3'
        ? friendlyV3ClaimError(claimed.error)
        : claimed.error;
    return { ok: false, message: msg };
  }

  const feeHuman =
    claimed.feeAmountWei > 0n
      ? (Number(claimed.feeAmountWei) / 1e18).toFixed(6)
      : claimed.feeModel === 'v3'
        ? '0'
        : '0';

  await markDeploymentFeeClaimed(resolved.tokenAddress, claimed.txHash);
  return {
    ok: true,
    basescanUrl: claimed.basescanUrl,
    txHash: claimed.txHash,
    feeAmountHuman: feeHuman,
    tokenAddress: resolved.tokenAddress,
    feeModel: claimed.feeModel,
  };
}
