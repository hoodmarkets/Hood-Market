import crypto from 'crypto';
import { EmbedBuilder } from 'discord.js';
import {
  parseLaunchRequest,
  parseClaimTokenHint,
  extractLaunchUserDescription,
  generateMissingFieldsPrompt,
} from '../parser.js';
import {
  extractImageUrlFromText,
  extractTwitterMediaImageUrl,
  extractXProfileImageUrl,
} from '../lib/imageSources.js';
import { LiquidDeployer } from '../deployer.js';
import { config } from '../config.js';
import { logger } from '../logger.js';
import { feedPost } from '../lib/discordDebug.js';
import {
  checkAndRecordDeploy,
  type DeployRequest,
  saveCursor,
  loadCursor,
} from '../lib/deployDedup.js';
import {
  formatGlobalTickerCooldownMessage,
  isTickerGloballyReserved,
} from '../lib/globalTickerCooldown.js';
import { getOrCreateWalletForUser } from '../lib/recipientResolver.js';
import { runSocialTradingFeesClaim } from '../lib/socialFeeClaim.js';
import {
  isReservedTokenName,
  isReservedTicker,
  reservedNameUserMessage,
  reservedTickerUserMessage,
} from '../lib/reservedTokens.js';
import {
  DEPLOY_LIMIT_MEME_PROCEED_USER_NOTICE,
  MEME_TOKEN_DESCRIPTION_TAGLINE,
  memeFeeWalletAndLabel,
  textIndicatesMemeNoDevFee,
} from '../lib/memeFeeRecipient.js';
import { getAddress } from 'viem';
import { applyDeployRateLimitBurn } from '../lib/deployRateLimitBurn.js';
import { listThirdPartyFeeTokensForFeeRecipientRollingHours } from '../lib/deploymentCatalog.js';
import {
  deployRateLimitRollingHours,
  thirdPartyRollingWindowDeployWarnUserMessage,
} from '../lib/selfFeeLimit.js';
import { launcherTradeDeepLink, parseTradeIntentMessage } from '../lib/tradeIntent.js';
import { createIdentity } from '../lib/privy.js';
import {
  executeDelegatedSwapFromChat,
  isDelegatedServerSwapConfigured,
} from '../lib/delegatedSwapExecution.js';
import {
  isChatAgentConfigured,
  runChatAgentForIdentity,
  truncateForX,
} from '../lib/chatAgentBridge.js';
import {
  executeWalletTransfer,
  getWalletBalanceText,
  getWalletPortfolioText,
  parseWalletCommandMessage,
  wantsDeployIntent,
} from '../lib/walletActions.js';
import {
  inferExplicitDeployChainFromText,
  resolveDeployChain,
  type DeployChain,
} from '../lib/deployChain.js';

function buildXSuccessReply(launcherInAppSwapUrl: string): string {
  return launcherInAppSwapUrl.trim();
}

export interface XCredentials {
  consumerKey: string;
  consumerSecret: string;
  accessToken: string;
  accessTokenSecret: string;
}

// OAuth 1.0a signing for X API
function oauthSign(
  method: string,
  url: string,
  params: Record<string, string>,
  consumerSecret: string,
  tokenSecret: string
): string {
  const sortedParams = Object.keys(params)
    .sort()
    .map(k => `${encodeURIComponent(k)}=${encodeURIComponent(params[k])}`)
    .join('&');

  const baseString = `${method.toUpperCase()}&${encodeURIComponent(url)}&${encodeURIComponent(sortedParams)}`;
  const signingKey = `${encodeURIComponent(consumerSecret)}&${encodeURIComponent(tokenSecret)}`;
  
  return crypto.createHmac('sha1', signingKey).update(baseString).digest('base64');
}

const X_API_BASE = 'https://api.x.com';

/**
 * Deploy intent for X: shared `wantsDeployIntent` (whole-word deploy/launch — not substring of @liquidlauncher)
 * plus natural tweet phrasing (deployed, create, …).
 */
function tweetHasDeployIntentKeywords(lowerText: string): boolean {
  if (wantsDeployIntent(lowerText)) return true;
  return /\b(?:deployed|deployment|launched|create|creating)\b/.test(lowerText);
}

function tweetHasClaimIntentOnly(lowerText: string): boolean {
  if (!/\bclaim\b/.test(lowerText)) return false;
  return !tweetHasDeployIntentKeywords(lowerText);
}

