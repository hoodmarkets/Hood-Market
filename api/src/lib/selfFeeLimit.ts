import { config } from '../config.js';
import {
  countSelfFeeDeploymentsCurrentEasternDay,
  countSelfFeeDeploymentsRollingHours,
  countDeployerDeploymentsCurrentEasternDay,
  countDeployerDeploymentsRollingHours,
  type SelfFeeCountKey,
} from './deploymentCatalog.js';

/** Eastern-day cap (`0` = unlimited). Env: `X_MAX_SELF_FEE_DEPLOYS_PER_DAY`. */
export function maxSelfFeeDeploysPerEasternDay(): number {
  return config.x.maxSelfFeeDeploysPerEasternDay;
}

/** Rolling-window cap (`0` = off — use Eastern only). Env: `MAX_SELF_FEE_DEPLOYS_PER_24H`. */
export function maxSelfFeeDeploysPerRollingWindow(): number {
  return config.maxSelfFeeDeploysPerRollingWindow;
}

export function deployRateLimitRollingHours(): number {
  return config.deployRateLimitRollingHours;
}

/**
 * Shown with the “third party already launched for this wallet in the rolling window” warning:
 * users can wait for the window to clear and deploy again with fees to that wallet as usual.
 * @deprecated Prefer {@link thirdPartyRollingWindowDeployWarnUserMessage} for the full in-context paragraph.
 */
export function thirdPartyRollingMemeCooldownReliefNote(rollingHours: number): string {
  if (!Number.isFinite(rollingHours) || rollingHours <= 0) {
    return 'Once this cooldown finishes, you can deploy again with trading fees going to this wallet as usual.';
  }
  const h = Math.round(rollingHours);
  return `Once this ${h}-hour rolling cooldown finishes, you can deploy again with trading fees going to this wallet as usual (instead of the burn address).`;
}

/**
 * Full copy when a fee wallet already has another party’s launch in the rolling window: this deploy
 * would treat the token as no dev / meme with fees to the dead wallet; explains the limit and waiting.
 */
export function thirdPartyRollingWindowDeployWarnUserMessage(rollingHours: number): string {
  const h =
    Number.isFinite(rollingHours) && rollingHours > 0 ? Math.round(rollingHours) : 24;
  return (
    `If you deploy now, this launch becomes a no dev meme token — trading fees will go to a dead wallet. ` +
    `The wallet has hit the limit of one token deployed for it within a ${h}-hour window. ` +
    `If you'd like to deploy for this wallet or account and have fees go to it, please wait ${h} hours.`
  );
}

/**
 * Self-fee deploy limit: enforced if **either** the Eastern-day cap or the rolling cap is exceeded
 * (when that cap is set positive).
 */
/** User-facing error when self-fee deploy limit is exceeded; `null` if under limit. */
export async function selfFeeDeployLimitErrorOrNull(
  key: SelfFeeCountKey,
): Promise<string | null> {
  const atLimit = await shouldForceMemeDueToSelfFeeLimit(key);
  if (!atLimit) return null;

  const rollingMax = maxSelfFeeDeploysPerRollingWindow();
  const h = deployRateLimitRollingHours();
  if (rollingMax > 0 && h > 0) {
    const tokenWord = rollingMax === 1 ? 'token' : 'tokens';
    return `You can only launch ${rollingMax} ${tokenWord} every ${h} hours. Try again later.`;
  }

  const easternMax = maxSelfFeeDeploysPerEasternDay();
  if (easternMax > 0) {
    const tokenWord = easternMax === 1 ? 'token' : 'tokens';
    return `You can only launch ${easternMax} ${tokenWord} per day. Try again later.`;
  }

  return 'Deploy rate limit reached. Try again later.';
}

export async function shouldForceMemeDueToSelfFeeLimit(
  key: SelfFeeCountKey,
): Promise<boolean> {
  const isAgentDeployer = key.deployerId.startsWith('agent:');
  const easternMax = maxSelfFeeDeploysPerEasternDay();
  if (easternMax > 0) {
    const n = isAgentDeployer
      ? await countDeployerDeploymentsCurrentEasternDay(key.platform, key.deployerId)
      : await countSelfFeeDeploymentsCurrentEasternDay(key);
    if (n >= easternMax) return true;
  }
  const rollingMax = maxSelfFeeDeploysPerRollingWindow();
  if (rollingMax > 0) {
    const h = deployRateLimitRollingHours();
    if (h > 0) {
      const n = isAgentDeployer
        ? await countDeployerDeploymentsRollingHours(key.platform, key.deployerId, h)
        : await countSelfFeeDeploymentsRollingHours(key, h);
      if (n >= rollingMax) return true;
    }
  }
  return false;
}
