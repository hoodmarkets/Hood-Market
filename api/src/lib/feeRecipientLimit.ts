import { config } from '../config.js';
import {
  countOtherFeeDeploymentsCurrentEasternDay,
  countThirdPartyFeeRecipientDeploymentsCurrentEasternDay,
  countThirdPartyFeeRecipientDeploymentsRollingHours,
  type SelfFeeCountKey,
} from './deploymentCatalog.js';
import { deployRateLimitRollingHours } from './selfFeeLimit.js';

/** Eastern-day cap on rows per fee wallet. Env: `MAX_FEE_RECIPIENT_DEPLOYS_PER_EASTERN_DAY`. */
export function maxFeeRecipientDeploysPerEasternDay(): number {
  return config.maxFeeRecipientDeploysPerEasternDay;
}

/**
 * Whether this fee wallet already hit the **Eastern calendar day** cap on **third-party** fee
 * assignments (`fee_to_self = 0`). Self-fee launches to the same wallet are counted separately.
 */
export async function shouldForceMemeDueToFeeRecipientLimit(
  feeRecipientAddress: string,
): Promise<boolean> {
  const max = maxFeeRecipientDeploysPerEasternDay();
  if (max <= 0) return false;
  const n = await countThirdPartyFeeRecipientDeploymentsCurrentEasternDay(feeRecipientAddress);
  return n >= max;
}

/** Rolling cap on third-party rows only. Env: `MAX_THIRD_PARTY_FEE_TO_WALLET_PER_24H`. */
export function maxThirdPartyFeeToSameWalletPerRollingWindow(): number {
  return config.maxThirdPartyFeeToSameWalletPerRollingWindow;
}

export async function shouldForceMemeDueToThirdPartyWalletRateLimit(
  feeRecipientAddress: string,
): Promise<boolean> {
  const max = maxThirdPartyFeeToSameWalletPerRollingWindow();
  if (max <= 0) return false;
  const h = deployRateLimitRollingHours();
  if (h <= 0) return false;
  const n = await countThirdPartyFeeRecipientDeploymentsRollingHours(feeRecipientAddress, h);
  return n >= max;
}

/** Per deployer: Eastern-day cap on third-party fee deploys they initiate. */
export function maxOtherFeeDeploysPerEasternDay(): number {
  return config.x.maxOtherFeeDeploysPerEasternDay;
}

export async function shouldForceMemeDueToOtherFeeLimit(
  key: SelfFeeCountKey,
): Promise<boolean> {
  const max = maxOtherFeeDeploysPerEasternDay();
  if (max <= 0) return false;
  const n = await countOtherFeeDeploymentsCurrentEasternDay(key);
  return n >= max;
}

/** Shown before web deploy when the deployer already launched for someone else today. */
export function deployerOtherFeeLimitProceedNotice(): string {
  const max = maxOtherFeeDeploysPerEasternDay();
  const tokenWord = max === 1 ? 'token' : 'tokens';
  const cap = max > 0 ? max : 1;
  return (
    `You already launched ${cap} ${tokenWord} for someone else today (Eastern time). ` +
    `If you continue, trading fees on this launch go to a burn wallet (No Dev meme) instead of them.`
  );
}

/** Shown before web deploy when the resolved fee recipient already hit the daily / rolling cap. */
export function thirdPartyFeeRecipientLimitProceedNotice(rollingHours?: number): string {
  const h =
    Number.isFinite(rollingHours) && (rollingHours ?? 0) > 0
      ? Math.round(rollingHours as number)
      : deployRateLimitRollingHours() || 24;
  const easternMax = maxFeeRecipientDeploysPerEasternDay();
  const rollingMax = maxThirdPartyFeeToSameWalletPerRollingWindow();
  const parts: string[] = [];
  if (easternMax > 0) {
    parts.push(`${easternMax} token${easternMax === 1 ? '' : 's'} per Eastern day`);
  }
  if (rollingMax > 0) {
    parts.push(`${rollingMax} per ${h} hours`);
  }
  const limitText = parts.length > 0 ? parts.join(' and ') : 'the deploy limit';
  return (
    `This wallet already received a token from someone else today (limit: ${limitText}). ` +
    `They can still launch one token for themselves. If you continue, trading fees on this launch go to a burn wallet (No Dev meme) instead of them.`
  );
}
