import { getAddress, type Address } from 'viem';
import { config } from '../config.js';
import { applyDeployRateLimitBurn } from './deployRateLimitBurn.js';
import {
  countThirdPartyFeeRecipientDeploymentsRollingHours,
  listDeploymentCatalogByDeployer,
  normalizeCatalogTickerSymbol,
} from './deploymentCatalog.js';
import {
  formatCommunityLaunchLockMessage,
  formatCommunityLaunchLockReplyHint,
  getCommunityLaunchLockConflict,
} from './communityLaunchLock.js';
import {
  formatDeployCooldownConflictMessage,
  formatDeployCooldownReplyHint,
  getGlobalNameCooldownConflict,
  getGlobalTickerCooldownConflict,
  globalTickerCooldownHours,
  isNameGloballyReserved,
  isTickerGloballyReserved,
  thirdPartyFeeRecipientCooldownErrorOrNull,
  type ExistingDeployToken,
} from './globalTickerCooldown.js';
import { DEPLOY_LIMIT_MEME_PROCEED_USER_NOTICE } from './memeFeeRecipient.js';
import {
  isReservedTicker,
  isReservedTokenName,
  reservedNameUserMessage,
  reservedTickerUserMessage,
} from './reservedTokens.js';
import {
  applyWebDeployRateLimit,
  webDeployRateLimitPlatformNotice,
} from './webDeployRateLimit.js';
import { deployRateLimitRollingHours } from './selfFeeLimit.js';
import {
  buildAgentXDeployLimitBlock,
  isAgentXChannel,
  type AgentXDeployLimitStatus,
} from './agentXDeployLimit.js';
export type AgentPreflightIssueCode =
  | 'invalid_name'
  | 'invalid_symbol'
  | 'ticker_reserved'
  | 'name_reserved'
  | 'ticker_cooldown'
  | 'name_cooldown'
  | 'community_launch_active'
  | 'fee_recipient_cooldown'
  | 'duplicate_deployer_name_symbol'
  | 'launch_mode_unavailable'
  | 'rate_limit_would_force_burn'
  | 'rate_limit_would_force_platform_fee'
  | 'agent_x_daily_limit'
  | 'third_party_rolling_warning';

export type AgentPreflightIssue = {
  code: AgentPreflightIssueCode;
  severity: 'block' | 'warn';
  message: string;
  /** Short copy for @bankrbot tweet/DM replies */
  replyHint: string;
  conflict?: unknown;
  /** Existing catalog token when ticker/name is taken */
  existingToken?: ExistingDeployToken;
};

export type AgentDeployPreflightInput = {
  wallet: Address;
  name: string;
  symbol: string;
  launchMode?: 'simple' | 'pro';
  /** `x` for Bankr/X thread launches — subject to daily free-launch cap. */
  agentChannel?: string | null;
};

export type AgentDeployPreflightResult = {
  ok: boolean;
  canDeploy: boolean;
  wallet: Address;
  name: string;
  symbol: string;
  launchMode: 'simple' | 'pro';
  cooldownHours: number;
  blocks: AgentPreflightIssue[];
  warnings: AgentPreflightIssue[];
  /** First blocking message for quick agent replies */
  blockMessage: string | null;
  /** Combined user-facing summary when deploy can proceed */
  proceedNotice: string | null;
  /** Populated when X daily limit blocks deploy. */
  xDailyLimit?: AgentXDeployLimitStatus;
};

function normalizeSymbol(raw: string): string {
  return raw.trim().toUpperCase().replace(/^\$/u, '').slice(0, 10);
}

function normalizeName(raw: string): string {
  return raw.trim().slice(0, 64);
}