/** OAuth 1.0a signed GET — `baseUrl` has no query string; signature includes `query` + oauth params. */
async function oauth1aGet(
  baseUrl: string,
  query: Record<string, string>,
  credentials: XCredentials
): Promise<Response> {
  const oauthParams: Record<string, string> = {
    oauth_consumer_key: credentials.consumerKey,
    oauth_nonce: crypto.randomBytes(16).toString('hex'),
    oauth_signature_method: 'HMAC-SHA1',
    oauth_timestamp: Math.floor(Date.now() / 1000).toString(),
    oauth_token: credentials.accessToken,
    oauth_version: '1.0',
  };
  const allParams: Record<string, string> = { ...query, ...oauthParams };
  oauthParams.oauth_signature = oauthSign(
    'GET',
    baseUrl,
    allParams,
    credentials.consumerSecret,
    credentials.accessTokenSecret
  );
  const authHeader =
    'OAuth ' +
    Object.keys(oauthParams)
      .sort()
      .map(k => `${encodeURIComponent(k)}="${encodeURIComponent(oauthParams[k])}"`)
      .join(', ');
  const qs = new URLSearchParams(query).toString();
  return fetch(`${baseUrl}?${qs}`, { headers: { Authorization: authHeader } });
}

export class XWebhookHandler {
  private deployer: LiquidDeployer;
  private credentials: XCredentials;
  private sessions: Map<string, any> = new Map();
  /** v2 /2/users/me or X_BOT_USER_ID */
  private botUserIdResolved: string | null = null;
  /**
   * After `GET /2/users/me` fails once (suspended app, revoked tokens, banned account), stop retrying
   * every poll — avoids log spam and useless API calls until redeploy or env fix.
   */
  private botUserIdMeGiveUp = false;
  /** newest_id from last mentions response (v2 polling) */
  private lastMentionId: string | undefined;
  /** true after first poll — prevents reprocessing backlog on cold start */
  private mentionsCursorPrimed = false;
  private mentionsPollTimer: NodeJS.Timeout | null = null;

  constructor(deployer: LiquidDeployer) {
    this.deployer = deployer;

    if (!config.x.consumerKey || !config.x.accessToken) {
      throw new Error('X credentials not configured');
    }

    this.credentials = {
      consumerKey: config.x.consumerKey,
      consumerSecret: config.x.consumerSecret || '',
      accessToken: config.x.accessToken,
      accessTokenSecret: config.x.accessTokenSecret || '',
    };

    // Poller is started externally (index.ts) to avoid duplicate interval from constructor + init call.
  }

  private tweetMentionsBot(text: string): boolean {
    const handle = config.x.botUsername;
    if (!handle) return true; // if not set, assume all @mentions are for us
    const pattern = new RegExp(`@${handle}\\b`, 'i');
    return pattern.test(text);
  }

  private isDeployBlocklisted(username: string): boolean {
    if (!config.x.deployBlocklist) return false;
    return config.x.deployBlocklist.has(username.toLowerCase());
  }

  // Handle incoming webhook (from X API or Neynar)
  async handleWebhook(payload: any): Promise<void> {
    logger.info('X webhook received:', { type: payload.type || 'mention' });

    // Handle tweet mention
    if (payload.tweet_create_events || payload.text) {
      const tweet = payload.tweet_create_events?.[0] || payload;
      await this.handleMention(tweet);
    }
  }

