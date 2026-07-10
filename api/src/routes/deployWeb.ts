import crypto from 'crypto';
import type { Express, Request, Response } from 'express';
import { createPublicClient, formatEther, http, getAddress, type Address } from 'viem';
import { robinhood, CHAIN_WETH } from '../lib/robinhoodChain.js';
import { config } from '../config.js';
import { logger } from '../logger.js';
import type { LiquidDeployer } from '../deployer.js';
import type { NeynarClient } from '../neynar.js';
import { verifyWebSessionBearer } from '../lib/webSessionAuth.js';
import { parseRecipientPaste } from '../lib/recipientPaste.js';
import { resolveWebFeeRecipient } from '../lib/webFeeRecipient.js';
import {
  fetchPrivyUserRecordById,
  formatWebDeployInitiatorAttribution,
  getEmbeddedEthAddressForPrivyUserId,
} from '../lib/privy.js';
import { checkAndRecordDeploy, hashDeployRequest, releaseDeployAttempt, type DeployRequest } from '../lib/deployDedup.js';
import { notifyDiscordWebLaunch } from '../lib/discordDebug.js';
import { webDeployCorsHeaders, webDeployCorsHeadersRead } from '../lib/webDeployCors.js';
import {
  DEPLOY_LIMIT_MEME_PROCEED_USER_NOTICE,
  MEME_TOKEN_DESCRIPTION_TAGLINE,
  RATE_LIMIT_FORCED_DEAD_FEE_LABEL,
} from '../lib/memeFeeRecipient.js';
import {
  deployerOtherFeeLimitProceedNotice,
  maxFeeRecipientDeploysPerEasternDay,
  maxOtherFeeDeploysPerEasternDay,
  maxThirdPartyFeeToSameWalletPerRollingWindow,
  shouldForceMemeDueToFeeRecipientLimit,
  shouldForceMemeDueToOtherFeeLimit,
  shouldForceMemeDueToThirdPartyWalletRateLimit,
  thirdPartyFeeRecipientLimitProceedNotice,
} from '../lib/feeRecipientLimit.js';
import { applyDeployRateLimitBurn } from '../lib/deployRateLimitBurn.js';
import {
  formatDeployCooldownConflictMessage,
  formatGlobalNameCooldownMessage,
  formatGlobalTickerCooldownMessage,
  getGlobalNameCooldownConflict,
  getGlobalTickerCooldownConflict,
  globalTickerCooldownHours,
  isNameGloballyReserved,
  isTickerGloballyReserved,
  thirdPartyFeeRecipientCooldownErrorOrNull,
} from '../lib/globalTickerCooldown.js';
import {
  formatCommunityLaunchLockMessage,
  getCommunityLaunchLockConflict,
} from '../lib/communityLaunchLock.js';
import {
  deployRateLimitRollingHours,
  maxSelfFeeDeploysPerRollingWindow,
  selfFeeDeployLimitErrorOrNull,
} from '../lib/selfFeeLimit.js';
import { runAfterPriorWebSelfFeeWork } from '../lib/webSelfFeeQueue.js';
import { runAfterPriorWebThirdPartyFeeWork } from '../lib/webThirdPartyFeeQueue.js';
import { resolveAgentWalletAuth, normalizeAgentChannel } from '../lib/agentWalletDeployAuth.js';
import { agentDeploySuccessReplyHint, resolveLaunchTweetUrl } from '../lib/agentDeployImage.js';
import {
  webInitialBuyDefaultEth,
  webInitialBuyRecommendedEth,
  parseWebInitialBuyWei,
  webInitialBuyMinEth,
  webInitialBuyMaxEth,
  WEB_INITIAL_BUY_PRESETS_ETH,
} from '../lib/deployBondEnv.js';
import {
  listSelfFeeTokensForFeeRecipient,
  listThirdPartyFeeTokensForFeeRecipientRollingHours,
  listDeploymentCatalogByDeployer,
  getDeploymentByTransactionHash,
  recordDeploymentCatalog,
  type DeploymentCatalogRow,
} from '../lib/deploymentCatalog.js';
import {
  isReservedTicker,
  isReservedTokenName,
  reservedNameUserMessage,
  reservedTickerUserMessage,
} from '../lib/reservedTokens.js';
import {
  parseAgentMetadataJson,
  serializeAgentDeployMetadata,
} from '../lib/agentDeployMetadata.js';
import {
  assertEthereumDeployConfigured,
  resolveDeployChain,
} from '../lib/deployChain.js';
import { formatDeployError } from '../lib/formatDeployError.js';
import { imageUploadService } from '../lib/imageUpload.js';
import {
  buildWebWalletDeployPrepare,
  completeWebWalletDeploy,
  assertWalletDeploySenderMatches,
} from '../lib/webWalletDeploy.js';
import {
  buildWebWalletDeployPrepareV3,
  completeWebWalletDeployV3,
} from '../lib/webWalletDeployV3.js';
import { clampBuyerRewardShareCount } from '../lib/hoodmarketsV3Deploy.js';
import {
  deserializeV3DeploymentConfig,
  v3DeploymentConfigRewardRecipient,
} from '../lib/v3DeploymentConfigJson.js';
import {
  deploymentConfigMsgValueWei,
  deserializeDeploymentConfig,
  type SerializedDeploymentConfig,
} from '../lib/deploymentConfigJson.js';
import {
  applyWebDeployRateLimit,
  RATE_LIMIT_FORCED_PLATFORM_FEE_LABEL,
  webDeployRateLimitPlatformNotice,
} from '../lib/webDeployRateLimit.js';
import {
  buildAgentXDeployLimitBlock,
  isAgentXChannel,
} from '../lib/agentXDeployLimit.js';
import { resolveRequesterXUsernameFromDeployInput } from '../lib/requesterXUsername.js';

function walletCompleteResultFromCatalogRow(
  row: DeploymentCatalogRow,
  deployChain: ReturnType<typeof resolveDeployChain>,
): Awaited<ReturnType<LiquidDeployer['deployToken']>> {
  return {
    tokenAddress: row.tokenAddress as `0x${string}`,
    poolId: row.poolId,
    transactionHash: row.transactionHash as `0x${string}`,
    blockNumber: BigInt(row.blockNumber),
    timestamp: Date.now(),
    chain: deployChain,
    ...(row.tokenImageUrl ? { imageUrl: row.tokenImageUrl } : {}),
  };
}

const agentPaymentPublicClient = createPublicClient({
  chain: robinhood,
  transport: http(config.chainRpcUrl),
});

/** HTTP(S) image URL or data:image/*;base64 (for client uploads; max ~2MB). */
function normalizeWebDeployImage(raw: unknown): string | undefined {
  if (typeof raw !== 'string') return undefined;
  const t = raw.trim();
  if (!t) return undefined;
  if (t.startsWith('https://') || t.startsWith('http://')) return t;
  if (t.startsWith('data:image/') && t.includes(';base64,')) {
    const maxChars = 2_800_000;
    if (t.length > maxChars) return undefined;
    return t;
  }
  return undefined;
}

function normalizeWebsiteUrl(raw: unknown): string | undefined {
  if (typeof raw !== 'string') return undefined;
  const t = raw.trim();
  if (!t) return undefined;
  const withProto = /^https?:\/\//i.test(t) ? t : `https://${t}`;
  try {
    const u = new URL(withProto);
    if (u.protocol !== 'http:' && u.protocol !== 'https:') return undefined;
    return u.toString().slice(0, 512);
  } catch {
    return undefined;
  }
}

