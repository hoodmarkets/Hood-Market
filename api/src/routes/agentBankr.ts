import type { Express, Request, Response } from 'express';
import { getAddress, isAddress } from 'viem';
import { config } from '../config.js';
import {
  getDeploymentByTokenAddress,
  getNewestDeploymentByTickerSymbol,
  listDeploymentCatalogByFeeRecipient,
} from '../lib/deploymentCatalog.js';
import { prepareAgentBuy, prepareAgentSell } from '../lib/agentSwapPrepare.js';
import {
  prepareAgentCancelBuyerRewards,
  prepareAgentFundBuyerRewards,
} from '../lib/agentBuyerRewardPrepare.js';
import { importDexBrandingForToken } from '../lib/importDexBranding.js';
import {
  listAgentTokenSpacePosts,
  postAgentTokenSpaceComment,
} from '../lib/tokenSpaceAgent.js';
import {
  loadTokenPageProfileView,
  updateTokenPageProfileForWallet,
  verifyTokenPageForWallet,
} from '../lib/tokenPageProfile.js';
import {
  resolveAgentTokenLookup,
  runAgentDeployPreflight,
} from '../lib/agentDeployPreflight.js';
import { agentDeploySkipCaptchaForRequest, normalizeAgentChannel } from '../lib/agentWalletDeployAuth.js';
import {
  agentDeployConfirmReplyHint,
  buildAgentDeployConfirmSummary,
  normalizeTweetStatusUrl,
  resolveLaunchTweetUrl,
  resolveAgentDeployImageUrlAsync,
} from '../lib/agentDeployImage.js';
import { resolveRequesterXUsernameFromDeployInput } from '../lib/requesterXUsername.js';
import { ROBINHOOD_CHAIN_ID } from '../lib/robinhoodChain.js';
import { webDeployCorsHeaders } from '../lib/webDeployCors.js';

const API_BASE = (process.env.LAUNCHER_API_URL || 'https://api.hood.markets').replace(/\/$/, '');
const WEB_BASE = (process.env.LAUNCHER_WEB_URL || 'https://hood.markets').replace(/\/$/, '');

function cors(req: Request, res: Response): void {
  const h = webDeployCorsHeaders(req.headers.origin);
  for (const [k, v] of Object.entries(h)) res.setHeader(k, v);
}

function walletFromReq(req: Request): `0x${string}` | null {
  const header = req.headers['x-wallet-address'];
  if (typeof header === 'string' && isAddress(header.trim())) {
    try {
      return getAddress(header.trim());
    } catch {
      return null;
    }
  }
  const q = req.query.wallet;
  if (typeof q === 'string' && isAddress(q.trim())) {
    try {
      return getAddress(q.trim());
    } catch {
      return null;
    }
  }
  return null;
}

function walletFromBody(body: unknown): `0x${string}` | null {
  if (!body || typeof body !== 'object') return null;
  const w = (body as { wallet?: string }).wallet;
  if (typeof w === 'string' && isAddress(w.trim())) {
    try {
      return getAddress(w.trim());
    } catch {
      return null;
    }
  }
  return null;
}

function agentImageInputFromBody(body: Record<string, unknown>) {
  return {
    imageUrl: body.imageUrl,
    tweetImageUrl: body.tweetImageUrl ?? body.media_url_https,
    mediaUrl: body.mediaUrl,
    tweetMedia: body.tweetMedia,
    tweetText: body.tweetText,
    tweet: body.tweet,
    tweetId: body.tweetId ?? body.tweet_id ?? body.statusId ?? body.status_id,
    tweetUrl: body.tweetUrl ?? body.tweet_url,
  };
}

function agentChannelFromRequest(req: Request, body?: Record<string, unknown>): string | null {
  return normalizeAgentChannel(
    req.headers as { [k: string]: string | string[] | undefined },
    body ?? (req.body && typeof req.body === 'object' ? (req.body as Record<string, unknown>) : {}),
  );
}

function launchTypeFromPoolId(poolId: string | undefined): 'simple' | 'pro' | 'unknown' {
  if (!poolId) return 'unknown';
  return poolId.toLowerCase().startsWith('v3:') ? 'simple' : 'pro';
}

function deploymentToAgentTokenInfo(
  deployment: NonNullable<Awaited<ReturnType<typeof getDeploymentByTokenAddress>>>,
) {
  const launchType = launchTypeFromPoolId(deployment.poolId);
  return {
    tokenName: deployment.tokenName,
    tokenSymbol: deployment.tokenSymbol,
    tokenAddress: deployment.tokenAddress,
    poolId: deployment.poolId,
    launchType,
    swapMode: launchType === 'simple' ? 'uniswap' : 'hoodmarkets-helper',
    oneClickSwapOnHoodmarkets: launchType === 'pro',
    tokenPageUrl: `${WEB_BASE}/?token=${deployment.tokenAddress}`,
    dexscreenerUrl: `https://dexscreener.com/robinhood/${deployment.tokenAddress}`,
    uniswapSwapUrl: `https://app.uniswap.org/swap?chain=robinhood&outputCurrency=${deployment.tokenAddress}`,
    feeRecipientAddress: deployment.feeRecipientAddress,
  };
}