  private async handleMention(tweet: any): Promise<void> {
    const text = tweet.text;
    const username = tweet.user?.screen_name || 'user';
    const tweetId = tweet.id_str;
    const authorId = tweet.user?.id_str;

    if (!text || !tweetId || !authorId) {
      logger.warn('X handleTweet: missing text, tweet id, or author id', {
        tweetId,
        authorId,
      });
      return;
    }

    logger.info('X webhook tweet:', { username, text: text.slice(0, 100) });

    const isReply = Boolean(tweet.in_reply_to_status_id_str);
    // New posts should @mention the bot; thread replies ("yes", wallet, etc.) often omit @handle
    if (!isReply && !this.tweetMentionsBot(text)) {
      logger.debug('X: skipping — top-level tweet does not @mention the bot', {
        bot: config.x.botUsername,
      });
      return;
    }

    if (this.isDeployBlocklisted(username)) {
      logger.info('X: skipping — account on deploy blocklist', { username });
      return;
    }

    const lowerText = text.toLowerCase();

    if (tweetHasClaimIntentOnly(lowerText)) {
      await this.handleClaimTweet(text, tweetId, username, authorId);
      return;
    }

    const aiMatch = text.match(/\/(?:ai|ask)\s+([\s\S]+)/i);
    if (aiMatch?.[1]?.trim()) {
      if (!isChatAgentConfigured()) {
        await this.reply(
          tweetId,
          `@${username} AI assistant is not configured on this server (LLM API key).`,
        );
        return;
      }
      await this.handleAiTweet(tweetId, username, authorId, aiMatch[1].trim());
      return;
    }

    const walletCmd = parseWalletCommandMessage(text);
    if (walletCmd) {
      const identity = createIdentity('x', authorId, username);
      if (walletCmd.kind === 'balance') {
        const summary = await getWalletBalanceText(identity, walletCmd.tokenAddress);
        await this.reply(tweetId, truncateForX(`@${username} ${summary}`, 280));
      } else if (walletCmd.kind === 'portfolio') {
        const summary = await getWalletPortfolioText(identity);
        await this.reply(tweetId, truncateForX(`@${username} ${summary}`, 280));
      } else {
        const result = await executeWalletTransfer(identity, walletCmd);
        const reply = result.ok
          ? `@${username} ✅ Transfer submitted.${result.isPendingUserOperation ? ' Waiting on final Base tx hash.' : ''} ${result.basescanUrl}`
          : `@${username} ❌ ${result.error}${result.hint ? ` ${result.hint}` : ''}`;
        await this.reply(tweetId, truncateForX(reply, 280));
      }
      return;
    }

    const tradeIntent = parseTradeIntentMessage(text);
    if (tradeIntent) {
      if (tradeIntent.amount && isDelegatedServerSwapConfigured()) {
        const identity = createIdentity('x', authorId, username);
        const result = await executeDelegatedSwapFromChat(identity, tradeIntent);
        const reply = result.ok
          ? `@${username} ✅ Submitted ${tradeIntent.side} ${tradeIntent.amount}.${result.isPendingUserOperation ? ' Waiting on final Base tx hash.' : ''} ${result.basescanUrl}`
          : `@${username} ❌ ${result.error}${result.hint ? ` ${result.hint}` : ''}`;
        await this.reply(tweetId, truncateForX(reply, 280));
        return;
      }
      const url = launcherTradeDeepLink(tradeIntent.address, tradeIntent.side);
      const flip = tradeIntent.side === 'buy' ? 'sell' : 'buy';
      const flipUrl = launcherTradeDeepLink(tradeIntent.address, flip);
      await this.reply(
        tweetId,
        `@${username} 💱 ${tradeIntent.side === 'buy' ? 'Buy' : 'Sell'} (Base · 0x)\n\n` +
          `${url}\n\n` +
          `${flip === 'buy' ? 'Buy' : 'Sell'} instead: ${flipUrl}\n\n` +
          `Open Liquid Launcher to quote and trade (sign in with the same account you use here).`,
      );
      return;
    }

    // Check for deploy/launch keywords (whole words — see tweetHasDeployIntentKeywords)
    if (!tweetHasDeployIntentKeywords(lowerText)) {
      // Not a deployment request - send help
      if (lowerText.includes('help')) {
        await this.handleHelp(tweetId, username);
      }
      return;
    }

    // Parse the tweet
    const parsed = parseLaunchRequest(text);
    const fromMedia = extractTwitterMediaImageUrl(tweet);
    const fromText = extractImageUrlFromText(text);
    parsed.imageUrl = fromMedia || parsed.imageUrl || fromText;

    // Require name + symbol before calling Privy (avoids blaming Privy for bad tweets)
    if (!parsed.isValid) {
      const prompt = generateMissingFieldsPrompt(parsed);
      await this.reply(tweetId,
        `@${username} Almost there! 🚀

${prompt}

Format: @liquidlauncher deploy [name] [symbol]`
      );
      return;
    }

    const memeFees = textIndicatesMemeNoDevFee(text);
    let fee:
      | { address: string; isNew: boolean; source: 'meme' }
      | { address: string; isNew: boolean; source: 'privy'; privyUserId: string }
      | null = null;
    let feeRecipientLabel: string | undefined;

    if (memeFees) {
      const m = memeFeeWalletAndLabel();
      parsed.walletAddress = m.walletAddress;
      feeRecipientLabel = m.feeRecipientLabel;
      fee = { address: m.walletAddress, isNew: false, source: 'meme' };
    } else {
      fee = await this.resolveXFeeWallet(parsed, authorId, username);
      if (!fee) {
        await this.reply(
          tweetId,
          `@${username} Could not create your fee wallet (Privy). Check \`PRIVY_APP_ID\` / \`PRIVY_APP_SECRET\` on the server (and that \`USE_PRIVY_WALLETS\` is not \`false\`). On X, fees normally go to *your* linked wallet — tweet *meme*, *no dev*, or *fees to no one* for a burn-address (No Dev) fee recipient.`,
        );
        return;
      }
      parsed.walletAddress = fee.address;
    }

    // Check for duplicate deploy (same token + wallet by same author)
    if (isReservedTicker(parsed.symbol!)) {
      await this.reply(
        tweetId,
        `@${username} ❌ ${reservedTickerUserMessage(parsed.symbol!)}`,
      );
      return;
    }
    if (isReservedTokenName(parsed.name!)) {
      await this.reply(tweetId, `@${username} ❌ ${reservedNameUserMessage()}`);
      return;
    }

    if (await isTickerGloballyReserved(parsed.symbol!)) {
      await this.reply(
        tweetId,
        `@${username} ❌ ${await formatGlobalTickerCooldownMessage(parsed.symbol!)}`,
      );
      return;
    }

    let xFeeWalletPreLimit: `0x${string}` | null = null;
    if (!memeFees && parsed.walletAddress) {
      try {
        xFeeWalletPreLimit = getAddress(parsed.walletAddress as `0x${string}`);
      } catch {
        xFeeWalletPreLimit = null;
      }
    }

    let rateLimitForcedBurn = false;
    let feeToSelfDeploy = !memeFees;
    if (!memeFees && parsed.walletAddress) {
      const limited = await applyDeployRateLimitBurn({
        walletAddress: parsed.walletAddress,
        feeRecipientLabel,
        feeToSelf: true,
        platform: 'x',
        deployerId: authorId,
        privyUserId: fee && fee.source === 'privy' ? fee.privyUserId : null,
      });
      parsed.walletAddress = limited.walletAddress;
      if (limited.feeRecipientLabel) feeRecipientLabel = limited.feeRecipientLabel;
      feeToSelfDeploy = limited.feeToSelf;
      rateLimitForcedBurn = limited.rateLimitForcedBurn;
    }

    if (rateLimitForcedBurn) {
      await this.reply(
        tweetId,
        `@${username} ⚠️ ${DEPLOY_LIMIT_MEME_PROCEED_USER_NOTICE}`,
      );
    }

    const rollingHX = deployRateLimitRollingHours();
    if (xFeeWalletPreLimit && rollingHX > 0 && !memeFees) {
      const thirdRecentX = await listThirdPartyFeeTokensForFeeRecipientRollingHours(
        xFeeWalletPreLimit,
        rollingHX,
        6,
      );
      if (thirdRecentX.length > 0) {
        await this.reply(
          tweetId,
          `@${username} ⚠️ Others launched for this fee wallet in the last ${rollingHX}h (${thirdRecentX.length}).\n\n${thirdPartyRollingWindowDeployWarnUserMessage(rollingHX)}`,
        );
      }
    }

    let deployChain: DeployChain;
    if (config.ethereum.deployEnabled) {
      const explicit = inferExplicitDeployChainFromText(text);
      if (!explicit) {
        const bot = (config.x.botUsername || 'liquidlauncher').replace(/^@/, '');
        await this.reply(
          tweetId,
          `@${username} Which chain should this token deploy on?\n\n` +
            `Tweet again and include the word **base** (Liquid on Base) or **ethereum** (Ethereum mainnet) in the same tweet — e.g. \`@${bot} deploy MyToken MTK base\` or add a line with **ethereum**.`,
        );
        return;
      }
      deployChain = explicit;
    } else {
      deployChain = resolveDeployChain({ messageText: text });
    }

    const deployReq: DeployRequest = {
      platform: 'x',
      sourceId: tweetId,
      authorId,
      name: parsed.name!,
      symbol: parsed.symbol!,
      walletAddress: parsed.walletAddress!,
      chain: deployChain,
    };
    const { isDuplicate } = await checkAndRecordDeploy(deployReq);
    if (isDuplicate) {
      await this.reply(
        tweetId,
        `@${username} ⚠️ We already deployed this token from your account.\n\n` +
        `If you meant to create a different token, please provide a different name, symbol, or wallet.`
      );
      return;
    }

    // X: Deploy immediately (no confirmation step — rate limiting + threading issues)
    const profileImageUrl = extractXProfileImageUrl(tweet);

    try {
      const originalTweetUrl = `https://x.com/${username}/status/${tweetId}`;
      const baseDescription = `Deployed by X @${username}`;
      const useMemeStyleDescription = memeFees || rateLimitForcedBurn;
      const userParagraph = extractLaunchUserDescription(text, parsed.name!, parsed.symbol!);
      let tokenDescription: string;
      if (useMemeStyleDescription) {
        tokenDescription = `${baseDescription} | ${originalTweetUrl}\n\n${MEME_TOKEN_DESCRIPTION_TAGLINE}`;
      } else if (userParagraph) {
        tokenDescription = `${baseDescription} | ${originalTweetUrl}\n\n${userParagraph}`;
      } else {
        tokenDescription = `${baseDescription} | ${originalTweetUrl}`;
      }

      const result = await this.deployer.deployToken({
        name: parsed.name!,
        symbol: parsed.symbol!,
        walletAddress: parsed.walletAddress!,
        devBuyAmount: config.deployBondWei,
        hookType: 'static',
        description: tokenDescription,
        imageUrl: parsed.imageUrl || profileImageUrl,
        username: username,
        platform: 'x',
        deployerId: authorId,
        deployerLabel: `@${username}`,
        sourceUrl: originalTweetUrl,
        ...(feeRecipientLabel ? { feeRecipientLabel } : {}),
        feeToSelf: feeToSelfDeploy,
        ...(fee && fee.source === 'privy' ? { privyUserId: fee.privyUserId } : {}),
        chain: deployChain,
      });

      const links = this.deployer.generateTokenLinks(result.tokenAddress, result.chain);

      // Post to Discord feed
      const embed = new EmbedBuilder()
        .setTitle(
          `🌊 Token Deployed on X (${result.chain === 'ethereum' ? 'Ethereum' : 'Base'})`,
        )
        .setDescription(
          `**${parsed.name!}** (\`$${parsed.symbol!}\`)\n\n` +
          `[Liquid](${links.liquid}) · [Uniswap swap](${links.uniswapSwap}) · [Uniswap token](${links.uniswap})`
        )
        .addFields(
          { name: 'Platform', value: 'X (Twitter)', inline: true },
          { name: 'Deployer', value: `@${username}`, inline: true },
          {
            name: 'Chain',
            value: result.chain === 'ethereum' ? 'Ethereum' : 'Base',
            inline: true,
          },
          { name: 'Token Address', value: result.tokenAddress, inline: false },
          {
            name: feeRecipientLabel ? 'Fee recipient' : 'Wallet',
            value: feeRecipientLabel
              ? `${feeRecipientLabel}\n${parsed.walletAddress!}`
              : parsed.walletAddress!,
            inline: false,
          },
        )
        .setColor(0x1da1f2) // X blue
        .setTimestamp();

      await feedPost(embed);

      const replyText = buildXSuccessReply(links.launcherInAppSwap);

      await this.reply(tweetId, replyText);

    } catch (error: any) {
      logger.error('X deployment failed:', error);
      await this.reply(tweetId, `@${username} ❌ Deployment failed: ${error.message}`);
    }
  }