/** Accepts https URL or @handle / handle → https://x.com/handle */
function normalizeTokenXUrl(raw: unknown): string | undefined {
  if (typeof raw !== 'string') return undefined;
  let t = raw.trim();
  if (!t) return undefined;
  if (/^https?:\/\//i.test(t)) {
    try {
      const u = new URL(t);
      if (!/^(x\.com|twitter\.com|www\.x\.com|www\.twitter\.com)$/i.test(u.hostname)) {
        return undefined;
      }
      return u.toString().slice(0, 512);
    } catch {
      return undefined;
    }
  }
  t = t.replace(/^@/, '').replace(/^x\.com\//i, '').replace(/^twitter\.com\//i, '');
  if (!/^[A-Za-z0-9_]{1,15}$/.test(t)) return undefined;
  return `https://x.com/${t}`.slice(0, 512);
}

interface DeployWebBody {
  name?: string;
  symbol?: string;
  imageUrl?: string;
  websiteUrl?: string;
  xUrl?: string;
  description?: string;
  feeTarget?: 'self' | 'other' | 'no_dev' | 'agent_wallet';
  /** Browser-stable id when deploying No Dev without Privy (dedup + abuse tracing). */
  anonymousClientId?: string;
  /** Set to `agent` when the caller is automation (curl, agent) — UI shows an Agent card. */
  clientKind?: string;
  /**
   * With `feeTarget: agent_wallet` — X-Agent-Captcha-JWT header is required.
   * The wallet address is extracted from the CAPTCHA JWT claims (walletAddress field).
   */
  agentCaptchaJwt?: string;
  /** Optional: e.g. `bankr` — stored in catalog + echoed in deploy response. */
  agentProvider?: string;
  /** Optional: where the agent runs, e.g. `cloud`, `user-device`, `x`. */
  agentRuntime?: string;
  /** Optional: intake channel — `x` skips haiku (Bankr confirms in-thread); other agents use haiku JWT. */
  agentChannel?: string;
  /** Optional: wallet stack, e.g. `bankr-evm`, `injected`. */
  walletKind?: string;
  /** Optional extra string metadata (merged with the fields above). */
  agentMetadata?: Record<string, unknown>;
  /** Original X launch tweet — stored in catalog `source_url` for token page embed. */
  tweetUrl?: string;
  tweet_url?: string;
  tweetId?: string;
  tweet_id?: string;
  sourceUrl?: string;
  recipientAddress?: string;
  farcasterUsername?: string;
  xUsername?: string;
  githubUsername?: string;
  telegramUsername?: string;
  discordUserId?: string;
  recipientPaste?: string;
  /** `base` (default) or `ethereum` (Ethereum mainnet). Requires `ETHEREUM_DEPLOY_ENABLED=true`. */
  chain?: string;
  /** ETH for bundled Univ4EthDevBuy in wallet-signed deploy (min/max from env). `0` = server deploy only. */
  initialBuyEth?: string | number;
  /** `prepare` returns factory calldata; `complete` records after user signs `deployToken`. */
  walletDeployPhase?: 'prepare' | 'complete';
  transactionHash?: string;
  deploymentConfig?: SerializedDeploymentConfig;
  /** `simple` = HoodMarkets V3 (DexScreener). `pro` = HoodMarkets V4 hooks. */
  launchMode?: 'simple' | 'pro';
  /** Optional Holder NFT shares escrowed for automatic first-buyer rewards (0–1000). */
  buyerRewardShareCount?: number | string;
  /** Paid X/Bankr deploy over daily free cap — from HTTP 402 `commitment`. */
  deployCommitment?: string;
  /** Robinhood ETH payment tx from agent wallet to treasury (402 flow). */
  paymentTxHash?: string;
}

function normalizeAnonymousClientId(raw: unknown): string | null {
  if (typeof raw !== 'string') return null;
  const t = raw.trim();
  if (t.length < 8 || t.length > 128) return null;
  if (!/^[a-zA-Z0-9_-]+$/.test(t)) return null;
  return t;
}

function hasBearerToken(authHeader: string | undefined): boolean {
  return !!authHeader?.startsWith('Bearer ') && authHeader.slice('Bearer '.length).trim().length > 0;
}

type WebFeeInput =
  | { kind: 'no_dev' }
  | { kind: 'wallet_self'; walletAddress: Address; walletKind?: string }
  | { kind: 'self'; privyUserId: string; privyUser?: unknown }
  | {
      kind: 'other';
      address?: string;
      farcasterUsername?: string;
      xUsername?: string;
      githubUsername?: string;
      telegramUsername?: string;
      discordUserId?: string;
    };

function buildSelfFeeInput(
  feeTarget: string,
  userId: string,
  walletAuth: { address: Address; walletKind: string } | null,
  privyUserRecord: unknown,
): WebFeeInput {
  if (walletAuth) {
    return {
      kind: 'wallet_self',
      walletAddress: walletAuth.address,
      walletKind: walletAuth.walletKind,
    };
  }
  return {
    kind: 'self',
    privyUserId: userId,
    privyUser: privyUserRecord ?? undefined,
  };
}

function isSelfFeeKind(fee: WebFeeInput): boolean {
  return fee.kind === 'self' || fee.kind === 'wallet_self';
}

type WebDeployPreviewResult = {
  rateLimitForcedPlatformFee: boolean;
  notice: string | null;
};

/**
 * Same auth + fee resolution + `applyDeployRateLimitBurn` as POST /api/deploy, without deploying.
 * Used by the web UI to confirm before launch when the next deploy would route fees to burn.
 */
async function previewWebDeployRateLimit(
  req: Request,
  neynar: NeynarClient,
): Promise<WebDeployPreviewResult> {
  const body = req.body as DeployWebBody;
  const paste =
    typeof body.recipientPaste === 'string' ? parseRecipientPaste(body.recipientPaste) : {};

  const isAgentWalletDeploy = body.feeTarget === 'agent_wallet';

  const feeTarget: 'self' | 'other' | 'no_dev' | 'agent_wallet' =
    body.feeTarget === 'agent_wallet'
      ? 'agent_wallet'
      : body.feeTarget === 'no_dev'
        ? 'no_dev'
        : body.feeTarget === 'other'
          ? 'other'
          : 'self';

  const bearer = hasBearerToken(req.headers.authorization);
  const allowAnonNoDev = feeTarget === 'no_dev' && !bearer;

  if (!allowAnonNoDev && !isAgentWalletDeploy && !config.webWallet.enabled && !config.privy.enabled) {
    throw new Error('Web deploy requires wallet login (WEB_WALLET_JWT_SECRET) or Privy.');
  }

  let userId: string;
  let anonymousNoDev = false;
  let agentWalletDeploy = false;
  let agentVerifiedFee: Address | null = null;
  let walletAuth: { address: Address; walletKind: string } | null = null;
  let usePrivySelfFee = false;

  if (isAgentWalletDeploy) {
    const agentAuth = await resolveAgentWalletAuth(req.headers as any, body);
    agentVerifiedFee = agentAuth.walletAddress;
    userId = `agent:${agentVerifiedFee}`;
    agentWalletDeploy = true;
  } else if (allowAnonNoDev) {
    const aid = normalizeAnonymousClientId(body.anonymousClientId);
    if (!aid) {
      throw new Error(
        'No Dev without sign-in requires anonymousClientId (the app generates one in session storage).',
      );
    }
    userId = `web-anon:${aid}`;
    anonymousNoDev = true;
  } else {
    const session = await verifyWebSessionBearer(req.headers.authorization);
    userId = session.userId;
    if (session.kind === 'wallet') {
      walletAuth = { address: session.walletAddress, walletKind: session.walletKind };
    } else {
      usePrivySelfFee = true;
    }
  }

  let fee: WebFeeInput;

  if (isAgentWalletDeploy && agentVerifiedFee) {
    fee = { kind: 'other', address: agentVerifiedFee };
  } else if (feeTarget === 'no_dev') {
    fee = { kind: 'no_dev' };
  } else if (feeTarget === 'self') {
    fee = buildSelfFeeInput(feeTarget, userId, walletAuth, null);
  } else {
    fee = {
      kind: 'other',
      address: body.recipientAddress?.trim() || paste.walletAddress,
      farcasterUsername: body.farcasterUsername?.trim() || paste.farcasterUsername,
      xUsername: body.xUsername?.trim() || paste.xUsername,
      githubUsername: body.githubUsername?.trim() || paste.githubUsername,
      telegramUsername:
        (typeof body.telegramUsername === 'string' ? body.telegramUsername.trim() : undefined) ||
        paste.telegramUsername,
      discordUserId:
        (typeof body.discordUserId === 'string' ? body.discordUserId.trim() : undefined) ||
        paste.discordUserId,
    };
  }

  const resolved = await resolveWebFeeRecipient(neynar, fee);

  if (fee.kind === 'no_dev') {
    return { rateLimitForcedPlatformFee: false, notice: null };
  }

  if (config.webOnlyMode && (isSelfFeeKind(fee) || agentWalletDeploy)) {
    const limited = await applyWebDeployRateLimit({
      walletAddress: resolved.walletAddress,
      feeRecipientLabel: resolved.feeRecipientLabel,
      feeToSelf: true,
      deployerId: userId,
      privyUserId: usePrivySelfFee && !anonymousNoDev && !agentWalletDeploy ? userId : null,
    });
    return {
      rateLimitForcedPlatformFee: limited.rateLimitForcedPlatformFee,
      notice: limited.rateLimitForcedPlatformFee ? webDeployRateLimitPlatformNotice() : null,
    };
  }

  if (config.strictDeployRateLimits && isSelfFeeKind(fee)) {
    const limitErr = await selfFeeDeployLimitErrorOrNull({
      privyUserId: usePrivySelfFee && !anonymousNoDev && !agentWalletDeploy ? userId : null,
      platform: 'web',
      deployerId: userId,
    });
    if (limitErr) {
      throw new Error(limitErr);
    }
  }

  const limited = await applyDeployRateLimitBurn({
    walletAddress: resolved.walletAddress,
    feeRecipientLabel: resolved.feeRecipientLabel,
    feeToSelf: isSelfFeeKind(fee),
    platform: 'web',
    deployerId: userId,
    privyUserId: usePrivySelfFee && !anonymousNoDev && !agentWalletDeploy ? userId : null,
  });

  const burnForced = limited.rateLimitForcedBurn;
  let notice: string | null = null;
  if (burnForced && fee.kind === 'other') {
    const limitKey = {
      privyUserId: usePrivySelfFee && !anonymousNoDev && !agentWalletDeploy ? userId : null,
      platform: 'web' as const,
      deployerId: userId,
    };
    const forceDeployer = await shouldForceMemeDueToOtherFeeLimit(limitKey);
    notice = forceDeployer
      ? deployerOtherFeeLimitProceedNotice()
      : thirdPartyFeeRecipientLimitProceedNotice(deployRateLimitRollingHours());
  } else if (burnForced) {
    notice = DEPLOY_LIMIT_MEME_PROCEED_USER_NOTICE;
  }

  return {
    rateLimitForcedPlatformFee: burnForced,
    notice,
  };
}

export function registerWebDeployRoutes(
  app: Express,
  deployer: LiquidDeployer,
  neynar: NeynarClient,
): void {
  app.options('/api/web-deploy-config', (req, res) => {
    const h = webDeployCorsHeadersRead(req.headers.origin);
    for (const [k, v] of Object.entries(h)) res.setHeader(k, v);
    res.status(204).end();
  });

  app.get('/api/web-deploy-config', (req: Request, res: Response) => {
    const h = webDeployCorsHeadersRead(req.headers.origin);
    for (const [k, v] of Object.entries(h)) res.setHeader(k, v);
    res.json({
      ethereumDeployEnabled: config.ethereum.deployEnabled,
      deployDefaultChain: config.deployDefaultChain,
      ethereumVanityAddresses: config.ethereum.clankerVanityAddresses,
      chainId: 4663,
      strictDeployRateLimits: config.strictDeployRateLimits,
      globalTickerCooldownHours: globalTickerCooldownHours(),
      maxSelfFeeDeploysPer24h: maxSelfFeeDeploysPerRollingWindow(),
      deployRateLimitHours: deployRateLimitRollingHours(),
      maxFeeRecipientDeploysPerEasternDay: maxFeeRecipientDeploysPerEasternDay(),
      maxThirdPartyFeeToWalletPer24h: maxThirdPartyFeeToSameWalletPerRollingWindow(),
      maxOtherFeeDeploysPerEasternDay: maxOtherFeeDeploysPerEasternDay(),
      thirdPartyFeeDeployEnabled: true,
      platformFeeBps: config.platformFeeBps,
      platformFeePercent: Number((config.platformFeeBps / 100).toFixed(2)),
      /** Embedded in HoodMarkets V3 LpLocker when using simple launch. */
      v3PlatformFeePercent: 5,
      defaultLaunchMode: config.defaultLaunchMode,
      v3LaunchEnabled: !!config.hoodmarketsV3.factory,
      proLaunchEnabled: !!config.liquid.factory,
      imageUploadEnabled: imageUploadService.isConfigured(),
      /** Fixed WETH seed at launch — paid by launcher wallet for agents only (`DEPLOY_BOND_ETH`). */
      platformSubsidizedInitialBuyEth: Number(webInitialBuyDefaultEth()),
      initialBuyMinEth: webInitialBuyMinEth(),
      initialBuyMaxEth: webInitialBuyMaxEth(),
      initialBuyDefaultEth: webInitialBuyDefaultEth(),
      initialBuyRecommendedEth: webInitialBuyRecommendedEth(),
      initialBuyPresetsEth: [...WEB_INITIAL_BUY_PRESETS_ETH],
      walletDeployEnabled: true,
      feeClaimContracts: {
        liquidLpLocker: config.liquid.lpLocker || undefined,
        feeLocker: config.liquid.feeLocker || undefined,
        weth: CHAIN_WETH,
      },
    });
  });

  app.options('/api/deploy-cooldown-check', (req, res) => {
    const h = webDeployCorsHeadersRead(req.headers.origin);
    for (const [k, v] of Object.entries(h)) res.setHeader(k, v);
    res.status(204).end();
  });

  app.get('/api/deploy-cooldown-check', async (req: Request, res: Response) => {
    const h = webDeployCorsHeadersRead(req.headers.origin);
    for (const [k, v] of Object.entries(h)) res.setHeader(k, v);

    const rawSymbol = typeof req.query.symbol === 'string' ? req.query.symbol.trim() : '';
    const rawName = typeof req.query.name === 'string' ? req.query.name.trim() : '';
    const symbol = rawSymbol.toUpperCase().slice(0, 10);
    const name = rawName;

    const tickerConflict =
      symbol.length >= 1 ? await getGlobalTickerCooldownConflict(symbol) : null;
    const nameConflict =
      name.length >= 2 ? await getGlobalNameCooldownConflict(name) : null;
    const communityLaunchConflict =
      symbol.length >= 1 || name.length >= 2
        ? await getCommunityLaunchLockConflict(symbol, name)
        : null;
    const tickerReserved = symbol.length >= 1 && isReservedTicker(symbol);
    const nameReserved = name.length >= 2 && isReservedTokenName(name);

    res.json({
      cooldownHours: globalTickerCooldownHours(),
      tickerConflict,
      nameConflict,
      communityLaunchConflict,
      communityLaunchMessage: communityLaunchConflict
        ? formatCommunityLaunchLockMessage(communityLaunchConflict)
        : null,
      tickerReserved,
      nameReserved,
      reservedTickerMessage: tickerReserved ? reservedTickerUserMessage(symbol) : null,
      reservedNameMessage: nameReserved ? reservedNameUserMessage() : null,
    });
  });

  app.options('/api/deploy', (req, res) => {
    const h = webDeployCorsHeaders(req.headers.origin);
    for (const [k, v] of Object.entries(h)) res.setHeader(k, v);
    res.status(204).end();
  });

  app.options('/api/deploy-preview', (req, res) => {
    const h = webDeployCorsHeaders(req.headers.origin);
    for (const [k, v] of Object.entries(h)) res.setHeader(k, v);
    res.status(204).end();
  });

  app.post('/api/deploy-preview', async (req: Request, res: Response) => {
    const h = webDeployCorsHeaders(req.headers.origin);
    for (const [k, v] of Object.entries(h)) res.setHeader(k, v);
    try {
      const out = await previewWebDeployRateLimit(req, neynar);
      res.json(out);
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : 'Preview failed';
      logger.warn('Web deploy preview failed', { error: msg });
      let status = 500;
      if (/authorization|bearer|access token|privy is not configured/i.test(msg)) {
        status = 401;
      } else if (
        msg.includes('not found') ||
        msg.includes('Invalid') ||
        msg.includes('must be') ||
        msg.includes('Choose a fee') ||
        msg.includes('No embedded Ethereum') ||
        msg.includes('requires') ||
        msg.includes('anonymousClientId')
      ) {
        status = 400;
      } else if (
        msg.includes('You can only launch') ||
        msg.includes('Deploy rate limit reached')
      ) {
        status = 409;
      }
      res.status(status).json({ error: msg });
    }
  });

  app.post('/api/deploy', async (req: Request, res: Response) => {
    const h = webDeployCorsHeaders(req.headers.origin);
    for (const [k, v] of Object.entries(h)) res.setHeader(k, v);

    try {
      const body = req.body as DeployWebBody;
      const name = typeof body.name === 'string' ? body.name.trim() : '';
      const symbolRaw = typeof body.symbol === 'string' ? body.symbol.trim() : '';
      const symbol = symbolRaw.toUpperCase().slice(0, 10);

      if (name.length < 2 || name.length > 64) {
        res.status(400).json({ error: 'Token name must be 2–64 characters.' });
        return;
      }
      if (symbol.length < 1 || symbol.length > 10) {
        res.status(400).json({ error: 'Symbol must be 1–10 characters.' });
        return;
      }

      if (isReservedTicker(symbol)) {
        res.status(400).json({ error: reservedTickerUserMessage(symbol) });
        return;
      }
      if (isReservedTokenName(name)) {
        res.status(400).json({ error: reservedNameUserMessage() });
        return;
      }

      const communityLaunchConflict = await getCommunityLaunchLockConflict(symbol, name);
      if (communityLaunchConflict) {
        res.status(409).json({
          error: formatCommunityLaunchLockMessage(communityLaunchConflict),
          communityLaunch: communityLaunchConflict,
        });
        return;
      }

      if (await isTickerGloballyReserved(symbol)) {
        const conflict = await getGlobalTickerCooldownConflict(symbol);
        res.status(409).json({
          error: conflict
            ? formatDeployCooldownConflictMessage(conflict)
            : await formatGlobalTickerCooldownMessage(symbol),
          conflict,
        });
        return;
      }

      if (await isNameGloballyReserved(name)) {
        const conflict = await getGlobalNameCooldownConflict(name);
        res.status(409).json({
          error: conflict
            ? formatDeployCooldownConflictMessage(conflict)
            : await formatGlobalNameCooldownMessage(name),
          conflict,
        });
        return;
      }

      const imageUrl = normalizeWebDeployImage(body.imageUrl);
      if (!imageUrl) {
        res.status(400).json({
          error:
            'Token logo is required. Upload an image on the Launch tab or paste a public HTTPS image URL.',
        });
        return;
      }
      const userDescription = typeof body.description === 'string' ? body.description.trim() : '';
      const websiteUrl = normalizeWebsiteUrl(body.websiteUrl);
      const xUrl = normalizeTokenXUrl(body.xUrl);
      const launchTweetUrl = resolveLaunchTweetUrl(body);
      if (typeof body.websiteUrl === 'string' && body.websiteUrl.trim() && !websiteUrl) {
        res.status(400).json({ error: 'Website must be a valid https URL.' });
        return;
      }
      if (typeof body.xUrl === 'string' && body.xUrl.trim() && !xUrl) {
        res.status(400).json({ error: 'X link must be a valid x.com URL or @handle.' });
        return;
      }

      const clientKindRaw =
        typeof body.clientKind === 'string' ? body.clientKind.trim().toLowerCase() : '';
      let webClientKind: 'web' | 'agent' = clientKindRaw === 'agent' ? 'agent' : 'web';

      const paste =
        typeof body.recipientPaste === 'string' ? parseRecipientPaste(body.recipientPaste) : {};

      const deployChain = resolveDeployChain({ explicit: body.chain });
      if (deployChain === 'ethereum') {
        assertEthereumDeployConfigured();
      }

      const isAgentWalletDeploy = body.feeTarget === 'agent_wallet';

      const feeTarget: 'self' | 'other' | 'no_dev' | 'agent_wallet' =
        body.feeTarget === 'agent_wallet'
          ? 'agent_wallet'
          : body.feeTarget === 'no_dev'
            ? 'no_dev'
            : body.feeTarget === 'other'
              ? 'other'
              : 'self';

      const bearer = hasBearerToken(req.headers.authorization);
      const allowAnonNoDev = feeTarget === 'no_dev' && !bearer;

      if (!allowAnonNoDev && !isAgentWalletDeploy && !config.webWallet.enabled && !config.privy.enabled) {
        res.status(503).json({ error: 'Web login is not configured on the server.' });
        return;
      }

      let userId: string;
      let anonymousNoDev = false;
      let agentWalletDeploy = false;
      let agentVerifiedFee: Address | null = null;
      let walletAuth: { address: Address; walletKind: string } | null = null;
      let usePrivySelfFee = false;
      let agentMetadataJson: string | undefined;
      let agentProviderForLabel = '';
      let agentChannel: string | null = null;
      let agentAuthKind: 'captcha' | 'x_confirm' | 'trusted_agent' = 'captcha';
      let requesterXUsername: string | undefined;

      if (isAgentWalletDeploy) {
        webClientKind = 'agent';
        const agentAuth = await resolveAgentWalletAuth(req.headers as any, body);
        agentVerifiedFee = agentAuth.walletAddress;
        agentChannel =
          agentAuth.agentChannel ??
          normalizeAgentChannel(req.headers as any, body);
        requesterXUsername = resolveRequesterXUsernameFromDeployInput({
          xUsername: body.xUsername?.trim() || paste.xUsername,
          tweetUrl: launchTweetUrl ?? body.tweetUrl ?? body.tweet_url,
          sourceUrl: body.sourceUrl,
          launchTweetUrl,
        });
        agentAuthKind = agentAuth.auth;
        agentMetadataJson = serializeAgentDeployMetadata({
          ...body,
          ...(launchTweetUrl ? { launchTweetUrl } : {}),
          ...(requesterXUsername ? { xUsername: requesterXUsername } : {}),
          auth: agentAuth.auth,
          agentId: agentAuth.agentId,
        });

        userId = `agent:${agentVerifiedFee}`;
        agentWalletDeploy = true;
        agentProviderForLabel =
          typeof body.agentProvider === 'string' ? body.agentProvider.trim().slice(0, 64) : '';
      } else if (allowAnonNoDev) {
        const aid = normalizeAnonymousClientId(body.anonymousClientId);
        if (!aid) {
          res.status(400).json({
            error:
              'No Dev without sign-in requires anonymousClientId (the app generates one in session storage).',
          });
          return;
        }
        userId = `web-anon:${aid}`;
        anonymousNoDev = true;
      } else {
        const session = await verifyWebSessionBearer(req.headers.authorization);
        userId = session.userId;
        if (session.kind === 'wallet') {
          walletAuth = { address: session.walletAddress, walletKind: session.walletKind };
        } else {
          usePrivySelfFee = true;
        }
      }

      const runSelfFeeQueued =
        feeTarget === 'self' && !allowAnonNoDev && !isAgentWalletDeploy;
      const runThirdPartyQueued =
        (feeTarget === 'other' || isAgentWalletDeploy) && !allowAnonNoDev;

      const thirdPartyQueueKey = (): string => {
        if (agentVerifiedFee) {
          try {
            return getAddress(agentVerifiedFee).toLowerCase();
          } catch {
            return 'agent-fee';
          }
        }
        const raw = body.recipientAddress?.trim() || paste.walletAddress;
        if (raw && /^0x[a-fA-F0-9]{40}$/i.test(raw)) {
          try {
            return getAddress(raw).toLowerCase();
          } catch {
            /* fall through */
          }
        }
        const parts = [
          body.farcasterUsername,
          body.xUsername,
          body.githubUsername,
          body.telegramUsername,
          body.discordUserId,
          paste.farcasterUsername,
          paste.xUsername,
          paste.githubUsername,
          paste.telegramUsername,
          paste.discordUserId,
        ]
          .map((s) => (typeof s === 'string' ? s.trim().toLowerCase() : ''))
          .filter(Boolean);
        return parts.join('|') || 'web-other-fee';
      };

      const executeDeploy = async (): Promise<void> => {
      let privyUserRecord: unknown = null;
      if (usePrivySelfFee && !anonymousNoDev && !agentWalletDeploy) {
        try {
          privyUserRecord = await fetchPrivyUserRecordById(userId);
        } catch (e: unknown) {
          logger.warn('Could not load Privy user for web deploy', {
            message: e instanceof Error ? e.message : String(e),
          });
        }
      }

      let fee: WebFeeInput;

      if (isAgentWalletDeploy && agentVerifiedFee) {
        fee = { kind: 'other', address: agentVerifiedFee };
      } else if (feeTarget === 'no_dev') {
        fee = { kind: 'no_dev' };
      } else if (feeTarget === 'self') {
        fee = buildSelfFeeInput(feeTarget, userId, walletAuth, privyUserRecord);
      } else {
        fee = {
          kind: 'other',
          address: body.recipientAddress?.trim() || paste.walletAddress,
          farcasterUsername: body.farcasterUsername?.trim() || paste.farcasterUsername,
          xUsername: body.xUsername?.trim() || paste.xUsername,
          githubUsername: body.githubUsername?.trim() || paste.githubUsername,
          telegramUsername:
            (typeof body.telegramUsername === 'string' ? body.telegramUsername.trim() : undefined) ||
            paste.telegramUsername,
          discordUserId:
            (typeof body.discordUserId === 'string' ? body.discordUserId.trim() : undefined) ||
            paste.discordUserId,
        };
      }

      let resolved = await resolveWebFeeRecipient(neynar, fee);

      let rateLimitForcedPlatformFee = false;
      let rateLimitForcedBurn = false;

      if (agentWalletDeploy && isAgentXChannel(agentChannel)) {
        const limitBlock = await buildAgentXDeployLimitBlock(userId);
        if (limitBlock.status.limited) {
          res.status(409).json({
            error: limitBlock.message,
            replyHint: limitBlock.replyHint,
            xDailyLimit: limitBlock.status,
          });
          return;
        }
      } else if (config.webOnlyMode && (isSelfFeeKind(fee) || agentWalletDeploy)) {
        const limited = await applyWebDeployRateLimit({
          walletAddress: resolved.walletAddress,
          feeRecipientLabel: resolved.feeRecipientLabel,
          feeToSelf: true,
          deployerId: userId,
          privyUserId: usePrivySelfFee && !anonymousNoDev && !agentWalletDeploy ? userId : null,
        });
        rateLimitForcedPlatformFee = limited.rateLimitForcedPlatformFee;
        resolved = {
          ...resolved,
          walletAddress: limited.walletAddress,
          ...(limited.feeRecipientLabel ? { feeRecipientLabel: limited.feeRecipientLabel } : {}),
        };
      } else {
        if (config.strictDeployRateLimits && isSelfFeeKind(fee)) {
          const limitErr = await selfFeeDeployLimitErrorOrNull({
            privyUserId: usePrivySelfFee && !anonymousNoDev && !agentWalletDeploy ? userId : null,
            platform: 'web',
            deployerId: userId,
          });
          if (limitErr) {
            res.status(409).json({ error: limitErr });
            return;
          }
        }

        if (fee.kind !== 'no_dev') {
          const limited = await applyDeployRateLimitBurn({
            walletAddress: resolved.walletAddress,
            feeRecipientLabel: resolved.feeRecipientLabel,
            feeToSelf: isSelfFeeKind(fee),
            platform: 'web',
            deployerId: userId,
            privyUserId:
              !anonymousNoDev && !agentWalletDeploy ? userId : null,
          });
          rateLimitForcedBurn = limited.rateLimitForcedBurn;
          if (limited.rateLimitForcedBurn) {
            resolved = {
              walletAddress: limited.walletAddress,
              feeSummaryLine: `No Dev — ${MEME_TOKEN_DESCRIPTION_TAGLINE}`,
              feeRecipientLabel: limited.feeRecipientLabel ?? RATE_LIMIT_FORCED_DEAD_FEE_LABEL,
            };
          } else {
            resolved = {
              ...resolved,
              walletAddress: limited.walletAddress,
              ...(limited.feeRecipientLabel
                ? { feeRecipientLabel: limited.feeRecipientLabel }
                : {}),
            };
          }
        }
      }

      let initiatorAttribution = 'signed-in user';
      if (anonymousNoDev) {
        initiatorAttribution = 'anonymous visitor (No Dev)';
      } else if (agentWalletDeploy && agentVerifiedFee) {
        initiatorAttribution = `verified agent wallet ${agentVerifiedFee.slice(0, 6)}…${agentVerifiedFee.slice(-4)}`;
      } else if (privyUserRecord) {
        initiatorAttribution = formatWebDeployInitiatorAttribution(privyUserRecord);
      }

      const feeBlock = `${resolved.feeSummaryLine}. Deployed via hoodmarkets by ${initiatorAttribution}.`;
      const useMemeTagline =
        ((feeTarget === 'no_dev' || fee.kind === 'no_dev') && !isAgentWalletDeploy) ||
        rateLimitForcedBurn;
      const platformFeeNote = rateLimitForcedPlatformFee
        ? 'Trading fees on this token go to hood.markets (24h deploy limit).'
        : '';
      const fullDescription = [
        userDescription,
        useMemeTagline ? MEME_TOKEN_DESCRIPTION_TAGLINE : '',
        platformFeeNote,
        feeBlock,
      ]
        .filter(Boolean)
        .join('\n\n');

      const feeCooldownErr =
        config.webOnlyMode
          ? null
          : await thirdPartyFeeRecipientCooldownErrorOrNull(
              resolved.walletAddress,
              {
                feeToSelf:
                  (isSelfFeeKind(fee) || (agentWalletDeploy && config.webOnlyMode)) &&
                  !rateLimitForcedBurn &&
                  !rateLimitForcedPlatformFee,
                rateLimitForcedBurn,
                feeRecipientLabel: resolved.feeRecipientLabel,
              },
            );
      if (feeCooldownErr) {
        res.status(409).json({ error: feeCooldownErr });
        return;
      }

      let userInitialBuyWei = 0n;
      try {
        userInitialBuyWei = parseWebInitialBuyWei(body.initialBuyEth, 0n);
      } catch (e: unknown) {
        const msg = e instanceof Error ? e.message : 'Invalid initial buy amount';
        res.status(400).json({ error: msg });
        return;
      }

      if (userInitialBuyWei > 0n && (anonymousNoDev || agentWalletDeploy)) {
        res.status(400).json({
          error:
            'Paying pool seed from your wallet is not supported for this launch type. Use 0 or omit initialBuyEth.',
        });
        return;
      }

      const launchModeRaw =
        typeof body.launchMode === 'string' ? body.launchMode.trim().toLowerCase() : '';
      const launchMode: 'simple' | 'pro' =
        launchModeRaw === 'pro' ? 'pro' : launchModeRaw === 'simple' ? 'simple' : config.defaultLaunchMode;

      const buyerRewardShareCount =
        body.buyerRewardShareCount !== undefined && body.buyerRewardShareCount !== ''
          ? clampBuyerRewardShareCount(body.buyerRewardShareCount)
          : 0;

      const deployerPaysPoolSeed =
        (feeTarget === 'self' || feeTarget === 'other') &&
        !anonymousNoDev &&
        !agentWalletDeploy &&
        (launchMode === 'simple' || launchMode === 'pro');

      if (deployerPaysPoolSeed && userInitialBuyWei === 0n) {
        userInitialBuyWei = config.deployBondWei;
      }

      let deployerWallet: Address | undefined;
      if (!anonymousNoDev && !agentWalletDeploy && deployerPaysPoolSeed) {
        if (walletAuth) {
          deployerWallet = walletAuth.address;
        } else {
          const embedded = await getEmbeddedEthAddressForPrivyUserId(userId);
          if (embedded) {
            try {
              deployerWallet = getAddress(embedded);
            } catch {
              deployerWallet = undefined;
            }
          }
        }
      }

      if (launchMode === 'simple' && !config.hoodmarketsV3.factory) {
        res.status(503).json({
          error:
            'Simple launch (Uniswap V3) is not configured yet. Set HOODMARKETS_V3_FACTORY on the API, or use launchMode "pro".',
        });
        return;
      }

      const useWalletDeploy =
        deployerPaysPoolSeed &&
        userInitialBuyWei > 0n &&
        deployerWallet != null;

      const walletDeploySigner = deployerWallet ?? resolved.walletAddress;

      if (deployerPaysPoolSeed && !useWalletDeploy) {
        res.status(400).json({
          error:
            'Connect a wallet with enough ETH for the pool seed plus gas. hood.markets does not pay deployment costs on the website.',
        });
        return;
      }

      if (
        useWalletDeploy &&
        feeTarget === 'self' &&
        deployerWallet &&
        getAddress(resolved.walletAddress) !== deployerWallet
      ) {
        res.status(400).json({
          error:
            'Your connected wallet must match the fee recipient for Me launches. Reconnect the wallet shown in your profile.',
        });
        return;
      }

      const walletPhase =
        body.walletDeployPhase === 'complete'
          ? 'complete'
          : body.walletDeployPhase === 'prepare'
            ? 'prepare'
            : null;

      if (useWalletDeploy && walletPhase === 'prepare') {
        if (launchMode === 'simple') {
          const prepare = await buildWebWalletDeployPrepareV3({
            name,
            symbol,
            tokenAdmin: resolved.walletAddress,
            devBuyAmount: userInitialBuyWei,
            description: fullDescription,
            imageUrl,
            websiteUrl,
            xUrl,
            platform: 'web',
            clientKind: webClientKind,
            feesToPlatformOnly: rateLimitForcedPlatformFee,
            buyerRewardShareCount,
          });
          res.json(prepare);
          return;
        }
        const prepare = await buildWebWalletDeployPrepare({
          name,
          symbol,
          tokenAdmin: resolved.walletAddress,
          devBuyAmount: userInitialBuyWei,
          description: fullDescription,
          imageUrl,
          websiteUrl,
          xUrl,
          feesToPlatformOnly: rateLimitForcedPlatformFee,
          platform: 'web',
          clientKind: webClientKind,
        });
        res.json(prepare);
        return;
      }

      if (useWalletDeploy && walletPhase !== 'complete') {
        res.status(400).json({
          error:
            'Wallet initial buy requires walletDeployPhase "prepare" then "complete" after you sign deployToken in your wallet.',
        });
        return;
      }

      if (deployerPaysPoolSeed && !useWalletDeploy) {
        res.status(400).json({
          error:
            'Connect a wallet with enough ETH for the pool seed plus gas. hood.markets does not pay deployment costs on the website.',
        });
        return;
      }

      let devBuyAmount = 0n;
      if (anonymousNoDev || agentWalletDeploy) {
        devBuyAmount = userInitialBuyWei > 0n ? 0n : config.deployBondWei;
      }

      const deployReq: DeployRequest = {
        platform: 'web',
        sourceId: `web-${crypto.randomUUID()}`,
        authorId: userId,
        name,
        symbol,
        walletAddress: resolved.walletAddress,
        chain: deployChain,
      };

      let { isDuplicate, hash: deployDedupHash } = await checkAndRecordDeploy(deployReq);
      if (isDuplicate) {
        const prior = await listDeploymentCatalogByDeployer(userId, 50, 0);
        const nameKey = name.toLowerCase();
        const symKey = symbol.replace(/^\$/, '').toUpperCase();
        const launchedOnChain = prior.some(
          (row) =>
            row.tokenName.trim().toLowerCase() === nameKey &&
            row.tokenSymbol.replace(/^\$/, '').toUpperCase() === symKey,
        );
        if (!launchedOnChain) {
          await releaseDeployAttempt(hashDeployRequest(deployReq));
          const retry = await checkAndRecordDeploy(deployReq);
          isDuplicate = retry.isDuplicate;
          deployDedupHash = retry.hash;
        }
      }
      if (isDuplicate) {
        res.status(409).json({
          error:
            'This name and ticker were already launched successfully for your account. Pick a different name or ticker.',
        });
        return;
      }

      try {
      /** Match fee recipient identity for self-fee deploys so “deployed by” = the account used (Privy / X / GitHub / …). */
      const deployerLabel = anonymousNoDev
        ? 'Web (No Dev · anonymous)'
        : agentWalletDeploy
          ? requesterXUsername && isAgentXChannel(agentChannel)
            ? `@${requesterXUsername}`
            : requesterXUsername
              ? `@${requesterXUsername} · Bankr`
              : agentProviderForLabel
                ? `Web (agent wallet · ${agentProviderForLabel}${agentAuthKind === 'x_confirm' ? ' · X' : ' · captcha'})`
                : `Web (agent wallet${agentAuthKind === 'x_confirm' ? ' · X' : ' · agent-captcha'})`
          : isSelfFeeKind(fee) && !rateLimitForcedBurn && !rateLimitForcedPlatformFee
            ? resolved.feeRecipientLabel.slice(0, 256)
            : initiatorAttribution === 'signed-in user'
              ? 'Web (signed in)'
              : initiatorAttribution.slice(0, 256);

      const feeToSelfEffective =
        (isSelfFeeKind(fee) && !rateLimitForcedBurn && !rateLimitForcedPlatformFee) ||
        (agentWalletDeploy &&
          config.webOnlyMode &&
          !rateLimitForcedBurn &&
          !rateLimitForcedPlatformFee);

      const feeRecipientLabelForCatalog = rateLimitForcedPlatformFee
        ? RATE_LIMIT_FORCED_PLATFORM_FEE_LABEL
        : rateLimitForcedBurn
        ? RATE_LIMIT_FORCED_DEAD_FEE_LABEL
        : agentWalletDeploy
          ? `Agent${agentProviderForLabel ? ` · ${agentProviderForLabel}` : ''} · ${resolved.walletAddress.slice(0, 6)}…${resolved.walletAddress.slice(-4)}`
          : resolved.feeRecipientLabel;

      const catalogFeeRecipientAddress =
        rateLimitForcedPlatformFee && config.platformFeeRecipient
          ? config.platformFeeRecipient
          : resolved.walletAddress;

      let result: Awaited<ReturnType<LiquidDeployer['deployToken']>>;

      if (useWalletDeploy && walletPhase === 'complete') {
        const txHash = typeof body.transactionHash === 'string' ? body.transactionHash.trim() : '';
        if (!/^0x[a-fA-F0-9]{64}$/i.test(txHash)) {
          res.status(400).json({ error: 'Valid transactionHash required for wallet deploy complete.' });
          return;
        }
        if (!body.deploymentConfig || typeof body.deploymentConfig !== 'object') {
          res.status(400).json({ error: 'deploymentConfig from prepare is required.' });
          return;
        }

        const existingByTx = await getDeploymentByTransactionHash(txHash);
        if (existingByTx) {
          if (existingByTx.deployerId !== userId) {
            res.status(403).json({ error: 'This transaction is already registered to another account.' });
            return;
          }
          if (
            existingByTx.tokenName !== name ||
            existingByTx.tokenSymbol.toLowerCase() !== symbol.toLowerCase()
          ) {
            res.status(409).json({
              error:
                'This transaction is already registered for a different token name or ticker.',
            });
            return;
          }
          result = walletCompleteResultFromCatalogRow(existingByTx, deployChain);
        } else if (launchMode === 'simple') {
          const v3Serialized = body.deploymentConfig as unknown as import('../lib/v3DeploymentConfigJson.js').SerializedV3DeploymentConfig;
          const v3cfg = deserializeV3DeploymentConfig(v3Serialized);
          if (v3cfg.tokenConfig.name !== name || v3cfg.tokenConfig.symbol !== symbol) {
            res.status(400).json({ error: 'Deployment config does not match token name or symbol.' });
            return;
          }
          if (
            getAddress(v3DeploymentConfigRewardRecipient(v3cfg)) !==
            getAddress(catalogFeeRecipientAddress)
          ) {
            res.status(400).json({ error: 'Deployment config fee wallet mismatch.' });
            return;
          }

          const onchain = await completeWebWalletDeployV3(agentPaymentPublicClient, {
            transactionHash: txHash,
            expectedTokenAdmin: resolved.walletAddress,
            expectedSigner: walletDeploySigner ?? resolved.walletAddress,
            deploymentConfig: v3Serialized,
            expectedMsgValueWei: userInitialBuyWei,
            expectedCreatorRewardRecipient: catalogFeeRecipientAddress,
          });

          const catalogImage = v3cfg.tokenConfig.image || undefined;
          await recordDeploymentCatalog({
            platform: 'web',
            deployerId: userId,
            deployerLabel,
            feeRecipientAddress: catalogFeeRecipientAddress,
            feeRecipientLabel: feeRecipientLabelForCatalog,
            tokenName: name,
            tokenSymbol: symbol,
            tokenAddress: onchain.tokenAddress,
            poolId: onchain.poolId,
            transactionHash: onchain.transactionHash,
            blockNumber: onchain.blockNumber,
            feeToSelf: feeToSelfEffective,
            privyUserId: usePrivySelfFee ? userId : undefined,
            clientKind: webClientKind,
            tokenImageUrl: catalogImage,
            tokenWebsiteUrl: websiteUrl,
            tokenXUrl: xUrl,
            tokenDescription: userDescription || undefined,
            ...(launchTweetUrl ? { sourceUrl: launchTweetUrl } : {}),
            chain: deployChain,
            factoryAddress: config.hoodmarketsV3.factory,
          });

          result = {
            tokenAddress: onchain.tokenAddress,
            poolId: onchain.poolId,
            transactionHash: onchain.transactionHash,
            blockNumber: onchain.blockNumber,
            timestamp: Date.now(),
            chain: deployChain,
            ...(catalogImage ? { imageUrl: catalogImage } : {}),
          };
        } else {
        const cfg = deserializeDeploymentConfig(body.deploymentConfig as SerializedDeploymentConfig);
        if (cfg.tokenConfig.name !== name || cfg.tokenConfig.symbol !== symbol) {
          res.status(400).json({ error: 'Deployment config does not match token name or symbol.' });
          return;
        }
        if (getAddress(cfg.tokenConfig.tokenAdmin) !== getAddress(resolved.walletAddress)) {
          res.status(400).json({ error: 'Deployment config fee wallet mismatch.' });
          return;
        }
        if (deploymentConfigMsgValueWei(cfg) !== userInitialBuyWei) {
          res.status(400).json({ error: 'Deployment config initial buy mismatch.' });
          return;
        }

        const tx = await agentPaymentPublicClient.getTransaction({
          hash: txHash as `0x${string}`,
        });
        assertWalletDeploySenderMatches(tx?.from, walletDeploySigner ?? resolved.walletAddress);

        const onchain = await completeWebWalletDeploy(agentPaymentPublicClient, {
          transactionHash: txHash,
          expectedTokenAdmin: resolved.walletAddress,
          deploymentConfig: body.deploymentConfig,
        });

        const catalogImage = cfg.tokenConfig.image || undefined;
        await recordDeploymentCatalog({
          platform: 'web',
          deployerId: userId,
          deployerLabel,
          feeRecipientAddress: catalogFeeRecipientAddress,
          feeRecipientLabel: feeRecipientLabelForCatalog,
          tokenName: name,
          tokenSymbol: symbol,
          tokenAddress: onchain.tokenAddress,
          poolId: onchain.poolId,
          transactionHash: onchain.transactionHash,
          blockNumber: onchain.blockNumber,
          feeToSelf: feeToSelfEffective,
          privyUserId: usePrivySelfFee ? userId : undefined,
          clientKind: webClientKind,
          tokenImageUrl: catalogImage,
          tokenWebsiteUrl: websiteUrl,
          tokenXUrl: xUrl,
          tokenDescription: userDescription || undefined,
          ...(launchTweetUrl ? { sourceUrl: launchTweetUrl } : {}),
          chain: deployChain,
          factoryAddress: config.liquid.factory,
        });

        result = {
          tokenAddress: onchain.tokenAddress,
          poolId: onchain.poolId,
          transactionHash: onchain.transactionHash,
          blockNumber: onchain.blockNumber,
          timestamp: Date.now(),
          chain: deployChain,
          ...(catalogImage ? { imageUrl: catalogImage } : {}),
        };
        }
      } else {
        result = await deployer.deployToken({
        name,
        symbol,
        walletAddress: resolved.walletAddress,
        devBuyAmount,
        hookType: 'static',
        description: fullDescription,
        imageUrl,
        websiteUrl,
        xUrl,
        username: 'web',
        platform: 'web',
        deployerId: userId,
        deployerLabel,
        feeRecipientLabel: feeRecipientLabelForCatalog,
        feeToSelf: feeToSelfEffective,
        launchMode,
        ...(rateLimitForcedPlatformFee ? { feesToPlatformOnly: true } : {}),
        ...(usePrivySelfFee && !anonymousNoDev && !agentWalletDeploy ? { privyUserId: userId } : {}),
        clientKind: webClientKind,
        ...(agentWalletDeploy && agentMetadataJson ? { agentMetadataJson } : {}),
        tokenDescription: userDescription || undefined,
        ...(launchTweetUrl ? { sourceUrl: launchTweetUrl } : {}),
        chain: deployChain,
      });
      }

      const links = deployer.generateTokenLinks(result.tokenAddress, result.chain);

      logger.info('Web deploy success', {
        token: result.tokenAddress,
        chain: result.chain,
        userId,
        anonymousNoDev,
        feeWallet: resolved.walletAddress,
        initiatorAttribution,
        ...(agentMetadataJson ? { agentMetadata: agentMetadataJson } : {}),
      });

      const metaForDiscord = parseAgentMetadataJson(agentMetadataJson);
      void notifyDiscordWebLaunch({
        name,
        symbol,
        tokenAddress: result.tokenAddress,
        poolId: result.poolId,
        transactionHash: result.transactionHash,
        feeWallet: resolved.walletAddress,
        initiatorAttribution,
        feeRecipientLabel: feeRecipientLabelForCatalog,
        links,
        platformField: agentWalletDeploy ? '**Web** (agent wallet · captcha)' : undefined,
        agentMetadataFields: metaForDiscord,
      });

      const metaResponse = parseAgentMetadataJson(agentMetadataJson);

      // Prior launches for this fee wallet (split like Telegram / Discord pre-deploy hints).
      let recipientPriorRollingHours = 0;
      let recipientSelfFeePriorTokens: { tokenName: string; tokenSymbol: string; tokenAddress: string }[] =
        [];
      let recipientThirdPartyPriorTokens: { tokenName: string; tokenSymbol: string; tokenAddress: string }[] =
        [];
      if (feeTarget === 'other') {
        const newAddr = result.tokenAddress.toLowerCase();
        const skipNew = <T extends { tokenAddress: string }>(rows: T[]) =>
          rows.filter((t) => t.tokenAddress.toLowerCase() !== newAddr).slice(0, 5);

        recipientSelfFeePriorTokens = skipNew(
          await listSelfFeeTokensForFeeRecipient(resolved.walletAddress, 8),
        );
        const h = deployRateLimitRollingHours();
        recipientPriorRollingHours = h;
        if (h > 0) {
          recipientThirdPartyPriorTokens = skipNew(
            await listThirdPartyFeeTokensForFeeRecipientRollingHours(resolved.walletAddress, h, 8),
          );
        }
      }

      const hasRecipientPrior =
        recipientSelfFeePriorTokens.length > 0 || recipientThirdPartyPriorTokens.length > 0;

      res.json({
        ok: true,
        chain: result.chain,
        tokenAddress: result.tokenAddress,
        poolId: result.poolId,
        transactionHash: result.transactionHash,
        feeWallet: resolved.walletAddress,
        feeSummary: resolved.feeSummaryLine,
        links,
        clientKind: webClientKind,
        ...(result.imageUrl ? { imageUrl: result.imageUrl } : {}),
        ...(agentWalletDeploy
          ? {
              deployReplyHint: agentDeploySuccessReplyHint({
                name,
                symbol,
                tokenAddress: result.tokenAddress,
                transactionHash: result.transactionHash,
                feeRecipient: resolved.walletAddress,
                dexscreenerUrl: links.dexscreener,
                uniswapSwapUrl: links.uniswapSwap,
              }),
            }
          : {}),
        ...(hasRecipientPrior
          ? {
              recipientPriorRollingHours,
              recipientSelfFeePriorTokens,
              recipientThirdPartyPriorTokens,
            }
          : {}),
        ...(agentWalletDeploy && metaResponse ? { agentMetadata: metaResponse } : {}),
      });
      } catch (deployErr) {
        await releaseDeployAttempt(deployDedupHash);
        throw deployErr;
      }
      };

      if (runSelfFeeQueued) {
        await runAfterPriorWebSelfFeeWork(userId, executeDeploy);
      } else if (runThirdPartyQueued) {
        await runAfterPriorWebThirdPartyFeeWork(thirdPartyQueueKey(), executeDeploy);
      } else {
        await executeDeploy();
      }
    } catch (e: any) {
      const msg = formatDeployError(e);
      logger.warn('Web deploy failed', { error: msg });
      let status = 500;
      if (
        /authorization|bearer|access token|privy is not configured/i.test(msg)
      ) {
        status = 401;
      } else if (
        msg.includes('not found') ||
        msg.includes('Invalid') ||
        msg.includes('must be') ||
        msg.includes('Choose a fee') ||
        msg.includes('No embedded Ethereum') ||
        msg.includes('reserved') ||
        msg.includes('Ethereum deployments are disabled')
      ) {
        status = 400;
      }
      res.status(status).json({ error: msg });
    }
  });
}
