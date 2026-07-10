import { getAddress } from 'viem';
import { config } from '../config.js';
import { deployRateLimitRollingHours, shouldForceMemeDueToSelfFeeLimit } from './selfFeeLimit.js';

/** Catalog label when a 24h self-fee limit routes trading fees to the platform wallet. */
export const RATE_LIMIT_FORCED_PLATFORM_FEE_LABEL = 'Hood.markets is fee recipient';

export function webDeployRateLimitPlatformNotice(): string {
  const h = deployRateLimitRollingHours() || 24;
  const pct = (config.platformFeeBps / 100).toFixed(
    config.platformFeeBps % 100 === 0 ? 0 : 2,
  );
  return (
    `You already launched a token in the last ${h} hours. If you continue, ` +
    `trading fees on this token go to the hoodmarkets platform instead of your wallet. ` +
    `(Standard launches: you keep ${100 - Number(pct)}%, platform ${pct}%.)`
  );
}

export type WebDeployRateLimitResult = {
  walletAddress: string;
  feeRecipientLabel?: string;
  feeToSelf: boolean;
  rateLimitForcedPlatformFee: boolean;
};

/** hood.markets web: excess self-fee deploys route 100% of LP fees to the platform wallet. */
export async function applyWebDeployRateLimit(input: {
  walletAddress: string;
  feeRecipientLabel?: string;
  feeToSelf: boolean;
  privyUserId?: string | null;
  deployerId: string;
}): Promise<WebDeployRateLimitResult> {
  let addr = input.walletAddress.trim();
  try {
    addr = getAddress(addr);
  } catch {
    return {
      walletAddress: input.walletAddress,
      feeRecipientLabel: input.feeRecipientLabel,
      feeToSelf: input.feeToSelf,
      rateLimitForcedPlatformFee: false,
    };
  }

  if (!input.feeToSelf) {
    return {
      walletAddress: addr,
      feeRecipientLabel: input.feeRecipientLabel,
      feeToSelf: false,
      rateLimitForcedPlatformFee: false,
    };
  }

  if (!config.platformFeeRecipient) {
    return {
      walletAddress: addr,
      feeRecipientLabel: input.feeRecipientLabel,
      feeToSelf: true,
      rateLimitForcedPlatformFee: false,
    };
  }

  const force = await shouldForceMemeDueToSelfFeeLimit({
    privyUserId: input.privyUserId ?? null,
    platform: 'web',
    deployerId: input.deployerId,
  });

  if (force) {
    return {
      walletAddress: addr,
      feeRecipientLabel: RATE_LIMIT_FORCED_PLATFORM_FEE_LABEL,
      feeToSelf: false,
      rateLimitForcedPlatformFee: true,
    };
  }

  return {
    walletAddress: addr,
    feeRecipientLabel: input.feeRecipientLabel,
    feeToSelf: true,
    rateLimitForcedPlatformFee: false,
  };
}