  /**
   * Fee wallet when the tweet has no explicit `0x`:
   * - **Reuse** the Privy embedded wallet for this X account if it already exists (same Twitter user id;
   *   e.g. they deployed before, or we already provisioned them via `custom_auth` `x:<id>`).
   * - **Otherwise** create a Privy user + embedded wallet, then deploy uses that address.
   */
  /**
   * X: fees must always go to the deployer’s own wallet (Privy linked to this X account).
   * Routing fees to another person’s 0x or social is not supported on X (platform policy).
   * Any `0x` in the tweet is ignored for fee routing — we do not assign tokens to third parties from X.
   */
  private async handleClaimTweet(
    text: string,
    tweetId: string,
    username: string,
    authorId: string,
  ): Promise<void> {
    const hint = parseClaimTokenHint(text);
    if (!hint.tokenAddress && !hint.tokenSymbol) {
      await this.reply(
        tweetId,
        `@${username} Usage: @${config.x.botUsername || 'liquidlauncher'} claim 0x… (token contract) or claim $TICKER — for a token *you* deployed from X with fees to your linked wallet.`,
      );
      return;
    }

    const pw = await getOrCreateWalletForUser('x', authorId, username);
    if (!pw) {
      await this.reply(
        tweetId,
        `@${username} Fee wallet unavailable (Privy). Check server \`PRIVY_APP_ID\` / \`USE_PRIVY_WALLETS\`.`,
      );
      return;
    }

    const result = await runSocialTradingFeesClaim({
      platform: 'x',
      deployerId: authorId,
      feeRecipientAddress: pw.address,
      tokenAddress: hint.tokenAddress,
      tokenSymbol: hint.tokenSymbol,
    });

    if (!result.ok) {
      await this.reply(tweetId, `@${username} ${result.message}`);
      return;
    }

    await this.reply(
      tweetId,
      `@${username} Claimed ${result.feeAmountHuman} ETH (WETH) trading fees.\n${result.basescanUrl}`,
    );
  }