export async function runAgentDeployPreflight(
  input: AgentDeployPreflightInput,
): Promise<AgentDeployPreflightResult> {
  const wallet = input.wallet;
  const name = normalizeName(input.name);
  const symbol = normalizeSymbol(input.symbol);
  const launchMode = input.launchMode ?? config.defaultLaunchMode;
  const deployerId = `agent:${wallet}`;

  const blocks: AgentPreflightIssue[] = [];
  const warnings: AgentPreflightIssue[] = [];
  let xDailyLimit: AgentXDeployLimitStatus | undefined;

  if (name.length < 2) {
    blocks.push({
      code: 'invalid_name',
      severity: 'block',
      message: 'Token name must be at least 2 characters.',
      replyHint: 'Need a token name (2+ chars) to launch on hood.markets.',
    });
  }

  if (symbol.length < 1) {
    blocks.push({
      code: 'invalid_symbol',
      severity: 'block',
      message: 'Symbol must be 1–10 characters.',
      replyHint: 'Need a ticker symbol (e.g. PEPE) to launch on hood.markets.',
    });
  }

  if (symbol.length >= 1 && isReservedTicker(symbol)) {
    const msg = reservedTickerUserMessage(symbol);
    blocks.push({
      code: 'ticker_reserved',
      severity: 'block',
      message: msg,
      replyHint: `Ticker $${symbol} is reserved on hood.markets — pick another symbol.`,
    });
  }

  if (name.length >= 2 && isReservedTokenName(name)) {
    const msg = reservedNameUserMessage();
    blocks.push({
      code: 'name_reserved',
      severity: 'block',
      message: msg,
      replyHint: 'That token name is reserved on hood.markets — choose a different name.',
    });
  }

  if (symbol.length >= 1 || name.length >= 2) {
    const clConflict = await getCommunityLaunchLockConflict(symbol, name);
    if (clConflict) {
      blocks.push({
        code: 'community_launch_active',
        severity: 'block',
        message: formatCommunityLaunchLockMessage(clConflict),
        replyHint: formatCommunityLaunchLockReplyHint(clConflict),
        conflict: clConflict,
      });
    }
  }

  if (symbol.length >= 1 && (await isTickerGloballyReserved(symbol))) {
    const conflict = await getGlobalTickerCooldownConflict(symbol);
    const msg = conflict
      ? formatDeployCooldownConflictMessage(conflict)
      : `Ticker $${normalizeCatalogTickerSymbol(symbol)} was already deployed recently. Choose another symbol or wait.`;
    blocks.push({
      code: 'ticker_cooldown',
      severity: 'block',
      message: msg,
      replyHint: conflict
        ? formatDeployCooldownReplyHint(conflict)
        : `Ticker $${symbol} is taken on hood.markets for now — try another symbol or wait ${globalTickerCooldownHours()}h.`,
      conflict: conflict ?? undefined,
      existingToken: conflict?.existing,
    });
  }

  if (name.length >= 2 && (await isNameGloballyReserved(name))) {
    const conflict = await getGlobalNameCooldownConflict(name);
    const msg = conflict
      ? formatDeployCooldownConflictMessage(conflict)
      : `Token name "${name}" was already deployed recently. Choose another name or wait.`;
    blocks.push({
      code: 'name_cooldown',
      severity: 'block',
      message: msg,
      replyHint: conflict
        ? formatDeployCooldownReplyHint(conflict)
        : `That name is taken on hood.markets — pick another name or wait ${globalTickerCooldownHours()}h.`,
      conflict: conflict ?? undefined,
      existingToken: conflict?.existing,
    });
  }

  if (name.length >= 2 && symbol.length >= 1) {
    const prior = await listDeploymentCatalogByDeployer(deployerId, 50, 0);
    const nameKey = name.toLowerCase();
    const symKey = symbol.replace(/^\$/, '').toUpperCase();
    const duplicate = prior.some(
      (row) =>
        row.tokenName.trim().toLowerCase() === nameKey &&
        row.tokenSymbol.replace(/^\$/, '').toUpperCase() === symKey,
    );
    if (duplicate) {
      const match = prior.find(
        (row) =>
          row.tokenName.trim().toLowerCase() === nameKey &&
          row.tokenSymbol.replace(/^\$/, '').toUpperCase() === symKey,
      );
      const existingToken: ExistingDeployToken | undefined = match
        ? {
            tokenName: match.tokenName,
            tokenSymbol: match.tokenSymbol,
            tokenAddress: match.tokenAddress,
          }
        : undefined;
      blocks.push({
        code: 'duplicate_deployer_name_symbol',
        severity: 'block',
        message:
          'This name and ticker were already launched successfully for your wallet. Pick a different name or ticker.',
        replyHint: existingToken
          ? `You already launched $${symbol} (${name}) at ${existingToken.tokenAddress}.\nhttps://hood.markets/?token=${existingToken.tokenAddress}`
          : `You already launched $${symbol} with that name on hood.markets — use a new name or ticker.`,
        existingToken,
      });
    }
  }

  if (!config.webOnlyMode) {
    const feeCooldownErr = await thirdPartyFeeRecipientCooldownErrorOrNull(wallet, {
      feeToSelf: false,
      rateLimitForcedBurn: false,
      feeRecipientLabel: undefined,
    });
    if (feeCooldownErr) {
      blocks.push({
        code: 'fee_recipient_cooldown',
        severity: 'block',
        message: feeCooldownErr,
        replyHint: `Your wallet hit hood.markets' deploy limit for today — wait ${globalTickerCooldownHours()}h or use another fee wallet.`,
      });
    }
  }

  if (launchMode === 'simple' && !config.hoodmarketsV3.factory) {
    blocks.push({
      code: 'launch_mode_unavailable',
      severity: 'block',
      message:
        'Simple launch (Uniswap V3) is not configured yet. Use launchMode "pro" or try again later.',
      replyHint: 'Simple launch is temporarily unavailable on hood.markets — try Pro mode or check back later.',
    });
  }

  if (launchMode === 'pro' && !config.liquid.factory) {
    blocks.push({
      code: 'launch_mode_unavailable',
      severity: 'block',
      message: 'Pro launch (Uniswap V4) is not configured on the API.',
      replyHint: 'Pro launch is temporarily unavailable on hood.markets — try Simple mode.',
    });
  }

  if (config.webOnlyMode) {
    if (isAgentXChannel(input.agentChannel)) {
      const limitBlock = await buildAgentXDeployLimitBlock(deployerId);
      if (limitBlock.status.limited) {
        xDailyLimit = limitBlock.status;
        blocks.push({
          code: 'agent_x_daily_limit',
          severity: 'block',
          message: limitBlock.message,
          replyHint: limitBlock.replyHint,
          ...(limitBlock.status.todayToken
            ? {
                existingToken: {
                  tokenName: limitBlock.status.todayToken.tokenName,
                  tokenSymbol: limitBlock.status.todayToken.tokenSymbol,
                  tokenAddress: limitBlock.status.todayToken.tokenAddress,
                },
              }
            : {}),
        });
      }
    } else {
      const limited = await applyWebDeployRateLimit({
        walletAddress: wallet,
        feeToSelf: true,
        deployerId,
        privyUserId: null,
      });
      if (limited.rateLimitForcedPlatformFee) {
        const notice = webDeployRateLimitPlatformNotice();
        warnings.push({
          code: 'rate_limit_would_force_platform_fee',
          severity: 'warn',
          message: notice,
          replyHint: notice,
        });
      }
    }
  } else {
    const limited = await applyDeployRateLimitBurn({
      walletAddress: wallet,
      feeToSelf: false,
      platform: 'web',
      deployerId,
      privyUserId: null,
    });
    if (limited.rateLimitForcedBurn) {
      warnings.push({
        code: 'rate_limit_would_force_burn',
        severity: 'warn',
        message: DEPLOY_LIMIT_MEME_PROCEED_USER_NOTICE,
        replyHint:
          'Heads up: you hit a hood.markets deploy limit — if you launch now, trading fees go to burn (No Dev meme), not your wallet.',
      });
    }

    const rollingH = deployRateLimitRollingHours();
    if (rollingH > 0) {
      const thirdRecent = await countThirdPartyFeeRecipientDeploymentsRollingHours(wallet, rollingH);
      if (thirdRecent > 0) {
        warnings.push({
          code: 'third_party_rolling_warning',
          severity: 'warn',
          message: `Your wallet already had a hood.markets launch in the last ${rollingH}h.`,
          replyHint: `Your wallet already had a hood.markets launch in the last ${rollingH}h — another deploy may route fees to burn.`,
        });
      }
    }
  }

  const canDeploy = blocks.length === 0;
  const blockMessage = blocks[0]?.message ?? null;
  const proceedNotice =
    warnings.length > 0 ? warnings.map((w) => w.message).join('\n\n') : null;

  return {
    ok: canDeploy,
    canDeploy,
    wallet,
    name,
    symbol,
    launchMode,
    cooldownHours: globalTickerCooldownHours(),
    blocks,
    warnings,
    blockMessage,
    proceedNotice,
    ...(xDailyLimit ? { xDailyLimit } : {}),
  };
}

/** Resolve catalog row by ticker (newest first). */
export async function resolveAgentTokenLookup(
  tokenOrSymbol: string,
): Promise<{ kind: 'address'; address: Address } | { kind: 'symbol'; symbol: string } | null> {
  const raw = tokenOrSymbol.trim();
  if (/^0x[0-9a-fA-F]{40}$/.test(raw)) {
    try {
      return { kind: 'address', address: getAddress(raw) };
    } catch {
      return null;
    }
  }
  const sym = normalizeCatalogTickerSymbol(raw);
  if (!sym) return null;
  return { kind: 'symbol', symbol: sym };
}
