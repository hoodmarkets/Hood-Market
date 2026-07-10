import { getAddress } from 'viem';
import { BASE_DEAD_FEE_RECIPIENT } from './deadFeeWallet.js';
import {
  memeFeeWalletAndLabel,
  RATE_LIMIT_FORCED_DEAD_FEE_LABEL,
} from './memeFeeRecipient.js';
import {
  shouldForceMemeDueToFeeRecipientLimit,
  shouldForceMemeDueToOtherFeeLimit,
  shouldForceMemeDueToThirdPartyWalletRateLimit,
} from './feeRecipientLimit.js';
import { shouldForceMemeDueToSelfFeeLimit } from './selfFeeLimit.js';

export type DeployRateLimitInput = {
  walletAddress: string;
  feeRecipientLabel?: string;
  feeToSelf: boolean;
  platform: string;
  deployerId: string;
  privyUserId?: string | null;
};

export type DeployRateLimitResult = {
  walletAddress: string;
  feeRecipientLabel?: string;
  feeToSelf: boolean;
  rateLimitForcedBurn: boolean;
};

/**
 * Enforces deploy fee limits: **Eastern-day** env caps (`X_MAX_SELF_FEE_DEPLOYS_PER_DAY`,
 * `MAX_FEE_RECIPIENT_DEPLOYS_PER_EASTERN_DAY`, `MAX_OTHER_FEE_DEPLOYS_PER_EASTERN_DAY`) plus optional
 * **rolling** caps (`MAX_SELF_FEE_DEPLOYS_PER_24H`, `MAX_THIRD_PARTY_FEE_TO_WALLET_PER_24H`).
 * Excess routes fees to the burn wallet. Global ticker cooldown is separate (`GLOBAL_TICKER_COOLDOWN_HOURS`).
 */
export async function applyDeployRateLimitBurn(
  input: DeployRateLimitInput,
): Promise<DeployRateLimitResult> {
  let addr = input.walletAddress.trim();
  try {
    addr = getAddress(addr);
  } catch {
    return {
      walletAddress: input.walletAddress,
      feeRecipientLabel: input.feeRecipientLabel,
      feeToSelf: input.feeToSelf,
      rateLimitForcedBurn: false,
    };
  }

  if (addr.toLowerCase() === BASE_DEAD_FEE_RECIPIENT.toLowerCase()) {
    return {
      walletAddress: addr,
      feeRecipientLabel: input.feeRecipientLabel,
      feeToSelf: false,
      rateLimitForcedBurn: false,
    };
  }

  if (input.feeToSelf) {
    const force = await shouldForceMemeDueToSelfFeeLimit({
      privyUserId: input.privyUserId ?? null,
      platform: input.platform,
      deployerId: input.deployerId,
    });
    if (force) {
      const m = memeFeeWalletAndLabel();
      return {
        walletAddress: m.walletAddress,
        feeRecipientLabel: RATE_LIMIT_FORCED_DEAD_FEE_LABEL,
        feeToSelf: false,
        rateLimitForcedBurn: true,
      };
    }
    return {
      walletAddress: addr,
      feeRecipientLabel: input.feeRecipientLabel,
      feeToSelf: true,
      rateLimitForcedBurn: false,
    };
  }

  const limitKey = {
    privyUserId: input.privyUserId ?? null,
    platform: input.platform,
    deployerId: input.deployerId,
  };
  const forceRecipientEastern = await shouldForceMemeDueToFeeRecipientLimit(addr);
  const forceOtherEastern = await shouldForceMemeDueToOtherFeeLimit(limitKey);
  const forceThirdRolling = await shouldForceMemeDueToThirdPartyWalletRateLimit(addr);
  if (forceRecipientEastern || forceOtherEastern || forceThirdRolling) {
    const m = memeFeeWalletAndLabel();
    return {
      walletAddress: m.walletAddress,
      feeRecipientLabel: RATE_LIMIT_FORCED_DEAD_FEE_LABEL,
      feeToSelf: false,
      rateLimitForcedBurn: true,
    };
  }

  return {
    walletAddress: addr,
    feeRecipientLabel: input.feeRecipientLabel,
    feeToSelf: false,
    rateLimitForcedBurn: false,
  };
}