  private async resolveXFeeWallet(
    _parsed: { walletAddress?: string },
    authorId: string,
    username: string,
  ): Promise<{
    address: string;
    isNew: boolean;
    source: 'privy' | 'meme';
    privyUserId: string;
  } | null> {
    const walletInfo = await getOrCreateWalletForUser('x', authorId, username);
    if (!walletInfo) return null;
    logger.info('X: fee wallet via Privy (self only)', { username, address: walletInfo.address });
    return {
      address: walletInfo.address,
      isNew: walletInfo.isNew,
      source: 'privy',
      privyUserId: walletInfo.privyUserId,
    };
  }

  private async handleHelp(tweetId: string, username: string): Promise<void> {
    const h = config.globalTickerCooldownHours;
    const tickerLine =
      h > 0
        ? `• Each *ticker symbol* can only be deployed once every ${h} hours (globally — any user). Pick a unique symbol.\n`
        : '';
    const helpMsg =
      `🤖 @${username} Liquid Launcher\n\n` +
      `Deploy tokens on Base with locked liquidity!\n\n` +
      `Wallet: *balance*, *what's my balance*, *portfolio* — your linked Base wallet (same account)\n` +
      `Tweet: @liquidlauncher deploy [name] [symbol]` +
      (config.ethereum.deployEnabled
        ? ` — include *base* or *ethereum* for which chain.\n`
        : '\n') +
      `AI: */ai your question* (markets, wallet, swaps — same linked account)\n` +
      `Trade (opens app): *buy 0x…* or *sell 0x…* (Base token contract)\n` +
      `Add more text in the tweet for a longer on-chain description (paragraphs OK).\n` +
      `Claim trading fees: @liquidlauncher claim 0x… or claim $TICKER (same X account + fee wallet as deploy)\n\n` +
      tickerLine +
      `• *Dead / meme wallet:* add *meme*, *no dev*, or *fees to no one* — unlimited deploys; fees go to burn.\n` +
      `• To route fees to someone else’s social or wallet, use the website, Telegram, or Discord — not X.\n\n` +
      `All tokens: 100B supply, Uniswap V4, locked LP`;

    await this.reply(tweetId, helpMsg);
  }