/**
 * Bankr / agent skill endpoints — structured JSON for @bankrbot and other agents.
 * Wallet: `x-wallet-address` header or `?wallet=` / body `wallet`.
 */
export function registerAgentBankrRoutes(app: Express): void {
  app.get('/health', (req, res) => {
    cors(req, res);
    res.json({
      ok: true,
      service: 'hoodmarkets',
      chainId: ROBINHOOD_CHAIN_ID,
      web: WEB_BASE,
      api: API_BASE,
    });
  });

  app.options('/api/agent/briefing', (req, res) => {
    cors(req, res);
    res.status(204).end();
  });

  app.get('/api/agent/briefing', async (req: Request, res: Response) => {
    cors(req, res);
    const wallet = walletFromReq(req);
    if (!wallet) {
      res.status(400).json({ ok: false, error: 'Pass wallet=0x… or x-wallet-address header.' });
      return;
    }

    const rows = await listDeploymentCatalogByFeeRecipient(wallet, 50, 0);
    const deployments = rows.map((r) => ({
      tokenName: r.tokenName,
      tokenSymbol: r.tokenSymbol,
      tokenAddress: r.tokenAddress,
      poolId: r.poolId,
      launchType: r.poolId?.toLowerCase().startsWith('v3:') ? 'simple' : 'pro',
      transactionHash: r.transactionHash,
      tokenPageUrl: `${WEB_BASE}/?token=${r.tokenAddress}`,
      dexscreenerUrl: `https://dexscreener.com/robinhood/${r.tokenAddress}`,
      uniswapUrl: `https://app.uniswap.org/explore/tokens/robinhood/${r.tokenAddress}`,
    }));

    res.json({
      ok: true,
      wallet,
      chainId: ROBINHOOD_CHAIN_ID,
      deploymentCount: deployments.length,
      deployments,
      links: {
        launch: `${WEB_BASE}/`,
        docs: `${WEB_BASE}/agent-api`,
        captchaChallenge: `${API_BASE}/api/agent-captcha/challenge`,
      },
      feeSplitSimple: {
        platformPercent: 5,
        creatorPercent: 95,
        note: 'Simple (V3) launches embed 5% hood.markets platform fee in the LP locker contract.',
      },
    });
  });

  app.options('/api/agent/preflight-deploy', (req, res) => {
    cors(req, res);
    res.status(204).end();
  });

  app.get('/api/agent/preflight-deploy', async (req: Request, res: Response) => {
    cors(req, res);
    const wallet = walletFromReq(req);
    if (!wallet) {
      res.status(400).json({ ok: false, error: 'Pass wallet=0x… or x-wallet-address header.' });
      return;
    }

    const name = typeof req.query.name === 'string' ? req.query.name.trim() : '';
    const symbolRaw = typeof req.query.symbol === 'string' ? req.query.symbol.trim() : '';
    const launchModeRaw =
      typeof req.query.launchMode === 'string' ? req.query.launchMode.trim().toLowerCase() : '';
    const launchMode =
      launchModeRaw === 'pro' ? 'pro' : launchModeRaw === 'simple' ? 'simple' : config.defaultLaunchMode;

    if (!name || !symbolRaw) {
      res.status(400).json({
        ok: false,
        error: 'Query params name and symbol are required.',
      });
      return;
    }

    const preflight = await runAgentDeployPreflight({
      wallet,
      name,
      symbol: symbolRaw,
      launchMode,
      agentChannel: agentChannelFromRequest(req),
    });

    res.status(preflight.canDeploy ? 200 : 409).json({
      ...preflight,
      chainId: ROBINHOOD_CHAIN_ID,
      cooldownCheckUrl: `${API_BASE}/api/deploy-cooldown-check?symbol=${encodeURIComponent(symbolRaw)}&name=${encodeURIComponent(name)}`,
    });
  });

  app.post('/api/agent/preflight-deploy', async (req: Request, res: Response) => {
    cors(req, res);
    const wallet = walletFromBody(req.body) ?? walletFromReq(req);
    if (!wallet) {
      res.status(400).json({ ok: false, error: 'wallet required.' });
      return;
    }

    const body = (req.body && typeof req.body === 'object' ? req.body : {}) as Record<string, unknown>;
    const name = typeof body.name === 'string' ? body.name.trim() : '';
    const symbol = typeof body.symbol === 'string' ? body.symbol.trim() : '';
    const launchModeRaw =
      typeof body.launchMode === 'string' ? body.launchMode.trim().toLowerCase() : '';
    const launchMode =
      launchModeRaw === 'pro' ? 'pro' : launchModeRaw === 'simple' ? 'simple' : config.defaultLaunchMode;

    if (!name || !symbol) {
      res.status(400).json({ ok: false, error: 'name and symbol are required.' });
      return;
    }

    const preflight = await runAgentDeployPreflight({
      wallet,
      name,
      symbol,
      launchMode,
      agentChannel: agentChannelFromRequest(req, body),
    });

    const resolvedImage = await resolveAgentDeployImageUrlAsync(agentImageInputFromBody(body));

    res.status(preflight.canDeploy ? 200 : 409).json({
      ...preflight,
      chainId: ROBINHOOD_CHAIN_ID,
      ...(resolvedImage.imageUrl
        ? { imageUrl: resolvedImage.imageUrl, imageSource: resolvedImage.imageSource }
        : { imageRequired: true }),
    });
  });

  app.options('/api/agent/resolve-deploy-image', (req, res) => {
    cors(req, res);
    res.status(204).end();
  });

  app.post('/api/agent/resolve-deploy-image', async (req: Request, res: Response) => {
    cors(req, res);
    const body = (req.body && typeof req.body === 'object' ? req.body : {}) as Record<string, unknown>;
    const resolvedImage = await resolveAgentDeployImageUrlAsync(agentImageInputFromBody(body));

    if (!resolvedImage.imageUrl || !resolvedImage.imageSource) {
      const tweetUrl = normalizeTweetStatusUrl(body.tweetUrl ?? body.tweet_url);
      const tweetId = body.tweetId ?? body.tweet_id;
      res.status(400).json({
        ok: false,
        error: 'Could not resolve a token logo from the request.',
        imageRequired: true,
        replyHint: tweetUrl || tweetId
          ? 'No photo found on that tweet — reply with a photo attached or paste an image URL.'
          : 'Pass tweetId, tweetUrl, tweetImageUrl (media_url_https), or the full tweet object.',
      });
      return;
    }

    res.json({
      ok: true,
      imageUrl: resolvedImage.imageUrl,
      imageSource: resolvedImage.imageSource,
    });
  });

  app.options('/api/agent/token-info', (req, res) => {
    cors(req, res);
    res.status(204).end();
  });

  app.get('/api/agent/token-info', async (req: Request, res: Response) => {
    cors(req, res);
    const rawToken = typeof req.query.token === 'string' ? req.query.token.trim() : '';
    const rawSymbol = typeof req.query.symbol === 'string' ? req.query.symbol.trim() : '';
    const lookupRaw = rawToken || rawSymbol;
    if (!lookupRaw) {
      res.status(400).json({
        ok: false,
        error: 'Pass token=0x… or symbol=TICKER.',
      });
      return;
    }

    const lookup = await resolveAgentTokenLookup(lookupRaw);
    if (!lookup) {
      res.status(400).json({ ok: false, error: 'Invalid token address or symbol.' });
      return;
    }

    const deployment =
      lookup.kind === 'address'
        ? await getDeploymentByTokenAddress(lookup.address)
        : await getNewestDeploymentByTickerSymbol(lookup.symbol);

    if (!deployment) {
      res.status(404).json({
        ok: false,
        error: 'Token not found in hood.markets catalog.',
        hint: 'Only tokens launched on hood.markets appear in the catalog.',
      });
      return;
    }

    res.json({
      ok: true,
      ...deploymentToAgentTokenInfo(deployment),
    });
  });

  app.options('/api/agent/prepare-deploy', (req, res) => {
    cors(req, res);
    res.status(204).end();
  });

  app.post('/api/agent/prepare-deploy', async (req: Request, res: Response) => {
    cors(req, res);
    const wallet = walletFromBody(req.body) ?? walletFromReq(req);
    if (!wallet) {
      res.status(400).json({ ok: false, error: 'wallet (0x…) required in body or x-wallet-address.' });
      return;
    }

    const body = (req.body && typeof req.body === 'object' ? req.body : {}) as Record<string, unknown>;
    const name = typeof body.name === 'string' ? body.name.trim() : '';
    const symbol = typeof body.symbol === 'string' ? body.symbol.trim().toUpperCase() : '';
    const launchModeRaw =
      typeof body.launchMode === 'string' ? body.launchMode.trim().toLowerCase() : '';
    const launchMode =
      launchModeRaw === 'pro' ? 'pro' : launchModeRaw === 'simple' ? 'simple' : config.defaultLaunchMode;

    if (!name || name.length < 2) {
      res.status(400).json({ ok: false, error: 'name is required (min 2 chars).' });
      return;
    }
    if (!symbol || symbol.length < 1) {
      res.status(400).json({ ok: false, error: 'symbol is required.' });
      return;
    }

    const description = typeof body.description === 'string' ? body.description.trim() : '';
    const websiteUrl = typeof body.websiteUrl === 'string' ? body.websiteUrl.trim() : '';
    const xUrl = typeof body.xUrl === 'string' ? body.xUrl.trim() : '';
    const resolvedImage = await resolveAgentDeployImageUrlAsync(agentImageInputFromBody(body));

    const agentChannel =
      typeof body.agentChannel === 'string' ? body.agentChannel.trim().toLowerCase() : '';
    const { skip: skipCaptcha, channel: resolvedChannel } = agentDeploySkipCaptchaForRequest(
      req.headers as { [k: string]: string | string[] | undefined },
      { agentChannel: agentChannel || undefined, agentRuntime: body.agentRuntime },
    );

    if (!resolvedImage.imageUrl || !resolvedImage.imageSource) {
      res.status(400).json({
        ok: false,
        error: 'Token logo is required before deploy.',
        imageRequired: true,
        replyHint:
          resolvedChannel === 'x'
            ? 'Pass tweetId or tweetUrl — API resolves photos via X syndication. Or pass tweetImageUrl / extended_entities.media from your X API payload.'
            : 'Pass imageUrl (HTTPS), tweetId, tweetUrl, or tweet media fields on prepare-deploy.',
      });
      return;
    }

    const preflight = await runAgentDeployPreflight({
      wallet,
      name,
      symbol,
      launchMode,
      agentChannel: resolvedChannel,
    });

    if (!preflight.canDeploy) {
      res.status(409).json({
        ok: false,
        error: preflight.blockMessage,
        preflight,
        replyHint: preflight.blocks[0]?.replyHint ?? preflight.blockMessage,
        ...(preflight.xDailyLimit ? { xDailyLimit: preflight.xDailyLimit } : {}),
      });
      return;
    }

    const launchTweetUrl = resolveLaunchTweetUrl(body);
    const requesterXUsername = resolveRequesterXUsernameFromDeployInput({
      xUsername: body.xUsername,
      tweetUrl: launchTweetUrl ?? body.tweetUrl ?? body.tweet_url,
      sourceUrl: body.sourceUrl,
      launchTweetUrl,
    });

    const deployBody = {
      name,
      symbol,
      feeTarget: 'agent_wallet',
      clientKind: 'agent',
      agentProvider: 'bankr',
      launchMode,
      imageUrl: resolvedImage.imageUrl,
      description,
      websiteUrl,
      xUrl,
      wallet,
      agentFeeRecipient: wallet,
      ...(resolvedChannel ? { agentChannel: resolvedChannel } : {}),
      ...(requesterXUsername ? { xUsername: requesterXUsername } : {}),
      ...(launchTweetUrl ? { tweetUrl: launchTweetUrl, sourceUrl: launchTweetUrl } : {}),
    };

    const confirmSummary = buildAgentDeployConfirmSummary({
      name,
      symbol,
      launchMode,
      feeRecipient: wallet,
      imageUrl: resolvedImage.imageUrl,
      imageSource: resolvedImage.imageSource,
      ...(description ? { description } : {}),
      ...(websiteUrl ? { websiteUrl } : {}),
      ...(xUrl ? { xUrl } : {}),
    });
    const confirmReplyHint = agentDeployConfirmReplyHint(confirmSummary);

    const deployHeaders: Record<string, string> = { 'x-wallet-address': wallet };
    if (resolvedChannel) deployHeaders['x-agent-channel'] = resolvedChannel;

    const deployStep = {
      step: 'deploy',
      method: 'POST' as const,
      url: `${API_BASE}/api/deploy`,
      headers: deployHeaders,
      body: deployBody,
      note:
        resolvedChannel === 'x'
          ? 'X channel — no haiku. User confirmed in-thread; pass linked wallet via x-wallet-address and agentChannel: x.'
          : 'Captcha skipped for this agent channel. Pass linked wallet via x-wallet-address.',
    };

    const steps = skipCaptcha
      ? [
          ...(resolvedChannel === 'x'
            ? [
                {
                  step: 'user_confirm',
                  note:
                    'Show the launch preview below, including the token logo from the original tweet. Ask the user to reply yes/confirm before deploy. Do not call deploy until they confirm.',
                  summary: confirmSummary,
                  replyHint: confirmReplyHint,
                  requiredFields: ['imageUrl', 'name', 'symbol', ...(resolvedChannel === 'x' ? ['xUsername', 'tweetUrl'] : [])],
                },
              ]
            : []),
          deployStep,
        ]
      : [
          {
            step: 'captcha_challenge',
            method: 'GET',
            url: `${API_BASE}/api/agent-captcha/challenge`,
          },
          {
            step: 'captcha_verify',
            method: 'POST',
            url: `${API_BASE}/api/agent-captcha/verify`,
            body: {
              sessionId: '<from challenge>',
              response: '<haiku 3 lines mentioning topic word>',
              agentFeeRecipient: wallet,
            },
          },
          deployStep,
        ];

    res.json({
      ok: true,
      wallet,
      chainId: ROBINHOOD_CHAIN_ID,
      launchMode,
      preflight: {
        warnings: preflight.warnings,
        proceedNotice: preflight.proceedNotice,
      },
      deployMode: 'server',
      captchaRequired: !skipCaptcha,
      agentChannel: resolvedChannel,
      confirmSummary,
      confirmReplyHint,
      imageUrl: resolvedImage.imageUrl,
      imageSource: resolvedImage.imageSource,
      steps,
      ...(skipCaptcha
        ? {}
        : {
            haikuRules:
              'Exactly 3 lines separated by \\n; must mention the challenge topic word. JWT valid 8 hours.',
          }),
      feeRecipient: wallet,
      tokenPageUrlTemplate: `${WEB_BASE}/?token={tokenAddress}`,
    });
  });

  app.options('/api/agent/prepare-buy', (req, res) => {
    cors(req, res);
    res.status(204).end();
  });

  app.post('/api/agent/prepare-buy', async (req: Request, res: Response) => {
    cors(req, res);
    const wallet = walletFromBody(req.body) ?? walletFromReq(req);
    if (!wallet) {
      res.status(400).json({ ok: false, error: 'wallet required.' });
      return;
    }
    const body = (req.body && typeof req.body === 'object' ? req.body : {}) as Record<string, unknown>;
    const tokenAddress = typeof body.tokenAddress === 'string' ? body.tokenAddress.trim() : '';
    const amountEth =
      typeof body.amountEth === 'string'
        ? body.amountEth
        : typeof body.amount === 'string'
          ? body.amount
          : '';

    if (!tokenAddress) {
      res.status(400).json({ ok: false, error: 'tokenAddress is required.' });
      return;
    }
    if (!amountEth) {
      res.status(400).json({ ok: false, error: 'amountEth is required (e.g. 0.01).' });
      return;
    }

    const result = await prepareAgentBuy({ tokenAddress, amountEth, taker: wallet });
    if (!result.ok) {
      res.status(400).json(result);
      return;
    }
    res.json({
      ...result,
      wallet,
      bankrSubmitUrl: 'https://api.bankr.bot/wallet/submit',
      confirmHint: 'Submit each transaction via Bankr /wallet/submit with waitForConfirmation: true.',
    });
  });

  app.options('/api/agent/prepare-sell', (req, res) => {
    cors(req, res);
    res.status(204).end();
  });

  app.post('/api/agent/prepare-sell', async (req: Request, res: Response) => {
    cors(req, res);
    const wallet = walletFromBody(req.body) ?? walletFromReq(req);
    if (!wallet) {
      res.status(400).json({ ok: false, error: 'wallet required.' });
      return;
    }
    const body = (req.body && typeof req.body === 'object' ? req.body : {}) as Record<string, unknown>;
    const tokenAddress = typeof body.tokenAddress === 'string' ? body.tokenAddress.trim() : '';
    const amount = typeof body.amount === 'string' ? body.amount : '';

    if (!tokenAddress) {
      res.status(400).json({ ok: false, error: 'tokenAddress is required.' });
      return;
    }
    if (!amount) {
      res.status(400).json({ ok: false, error: 'amount is required (token units, e.g. 1000000 or 1M).' });
      return;
    }

    const result = await prepareAgentSell({ tokenAddress, amount, taker: wallet });
    if (!result.ok) {
      res.status(400).json(result);
      return;
    }
    res.json({
      ...result,
      wallet,
      bankrSubmitUrl: 'https://api.bankr.bot/wallet/submit',
      confirmHint: 'Submit approve (if present) then sell via Bankr /wallet/submit.',
    });
  });

  app.options('/api/agent/prepare-fund-buyer-rewards', (req, res) => {
    cors(req, res);
    res.status(204).end();
  });

  app.post('/api/agent/prepare-fund-buyer-rewards', async (req: Request, res: Response) => {
    cors(req, res);
    const wallet = walletFromBody(req.body) ?? walletFromReq(req);
    if (!wallet) {
      res.status(400).json({ ok: false, error: 'wallet required.' });
      return;
    }
    const body = (req.body && typeof req.body === 'object' ? req.body : {}) as Record<string, unknown>;
    const tokenAddress =
      typeof body.tokenAddress === 'string'
        ? body.tokenAddress.trim()
        : typeof body.token === 'string'
          ? body.token.trim()
          : typeof body.symbol === 'string'
            ? body.symbol.trim()
            : '';

    if (!tokenAddress) {
      res.status(400).json({ ok: false, error: 'tokenAddress, token, or symbol is required.' });
      return;
    }

    const shareAmount = body.shareAmount ?? body.shares ?? body.amount;
    const result = await prepareAgentFundBuyerRewards({
      wallet,
      tokenAddress,
      shareAmount,
    });
    if (!result.ok) {
      res.status(400).json(result);
      return;
    }
    res.json({
      ...result,
      wallet,
      bankrSubmitUrl: 'https://api.bankr.bot/wallet/submit',
      bankrWalletSubmitRequired: true,
    });
  });

  app.options('/api/agent/prepare-cancel-buyer-rewards', (req, res) => {
    cors(req, res);
    res.status(204).end();
  });

  app.post('/api/agent/prepare-cancel-buyer-rewards', async (req: Request, res: Response) => {
    cors(req, res);
    const wallet = walletFromBody(req.body) ?? walletFromReq(req);
    if (!wallet) {
      res.status(400).json({ ok: false, error: 'wallet required.' });
      return;
    }
    const body = (req.body && typeof req.body === 'object' ? req.body : {}) as Record<string, unknown>;
    const tokenAddress =
      typeof body.tokenAddress === 'string'
        ? body.tokenAddress.trim()
        : typeof body.token === 'string'
          ? body.token.trim()
          : typeof body.symbol === 'string'
            ? body.symbol.trim()
            : '';

    if (!tokenAddress) {
      res.status(400).json({ ok: false, error: 'tokenAddress, token, or symbol is required.' });
      return;
    }

    const result = await prepareAgentCancelBuyerRewards({ wallet, tokenAddress });
    if (!result.ok) {
      res.status(400).json(result);
      return;
    }
    res.json({
      ...result,
      wallet,
      bankrSubmitUrl: 'https://api.bankr.bot/wallet/submit',
      bankrWalletSubmitRequired: true,
    });
  });

  app.options('/api/agent/import-dex-branding', (req, res) => {
    cors(req, res);
    res.status(204).end();
  });

  app.post('/api/agent/import-dex-branding', async (req: Request, res: Response) => {
    cors(req, res);
    const wallet = walletFromBody(req.body) ?? walletFromReq(req);
    if (!wallet) {
      res.status(400).json({ ok: false, error: 'wallet required.' });
      return;
    }
    const body = (req.body && typeof req.body === 'object' ? req.body : {}) as Record<string, unknown>;
    const tokenAddress =
      typeof body.tokenAddress === 'string'
        ? body.tokenAddress.trim()
        : typeof body.token === 'string'
          ? body.token.trim()
          : typeof body.symbol === 'string'
            ? body.symbol.trim()
            : '';

    if (!tokenAddress) {
      res.status(400).json({ ok: false, error: 'tokenAddress, token, or symbol is required.' });
      return;
    }

    let resolvedToken = tokenAddress;
    if (!/^0x[a-fA-F0-9]{40}$/.test(tokenAddress)) {
      const deployment = await getNewestDeploymentByTickerSymbol(tokenAddress.toUpperCase());
      if (!deployment) {
        res.status(404).json({ ok: false, error: 'Token symbol not found in catalog.' });
        return;
      }
      resolvedToken = deployment.tokenAddress;
    }

    const result = await importDexBrandingForToken({
      tokenAddress: resolvedToken,
      walletAddress: wallet,
    });
    if (!result.ok) {
      res.status(result.status).json({
        ok: false,
        error: result.error,
        ...(result.enhancedInfoStatus !== undefined
          ? { enhancedInfoStatus: result.enhancedInfoStatus }
          : {}),
        ...(result.adminWallet
          ? {
              adminWallet: result.adminWallet,
              adminRole: result.adminRole,
              feeRecipientAddress: result.feeRecipientAddress,
            }
          : {}),
      });
      return;
    }

    res.json({
      ok: true,
      wallet,
      imported: result.imported,
      token: result.token,
      dex: result.dex,
      replyHint: `Imported DexScreener icon and banner for ${result.token?.tokenSymbol ?? 'token'} onto hood.markets.`,
      tokenPageUrl: `${WEB_BASE}/?token=${resolvedToken}`,
    });
  });

  app.options('/api/agent/token-space-posts', (req, res) => {
    cors(req, res);
    res.status(204).end();
  });

  app.get('/api/agent/token-space-posts', async (req: Request, res: Response) => {
    cors(req, res);
    const token =
      typeof req.query.token === 'string'
        ? req.query.token.trim()
        : typeof req.query.tokenAddress === 'string'
          ? req.query.tokenAddress.trim()
          : typeof req.query.symbol === 'string'
            ? req.query.symbol.trim()
            : '';

    if (!token) {
      res.status(400).json({ ok: false, error: 'token, tokenAddress, or symbol query param required.' });
      return;
    }

    const rawLimit = req.query.limit;
    const limit = typeof rawLimit === 'string' ? Number.parseInt(rawLimit, 10) : 50;

    const result = await listAgentTokenSpacePosts(token, limit);
    if (!result.ok) {
      res.status(result.status).json({ ok: false, error: result.error });
      return;
    }

    res.json({
      ok: true,
      tokenAddress: result.deployment.tokenAddress,
      tokenSymbol: result.deployment.tokenSymbol,
      tokenName: result.deployment.tokenName,
      tokenPageUrl: result.tokenPageUrl,
      posts: result.posts,
    });
  });

  app.options('/api/agent/token-space-post', (req, res) => {
    cors(req, res);
    res.status(204).end();
  });

  app.post('/api/agent/token-space-post', async (req: Request, res: Response) => {
    cors(req, res);
    const wallet = walletFromBody(req.body) ?? walletFromReq(req);
    if (!wallet) {
      res.status(400).json({ ok: false, error: 'wallet required (x-wallet-address header or body).' });
      return;
    }

    const body = (req.body && typeof req.body === 'object' ? req.body : {}) as Record<string, unknown>;
    const tokenOrSymbol =
      typeof body.tokenAddress === 'string'
        ? body.tokenAddress.trim()
        : typeof body.token === 'string'
          ? body.token.trim()
          : typeof body.symbol === 'string'
            ? body.symbol.trim()
            : typeof body.tokenSymbol === 'string'
              ? body.tokenSymbol.trim()
              : '';

    const postBody = typeof body.body === 'string' ? body.body : typeof body.message === 'string' ? body.message : '';

    if (!tokenOrSymbol) {
      res.status(400).json({
        ok: false,
        error: 'tokenAddress, token, symbol, or tokenSymbol is required.',
      });
      return;
    }

    const result = await postAgentTokenSpaceComment({
      walletAddress: wallet,
      tokenOrSymbol,
      body: postBody,
    });

    if (!result.ok) {
      res.status(result.status).json({ ok: false, error: result.error });
      return;
    }

    res.json({
      ok: true,
      wallet,
      tokenAddress: result.deployment.tokenAddress,
      tokenSymbol: result.deployment.tokenSymbol,
      tokenName: result.deployment.tokenName,
      tokenPageUrl: result.tokenPageUrl,
      post: result.post,
      replyHint: result.replyHint,
      bankrWalletSubmitRequired: false,
    });
  });

  app.options('/api/agent/token-page-profile', (req, res) => {
    cors(req, res);
    res.status(204).end();
  });

  app.get('/api/agent/token-page-profile', async (req: Request, res: Response) => {
    cors(req, res);
    const wallet = walletFromReq(req);
    const token =
      typeof req.query.token === 'string'
        ? req.query.token.trim()
        : typeof req.query.tokenAddress === 'string'
          ? req.query.tokenAddress.trim()
          : typeof req.query.symbol === 'string'
            ? req.query.symbol.trim()
            : '';

    if (!token) {
      res.status(400).json({ ok: false, error: 'token, tokenAddress, or symbol query param required.' });
      return;
    }

    let row = null;
    if (/^0x[a-fA-F0-9]{40}$/.test(token)) {
      row = await getDeploymentByTokenAddress(token);
    } else {
      row = await getNewestDeploymentByTickerSymbol(token.toUpperCase().replace(/^\$/, ''));
    }
    if (!row) {
      res.status(404).json({ ok: false, error: 'Token not found in hood.markets catalog.' });
      return;
    }

    const profile = await loadTokenPageProfileView(row, wallet ?? undefined);
    res.json({
      ok: true,
      tokenAddress: row.tokenAddress,
      tokenSymbol: row.tokenSymbol,
      tokenPageUrl: `${WEB_BASE}/?token=${row.tokenAddress}`,
      profile,
    });
  });

  app.post('/api/agent/update-token-page-profile', async (req: Request, res: Response) => {
    cors(req, res);
    const wallet = walletFromBody(req.body) ?? walletFromReq(req);
    if (!wallet) {
      res.status(400).json({ ok: false, error: 'wallet required (x-wallet-address header or body).' });
      return;
    }

    const body = (req.body && typeof req.body === 'object' ? req.body : {}) as Record<string, unknown>;
    const tokenOrSymbol =
      typeof body.tokenAddress === 'string'
        ? body.tokenAddress.trim()
        : typeof body.token === 'string'
          ? body.token.trim()
          : typeof body.symbol === 'string'
            ? body.symbol.trim()
            : typeof body.tokenSymbol === 'string'
              ? body.tokenSymbol.trim()
              : '';

    if (!tokenOrSymbol) {
      res.status(400).json({ ok: false, error: 'tokenAddress, token, symbol, or tokenSymbol is required.' });
      return;
    }

    let row = null;
    if (/^0x[a-fA-F0-9]{40}$/.test(tokenOrSymbol)) {
      row = await getDeploymentByTokenAddress(tokenOrSymbol);
    } else {
      row = await getNewestDeploymentByTickerSymbol(tokenOrSymbol.toUpperCase().replace(/^\$/, ''));
    }
    if (!row) {
      res.status(404).json({ ok: false, error: 'Token not found in hood.markets catalog.' });
      return;
    }

    const result = await updateTokenPageProfileForWallet(row, {
      walletAddress: wallet,
      description: typeof body.description === 'string' ? body.description : undefined,
      websiteUrl: typeof body.websiteUrl === 'string' ? body.websiteUrl : undefined,
      xUrl: typeof body.xUrl === 'string' ? body.xUrl : undefined,
      telegramUrl: typeof body.telegramUrl === 'string' ? body.telegramUrl : undefined,
      discordUrl: typeof body.discordUrl === 'string' ? body.discordUrl : undefined,
      githubUrl: typeof body.githubUrl === 'string' ? body.githubUrl : undefined,
      customLinks: Array.isArray(body.customLinks) ? body.customLinks : undefined,
      imageUrl: typeof body.imageUrl === 'string' ? body.imageUrl : undefined,
      bannerUrl: typeof body.bannerUrl === 'string' ? body.bannerUrl : undefined,
      useDexIcon: typeof body.useDexIcon === 'boolean' ? body.useDexIcon : undefined,
      useDexBanner: typeof body.useDexBanner === 'boolean' ? body.useDexBanner : undefined,
      useLaunchImage: typeof body.useLaunchImage === 'boolean' ? body.useLaunchImage : undefined,
      useDexLinks: typeof body.useDexLinks === 'boolean' ? body.useDexLinks : undefined,
      importDexBranding: body.importDexBranding === true,
    });

    if (!result.ok) {
      res.status(result.status).json({ ok: false, error: result.error });
      return;
    }

    const sym = row.tokenSymbol.replace(/^\$/, '');
    res.json({
      ok: true,
      wallet,
      tokenAddress: row.tokenAddress,
      tokenSymbol: row.tokenSymbol,
      tokenPageUrl: `${WEB_BASE}/?token=${row.tokenAddress}`,
      profile: result.profile,
      replyHint: `Updated $${sym} token page on hood.markets.`,
      bankrWalletSubmitRequired: false,
    });
  });

  app.post('/api/agent/verify-token-page', async (req: Request, res: Response) => {
    cors(req, res);
    const wallet = walletFromBody(req.body) ?? walletFromReq(req);
    if (!wallet) {
      res.status(400).json({ ok: false, error: 'wallet required (x-wallet-address header or body).' });
      return;
    }

    const body = (req.body && typeof req.body === 'object' ? req.body : {}) as Record<string, unknown>;
    const tokenOrSymbol =
      typeof body.tokenAddress === 'string'
        ? body.tokenAddress.trim()
        : typeof body.token === 'string'
          ? body.token.trim()
          : typeof body.symbol === 'string'
            ? body.symbol.trim()
            : typeof body.tokenSymbol === 'string'
              ? body.tokenSymbol.trim()
              : '';

    if (!tokenOrSymbol) {
      res.status(400).json({ ok: false, error: 'tokenAddress, token, symbol, or tokenSymbol is required.' });
      return;
    }

    let row = null;
    if (/^0x[a-fA-F0-9]{40}$/.test(tokenOrSymbol)) {
      row = await getDeploymentByTokenAddress(tokenOrSymbol);
    } else {
      row = await getNewestDeploymentByTickerSymbol(tokenOrSymbol.toUpperCase().replace(/^\$/, ''));
    }
    if (!row) {
      res.status(404).json({ ok: false, error: 'Token not found in hood.markets catalog.' });
      return;
    }

    const result = await verifyTokenPageForWallet(row, wallet);
    if (!result.ok) {
      res.status(result.status).json({ ok: false, error: result.error });
      return;
    }

    res.json({
      ok: true,
      wallet,
      tokenAddress: row.tokenAddress,
      tokenSymbol: row.tokenSymbol,
      tokenPageUrl: `${WEB_BASE}/?token=${row.tokenAddress}`,
      profile: result.profile,
      replyHint: result.replyHint,
      bankrWalletSubmitRequired: false,
    });
  });
}