  private async handleAiTweet(
    tweetId: string,
    username: string,
    authorId: string,
    prompt: string,
  ): Promise<void> {
    const prefix = `@${username} `;
    const identity = createIdentity('x', authorId, username);
    try {
      const { output } = await runChatAgentForIdentity({ identity, userMessage: prompt });
      const body = truncateForX(output, Math.max(60, 280 - prefix.length));
      await this.reply(tweetId, `${prefix}${body}`);
    } catch (e: unknown) {
      logger.error('X /ai tweet:', e);
      const err = e instanceof Error ? e.message : String(e);
      await this.reply(
        tweetId,
        `${prefix}${truncateForX(`❌ ${err}`, Math.max(40, 280 - prefix.length))}`,
      );
    }
  }

  private async reply(tweetId: string, text: string): Promise<void> {
    try {
      const url = 'https://api.x.com/2/tweets';
      const oauth: Record<string, string> = {
        oauth_consumer_key: this.credentials.consumerKey,
        oauth_nonce: crypto.randomBytes(16).toString('hex'),
        oauth_signature_method: 'HMAC-SHA1',
        oauth_timestamp: Math.floor(Date.now() / 1000).toString(),
        oauth_token: this.credentials.accessToken,
        oauth_version: '1.0',
      };

      oauth.oauth_signature = oauthSign(
        'POST', 
        url, 
        oauth, 
        this.credentials.consumerSecret, 
        this.credentials.accessTokenSecret
      );

      const authHeader = 'OAuth ' + Object.keys(oauth)
        .map(k => `${encodeURIComponent(k)}="${encodeURIComponent((oauth as any)[k])}"`)
        .join(', ');

      const body = {
        text: String(text).trim(),
        reply: { in_reply_to_tweet_id: tweetId }
      };

      logger.debug('X reply payload:', { body: JSON.stringify(body) });

      const response = await fetch(url, {
        method: 'POST',
        headers: {
          'Authorization': authHeader,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(body),
      });

      if (!response.ok) {
        const error = await response.text();
        throw new Error(`X API error: ${response.status} - ${error}`);
      }

      logger.info('Replied to tweet:', { tweetId, text: text.slice(0, 50) });

    } catch (error: any) {
      logger.error('Failed to reply on X:', error);
    }
  }

  /**
   * Poll X API v2 `GET /2/users/:id/mentions`. Legacy v1.1 Account Activity subscriptions
   * return 410, so push webhooks to `/webhooks/x` never fire for most apps.
   */
  async startMentionsPoller(): Promise<void> {
    const ms = config.x.mentionsPollMs;
    if (ms <= 0) {
      logger.info(
        'X mentions polling off (X_MENTIONS_POLL_MS=0). Legacy webhooks are unreliable (410); enable polling or Enterprise v2 Account Activity.'
      );
      return;
    }
    if (this.mentionsPollTimer) return;

    // Restore cursor from DB — prevents reprocessing old tweets on restart
    const saved = await loadCursor('x_last_mention_id');
    if (saved) {
      this.lastMentionId = saved;
      this.mentionsCursorPrimed = true; // already primed — don't skip first batch
      logger.info('X mentions: restored cursor from DB', { since_id: saved });
    }

    logger.info(`X mentions: polling every ${ms}ms via v2 /users/:id/mentions`);
    void this.pollMentionsOnce().catch((e: any) =>
      logger.warn('X mentions poll:', e?.message)
    );
    this.mentionsPollTimer = setInterval(() => {
      void this.pollMentionsOnce().catch((e: any) =>
        logger.warn('X mentions poll:', e?.message)
      );
    }, ms);
  }

  private async resolveBotUserId(): Promise<string | null> {
    if (config.x.botUserId) return config.x.botUserId;
    if (this.botUserIdMeGiveUp) return null;
    if (this.botUserIdResolved) return this.botUserIdResolved;
    const url = `${X_API_BASE}/2/users/me`;
    const res = await oauth1aGet(url, { 'user.fields': 'profile_image_url' }, this.credentials);
    if (!res.ok) {
      const t = await res.text();
      this.botUserIdMeGiveUp = true;
      logger.error(
        'X GET /2/users/me failed — mentions polling will stay off until restart. ' +
          'Fix OAuth tokens / developer app access, or set X_BOT_USER_ID to skip this call. ' +
          'If the X account or app was suspended, create new credentials in the X Developer Portal.',
        { status: res.status, body: t.slice(0, 400) },
      );
      return null;
    }
    const j = (await res.json()) as { data?: { id?: string } };
    const id = j.data?.id;
    if (id) {
      this.botUserIdResolved = id;
      logger.info('X bot user id (from /2/users/me)', { id });
    }
    return id ?? null;
  }

  private v2TweetToLegacy(
    t: Record<string, unknown>,
    includes: { users?: Record<string, unknown>[]; media?: Record<string, unknown>[] }
  ): Record<string, unknown> {
    const usersById = new Map(
      (includes.users ?? []).map(u => [String(u.id), u] as [string, Record<string, unknown>])
    );
    const mediaByKey = new Map(
      (includes.media ?? []).map(m => [String(m.media_key), m] as [string, Record<string, unknown>])
    );
    const authorId = String(t.author_id ?? '');
    const author = usersById.get(authorId);
    const att = t.attachments as { media_keys?: string[] } | undefined;
    const legacyMedia: { type: string; media_url_https: string }[] = [];
    if (Array.isArray(att?.media_keys)) {
      for (const k of att.media_keys) {
        const m = mediaByKey.get(k);
        if (!m) continue;
        const url =
          m.type === 'photo'
            ? String(m.url ?? '')
            : String((m.preview_image_url as string) || m.url || '');
        if (url) legacyMedia.push({ type: 'photo', media_url_https: url });
      }
    }
    let in_reply_to_status_id_str: string | undefined;
    const refs = t.referenced_tweets as { type: string; id: string }[] | undefined;
    if (Array.isArray(refs)) {
      const replied = refs.find(r => r.type === 'replied_to');
      if (replied) in_reply_to_status_id_str = replied.id;
    }
    const user = author
      ? {
          id_str: String(author.id),
          screen_name: String(author.username ?? 'user'),
          profile_image_url: author.profile_image_url as string | undefined,
          profile_image_url_https: author.profile_image_url as string | undefined,
        }
      : { id_str: authorId, screen_name: 'user' };

    return {
      id_str: String(t.id),
      text: String(t.text ?? ''),
      user,
      in_reply_to_status_id_str,
      ...(legacyMedia.length ? { extended_entities: { media: legacyMedia } } : {}),
    };
  }

  private async pollMentionsOnce(): Promise<void> {
    const uid = await this.resolveBotUserId();
    if (!uid) return;

    const query: Record<string, string> = {
      max_results: '10',
      expansions: 'author_id,attachments.media_keys',
      'tweet.fields': 'created_at,author_id,referenced_tweets,attachments',
      'user.fields': 'username,profile_image_url',
      'media.fields': 'url,preview_image_url,type',
    };
    if (this.lastMentionId) query.since_id = this.lastMentionId;

    const url = `${X_API_BASE}/2/users/${uid}/mentions`;
    const res = await oauth1aGet(url, query, this.credentials);
    if (!res.ok) {
      const errText = await res.text();
      if (res.status === 402) {
        logger.warn(
          'X mentions GET 402 — X API blocks this route on many free/low tiers; GET /2/users/me can still succeed. ' +
            'User mention timeline usually needs a paid Developer Portal plan (e.g. Basic) or post-pay credits. ' +
            'Upgrade the app or set X_MENTIONS_POLL_MS=0 to silence polling until mentions access exists.',
          errText.slice(0, 500),
        );
      } else {
        logger.warn(`X mentions GET ${res.status}:`, errText.slice(0, 500));
      }
      return;
    }
    const body = (await res.json()) as {
      data?: Record<string, unknown>[];
      meta?: { newest_id?: string; oldest_id?: string; result_count?: number };
      includes?: { users?: Record<string, unknown>[]; media?: Record<string, unknown>[] };
      errors?: { detail?: string }[];
    };
    if (body.errors?.length) {
      logger.warn('X mentions response errors:', body.errors);
    }
    const data = body.data ?? [];
    const meta = body.meta;
    const includes = body.includes ?? {};

    if (!this.mentionsCursorPrimed) {
      this.mentionsCursorPrimed = true;
      // Always skip backlog on first poll when no cursor was loaded from DB.
      // This protects against redeploying old tokens when the DB is wiped (ephemeral containers).
      // X_MENTIONS_PROCESS_BACKLOG=true only applies when cursor was restored from persistent storage.
      if (data.length > 0) {
        if (meta?.newest_id) {
          this.lastMentionId = meta.newest_id;
          void saveCursor('x_last_mention_id', meta.newest_id);
        }
        logger.info('X mentions: first poll — skipped backlog, cursor advanced to', meta?.newest_id);
        return;
      }
    }

    const sorted = [...data].sort((a, b) => {
      const ia = BigInt(String(a.id ?? '0'));
      const ib = BigInt(String(b.id ?? '0'));
      return ia < ib ? -1 : ia > ib ? 1 : 0;
    });

    for (const tw of sorted) {
      // Skip tweets from the bot itself (don't process our own replies)
      if (String(tw.author_id) === uid) {
        logger.debug('X mentions: skipping bot\'s own tweet', { id: tw.id });
        continue;
      }
      const legacy = this.v2TweetToLegacy(tw, includes);
      await this.handleWebhook({ tweet_create_events: [legacy] });
    }

    if (meta?.newest_id) {
      this.lastMentionId = meta.newest_id;
      void saveCursor('x_last_mention_id', meta.newest_id);
    }
  }

  /** No-op: legacy v1.1 subscription returns 410. Use {@link startMentionsPoller}. */
  async subscribeWebhook(): Promise<void> {
    logger.info(
      'X: Legacy Account Activity subscription is disabled (410). Using v2 mentions polling — see startMentionsPoller().'
    );
  }

  // Post a new tweet (not a reply)
  async postTweet(text: string): Promise<void> {
    try {
      const url = 'https://api.x.com/2/tweets';
      const oauth: Record<string, string> = {
        oauth_consumer_key: this.credentials.consumerKey,
        oauth_nonce: crypto.randomBytes(16).toString('hex'),
        oauth_signature_method: 'HMAC-SHA1',
        oauth_timestamp: Math.floor(Date.now() / 1000).toString(),
        oauth_token: this.credentials.accessToken,
        oauth_version: '1.0',
      };

      oauth.oauth_signature = oauthSign(
        'POST', 
        url, 
        oauth, 
        this.credentials.consumerSecret, 
        this.credentials.accessTokenSecret
      );

      const authHeader = 'OAuth ' + Object.keys(oauth)
        .map(k => `${encodeURIComponent(k)}="${encodeURIComponent((oauth as any)[k])}"`)
        .join(', ');

      await fetch(url, {
        method: 'POST',
        headers: {
          'Authorization': authHeader,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ text }),
      });

      logger.info('Posted tweet:', { text: text.slice(0, 50) });

    } catch (error: any) {
      logger.error('Failed to post tweet:', error);
    }
  }
}
