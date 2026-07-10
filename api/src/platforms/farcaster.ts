import { getAddress } from 'viem';
import { config } from '../config.js';
import { logger } from '../logger.js';
import { LiquidDeployer } from '../deployer.js';
import { NeynarClient, type FarcasterUser } from '../neynar.js';
import { debugInfo, debugError, debugSuccess, debugLog } from '../lib/discordDebug.js';
import { extractCastImageUrl } from '../lib/farcasterCast.js';
import { extractImageUrlFromText } from '../lib/imageSources.js';
import { parseClaimTokenHint } from '../parser.js';
import { runSocialTradingFeesClaim } from '../lib/socialFeeClaim.js';
import {
  isReservedTokenName,
  isReservedTicker,
  reservedNameUserMessage,
  reservedTickerUserMessage,
} from '../lib/reservedTokens.js';
import { getOrCreateWalletForUser } from '../lib/recipientResolver.js';
import {
  DEPLOY_LIMIT_MEME_PROCEED_USER_NOTICE,
  MEME_TOKEN_DESCRIPTION_TAGLINE,
  memeFeeWalletAndLabel,
  textIndicatesMemeNoDevFee,
} from '../lib/memeFeeRecipient.js';
import {
  formatGlobalTickerCooldownMessage,
  isTickerGloballyReserved,
  thirdPartyFeeRecipientCooldownErrorOrNull,
} from '../lib/globalTickerCooldown.js';
import { applyDeployRateLimitBurn } from '../lib/deployRateLimitBurn.js';
import { listThirdPartyFeeTokensForFeeRecipientRollingHours } from '../lib/deploymentCatalog.js';
import {
  deployRateLimitRollingHours,
  thirdPartyRollingWindowDeployWarnUserMessage,
} from '../lib/selfFeeLimit.js';
import { launcherTradeDeepLink, parseTradeIntentMessage } from '../lib/tradeIntent.js';
import type { DeployChain } from '../lib/deployChain.js';
import {
  inferExplicitDeployChainFromText,
  resolveDeployChain,
} from '../lib/deployChain.js';
import {
  executeDelegatedSwapFromChat,
  isDelegatedServerSwapConfigured,
} from '../lib/delegatedSwapExecution.js';
import { createIdentity } from '../lib/privy.js';
import {
  isChatAgentConfigured,
  runChatAgentForIdentity,
  truncateForFarcaster,
} from '../lib/chatAgentBridge.js';
import {
  executeWalletTransfer,
  getWalletBalanceText,
  getWalletPortfolioText,
  parseWalletCommandMessage,
  wantsDeployIntent,
} from '../lib/walletActions.js';

interface CastData {
  hash: string;
  text: string;
  /** URL / image embeds from the cast (Neynar includes these on webhooks) */
  embeds?: unknown[];
  author: {
    fid: number;
    username: string;
    display_name: string;
    // Neynar includes these directly in the webhook cast author
    custody_address?: string;
    pfp_url?: string;
    verified_addresses?: {
      eth_addresses?: string[];
    };
  };
  mentioned_profiles?: Array<{
    fid: number;
    username: string;
  }>;
}

interface WebhookPayload {
  type: string;
  // Neynar sends cast data in the `data` field (not `cast`)
  data?: CastData;
  // Some older Neynar webhook versions used `cast` — support both
  cast?: CastData;
}

interface PendingDeploy {
  name: string;
  symbol: string;
  authorFid: number;
  authorUsername: string;
  replyToCastHash: string;  // original cast to reply to
  imageUrl?: string;
  /** Extra lines / inline text from the original deploy cast (on-chain description). */
  userDescription?: string;
  /** Resolved from deploy cast text / defaults — carried into wallet-reply deploy. */
  deployChain: DeployChain;
}

export class FarcasterHandler {
  private deployer: LiquidDeployer;
  private neynar: NeynarClient;
  // Keyed by FID — tracks users who were asked to provide their wallet address
  private pendingDeploys: Map<number, PendingDeploy> = new Map();
  /** One handler run per cast — Neynar may deliver the same cast.created more than once. Capped at 2000 entries to bound memory. */
  private processedCastHashes: Set<string> = new Set();
  private static readonly MAX_PROCESSED_HASHES = 2000;
  
  constructor(deployer: LiquidDeployer, neynar: NeynarClient) {
    this.deployer = deployer;
    this.neynar = neynar;
    logger.info('Farcaster handler initialized');
  }

  /**
   * Token image: cast embeds → API embeds → URL in text → author PFP (webhook or Neynar user).
   */
  private async resolveTokenImageUrl(cast: CastData): Promise<string | undefined> {
    let url = extractCastImageUrl(cast.embeds);
    if (url) return url;
    if (cast.hash) {
      const embeds = await this.neynar.getCastEmbedsByHash(cast.hash);
      url = extractCastImageUrl(embeds);
      if (url) {
        await debugInfo('Farcaster: Image resolved via API', url.slice(0, 200));
        return url;
      }
    }
    url = extractImageUrlFromText(cast.text || '');
    if (url) return url;

    const pfp =
      typeof cast.author.pfp_url === 'string' && cast.author.pfp_url.startsWith('http')
        ? cast.author.pfp_url
        : undefined;
    if (pfp) return pfp;

    const user = await this.neynar.getUserByFid(cast.author.fid);
    if (user?.pfpUrl) return user.pfpUrl;
    return undefined;
  }
  
  async handleWebhook(payload: WebhookPayload): Promise<void> {
    logger.info('Farcaster webhook received:', { type: payload.type });

    // Neynar can send cast in either `data` or `cast` field depending on webhook version
    const castData = payload.data ?? payload.cast;

    if (payload.type !== 'cast.created' || !castData) {
      await debugInfo('Farcaster: Skipped', `Not a cast.created event (type: ${payload.type})`);
      return;
    }

    // Idempotency: same cast.created may be delivered multiple times — claim synchronously
    // before any await so concurrent duplicate requests cannot all reply.
    if (this.processedCastHashes.has(castData.hash)) {
      logger.info('Farcaster: skipping duplicate webhook for cast', {
        hash: castData.hash,
      });
      return;
    }
    this.processedCastHashes.add(castData.hash);
    if (this.processedCastHashes.size > FarcasterHandler.MAX_PROCESSED_HASHES) {
      const oldest = this.processedCastHashes.values().next().value;
      if (oldest !== undefined) this.processedCastHashes.delete(oldest);
    }

    // Log raw payload to Discord for debugging
    await debugLog('📨 Farcaster Webhook Received', [
      { name: 'Type', value: payload.type, inline: true },
      { name: 'Has Cast (data field)', value: payload.data ? 'yes' : 'no', inline: true },
      { name: 'Has Cast (cast field)', value: payload.cast ? 'yes' : 'no', inline: true },
      { name: 'Author', value: castData?.author?.username || 'unknown', inline: true },
      { name: 'Text', value: castData?.text || '(empty)', inline: false },
    ], 0x9b59b6);

    const cast = castData;

    const text = typeof cast.text === 'string' ? cast.text : '';
    const lowerText = text.toLowerCase();
    
    // NOTE: Neynar already filters webhooks by FID mention server-side.
    // The raw cast text in Farcaster does NOT always include "@username" literally —
    // mentions are stored in mentioned_profiles, not in the text field.
    // So we SKIP the text mention check and trust Neynar's filter.
    
    logger.info('Processing cast:', { 
      author: cast.author.username, 
      text,
      hash: cast.hash 
    });
    
    await debugInfo('Farcaster: Processing Cast', 
      `Author: @${cast.author.username}\nText: ${text}\nHash: ${cast.hash}`
    );
    
    // Check if this user has a pending deploy waiting for a wallet address
    const pending = this.pendingDeploys.get(cast.author.fid);
    const walletMatch = text.match(/0x[a-fA-F0-9]{40}/);
    if (pending && walletMatch) {
      await debugInfo('Farcaster: Wallet Reply Received',
        `@${cast.author.username} replied with wallet: ${walletMatch[0]}\nDeploying: ${pending.name} ($${pending.symbol})`
      );
      this.pendingDeploys.delete(cast.author.fid);
      await this.deployWithWallet(cast, pending, walletMatch[0]);
      return;
    }

    const aiMatch = text.match(/\/(?:ai|ask)\s+([\s\S]+)/i);
    if (aiMatch?.[1]?.trim()) {
      if (!isChatAgentConfigured()) {
        await this.neynar.publishCast(
          `@${cast.author.username} AI assistant is not configured on this server (LLM API key).`,
          cast.hash,
        );
        return;
      }
      await this.handleAiCast(cast, aiMatch[1].trim());
      return;
    }

    const walletCmd = parseWalletCommandMessage(text);
    if (walletCmd) {
      const identity = createIdentity('farcaster', String(cast.author.fid), cast.author.username);
      if (walletCmd.kind === 'balance') {
        const summary = await getWalletBalanceText(identity, walletCmd.tokenAddress);
        await this.neynar.publishCast(
          truncateForFarcaster(`@${cast.author.username} ${summary}`, 320),
          cast.hash,
        );
      } else if (walletCmd.kind === 'portfolio') {
        const summary = await getWalletPortfolioText(identity);
        await this.neynar.publishCast(
          truncateForFarcaster(`@${cast.author.username} ${summary}`, 320),
          cast.hash,
        );
      } else {
        const result = await executeWalletTransfer(identity, walletCmd);
        const reply = result.ok
          ? `@${cast.author.username} ✅ Transfer submitted.${result.isPendingUserOperation ? ' Waiting on final Base tx hash.' : ''}\n${result.basescanUrl}`
          : `@${cast.author.username} ❌ ${result.error}${result.hint ? `\n\n${result.hint}` : ''}`;
        await this.neynar.publishCast(truncateForFarcaster(reply, 320), cast.hash);
      }
      return;
    }

    const tradeIntent = parseTradeIntentMessage(text);
    if (tradeIntent) {
      if (tradeIntent.amount && isDelegatedServerSwapConfigured()) {
        const identity = createIdentity('farcaster', String(cast.author.fid), cast.author.username);
        const result = await executeDelegatedSwapFromChat(identity, tradeIntent);
        const reply = result.ok
          ? `@${cast.author.username} ✅ Submitted ${tradeIntent.side} ${tradeIntent.amount}.${result.isPendingUserOperation ? ' Waiting on final Base tx hash.' : ''}\n${result.basescanUrl}`
          : `@${cast.author.username} ❌ ${result.error}${result.hint ? `\n\n${result.hint}` : ''}`;
        await this.neynar.publishCast(truncateForFarcaster(reply, 320), cast.hash);
        return;
      }
      const url = launcherTradeDeepLink(tradeIntent.address, tradeIntent.side);
      const flip = tradeIntent.side === 'buy' ? 'sell' : 'buy';
      const flipUrl = launcherTradeDeepLink(tradeIntent.address, flip);
      const serverHint = isDelegatedServerSwapConfigured()
        ? `\n\nAfter you grant server access in the app, you can also *buy/sell* from Telegram or Discord with *Confirm on server* (same linked wallet).`
        : '';
      await this.neynar.publishCast(
        `@${cast.author.username} 💱 ${tradeIntent.side === 'buy' ? 'Buy' : 'Sell'} (Base · 0x)\n\n` +
          `${url}\n\n` +
          `${flip === 'buy' ? 'Buy' : 'Sell'} instead: ${flipUrl}\n\n` +
          `Sign in on the site for a live quote + gas estimate.` +
          serverHint,
        cast.hash,
      );
      return;
    }

    const wantsClaim = /\bclaim\b/.test(lowerText);
    const wantsDeploy = wantsDeployIntent(lowerText);
    if (wantsClaim && !wantsDeploy) {
      await this.handleClaimCast(cast);
      return;
    }

    // Parse command — use whole-word deploy/launch only (substring "launch" in "liquidlauncher" is NOT intent)
    if (wantsDeploy) {
      await this.handleDeploy(cast);
    } else if (lowerText.includes('help')) {
      await this.handleHelp(cast);
    } else {
      await debugInfo('Farcaster: No Command Found', 
        `Text did not include deploy/launch/help keywords.\nRaw: "${text}"`
      );
      // Default response
      await this.neynar.publishCast(
        `@${cast.author.username} 👋 *balance* / *portfolio* · */ai …* · *buy/sell 0x…* · *send 0.01 eth to 0x…* · *deploy*\n\nExample deploy: @liquidlauncher deploy MyToken` +
          (config.ethereum.deployEnabled
            ? ` — add *base* or *ethereum* for the chain.`
            : ''),
        cast.hash
      );
    }
  }

  private async handleAiCast(cast: CastData, prompt: string): Promise<void> {
    const identity = createIdentity('farcaster', String(cast.author.fid), cast.author.username);
    const mention = `@${cast.author.username}`;
    const prefix = `${mention} `;
    try {
      const { output } = await runChatAgentForIdentity({ identity, userMessage: prompt });
      const body = truncateForFarcaster(output, Math.max(80, 320 - prefix.length));
      await this.neynar.publishCast(`${prefix}${body}`, cast.hash);
    } catch (e: unknown) {
      logger.error('Farcaster /ai:', e);
      const err = e instanceof Error ? e.message : String(e);
      await this.neynar.publishCast(
        `${prefix}${truncateForFarcaster(`❌ ${err}`, Math.max(40, 320 - prefix.length))}`,
        cast.hash,
      );
    }
  }
  
  private async handleClaimCast(cast: CastData): Promise<void> {
    const text = cast.text;
    const author = cast.author;
    const hint = parseClaimTokenHint(text);
    if (!hint.tokenAddress && !hint.tokenSymbol) {
      await this.neynar.publishCast(
        `@${author.username} Usage: mention me with *claim* and the token *0x* contract or *$TICKER* — for a token you deployed from Farcaster with fees to your linked wallet.`,
        cast.hash
      );
      return;
    }

    const pw = await getOrCreateWalletForUser(
      'farcaster',
      String(author.fid),
      author.username,
    );
    if (!pw) {
      await this.neynar.publishCast(
        `@${author.username} Could not resolve your Privy fee wallet. Check server Privy configuration.`,
        cast.hash
      );
      return;
    }

    const result = await runSocialTradingFeesClaim({
      platform: 'farcaster',
      deployerId: String(author.fid),
      feeRecipientAddress: pw.address,
      tokenAddress: hint.tokenAddress,
      tokenSymbol: hint.tokenSymbol,
    });

    if (!result.ok) {
      await this.neynar.publishCast(`@${author.username} ${result.message}`, cast.hash);
      return;
    }

    await this.neynar.publishCast(
      `@${author.username} Claimed ${result.feeAmountHuman} ETH (WETH) trading fees.\n${result.basescanUrl}`,
      cast.hash
    );
  }

  private async handleDeploy(cast: CastData | undefined): Promise<void> {
    if (!cast) return;
    
    const text = cast.text;
    const author = cast.author;

    await debugInfo('Farcaster: Parsing Deploy Command', `Text: "${text}"\nAuthor: @${author.username}`);

    const lines = text.split(/\r?\n/);
    const firstLineRaw = lines[0]?.trim() ?? '';
    const firstLine = firstLineRaw.replace(/^@\w+\s+/i, '').trim();
    // Optional same-line description after NAME [SYM] [0x…]; additional paragraphs = following lines
    const deployMatch = firstLine.match(
      /^deploy\s+(\S+)(?:\s+(\S+))?(?:\s+(0x[a-fA-F0-9]{40}))?\s*(.*)$/i,
    );

    if (!deployMatch || !deployMatch[1]) {
      await debugInfo('Farcaster: No Deploy Match', `Could not parse deploy command from: "${text}"`);
      await this.neynar.publishCast(
        `@${author.username} Usage: @liquidlauncher deploy NAME [SYMBOL] [0x…]\n\n` +
        `Examples:\n` +
        `• @liquidlauncher deploy Test\n` +
        `• @liquidlauncher deploy AnalToken ANAL\n` +
        (config.ethereum.deployEnabled
          ? `• **Chain:** include *base* or *ethereum* in the cast (same line or body)\n`
          : '') +
        `• No Dev (meme): add *meme*, *no dev*, or *fees to no one* anywhere in the cast\n` +
        `• Optional fee override: @liquidlauncher deploy TestToken TEST 0x123...\n\n` +
        `Otherwise fee recipient defaults to your Privy-linked wallet, then verified/custody/profile addresses.`,
        cast.hash
      );
      return;
    }

    const name = deployMatch[1];
    const symbol = (deployMatch[2] || deployMatch[1]).toUpperCase().slice(0, 10);
    let inlineTail = (deployMatch[4] ?? '').trim();
    const multilineTail = lines.slice(1).join('\n\n').trim();
    let userCastDescription = inlineTail
      ? multilineTail
        ? `${inlineTail}\n\n${multilineTail}`
        : inlineTail
      : multilineTail;
    if (userCastDescription.length > 4000) {
      userCastDescription = `${userCastDescription.slice(0, 3999)}…`;
    }
    const memeFees = textIndicatesMemeNoDevFee(text);
    let feeRecipientLabel: string | undefined;
    let walletAddress: string | undefined = memeFees ? undefined : undefined;
    let farcasterPrivyUserId: string | undefined;
    /** Explicit `0x` in cast differs from deployer’s Privy wallet — third-party fee. */
    let farcasterExplicitThirdParty = false;
    if (memeFees) {
      const m = memeFeeWalletAndLabel();
      walletAddress = m.walletAddress;
      feeRecipientLabel = m.feeRecipientLabel;
    }

    if (isReservedTicker(symbol)) {
      await this.neynar.publishCast(
        `@${author.username} ❌ ${reservedTickerUserMessage(symbol)}`,
        cast.hash
      );
      return;
    }
    if (isReservedTokenName(name)) {
      await this.neynar.publishCast(
        `@${author.username} ❌ ${reservedNameUserMessage()}`,
        cast.hash
      );
      return;
    }

    if (await isTickerGloballyReserved(symbol)) {
      await this.neynar.publishCast(
        `@${author.username} ❌ ${await formatGlobalTickerCooldownMessage(symbol)}`,
        cast.hash
      );
      return;
    }

    let deployChain: DeployChain;
    if (config.ethereum.deployEnabled) {
      const explicit = inferExplicitDeployChainFromText(text);
      if (!explicit) {
        await this.neynar.publishCast(
          `@${author.username} Which chain should this token deploy on? Include the word **base** (Liquid on Base) or **ethereum** (Ethereum mainnet) in this cast or a reply — e.g. add \`base\` or \`ethereum\` on its own line.`,
          cast.hash,
        );
        return;
      }
      deployChain = explicit;
    } else {
      deployChain = resolveDeployChain({ messageText: text });
    }

    await debugLog('Farcaster: Deploy Parsed', [
      { name: 'Name', value: name, inline: true },
      { name: 'Symbol', value: symbol, inline: true },
      {
        name: 'Fee target',
        value: memeFees ? 'No Dev (meme · burn)' : walletAddress || '(fetching from profile)',
        inline: true,
      },
      { name: 'Author', value: `@${author.username}`, inline: true },
    ], 0x3498db);
    
    try {
      // Optional `deploy NAME SYM 0x…` in cast: same address as Privy = self; else third-party fee.
      if (!memeFees && deployMatch[3]) {
        const explicit = deployMatch[3] as `0x${string}`;
        const pw = await getOrCreateWalletForUser(
          'farcaster',
          String(author.fid),
          author.username,
        );
        if (pw) {
          if (getAddress(explicit) === getAddress(pw.address as `0x${string}`)) {
            walletAddress = pw.address;
            farcasterPrivyUserId = pw.privyUserId;
          } else {
            walletAddress = explicit;
            farcasterPrivyUserId = pw.privyUserId;
            farcasterExplicitThirdParty = true;
          }
        } else {
          walletAddress = explicit;
          farcasterExplicitThirdParty = true;
        }
      }

      // Fee wallet when not in cast text:
      // 1) Privy first (same embedded wallet as the web app for this Farcaster account)
      // 2) Verified / custody / Neynar profile addresses as fallbacks
      // 3) Legacy "reply with 0x" only when Privy is disabled (USE_PRIVY_WALLETS=false / no Privy keys)
      if (!walletAddress && !memeFees) {
        if (config.privy.enabled && config.features.usePrivyWallets) {
          const pw = await getOrCreateWalletForUser(
            'farcaster',
            String(author.fid),
            author.username
          );
          if (pw) {
            walletAddress = pw.address;
            farcasterPrivyUserId = pw.privyUserId;
            await debugInfo(
              'Farcaster: Fee wallet from Privy',
              `Using Farcaster-linked Privy wallet: ${walletAddress}`
            );
          }
        }

        if (!walletAddress) {
          const verifiedAddresses = author.verified_addresses?.eth_addresses ?? [];
          if (verifiedAddresses.length > 0) {
            walletAddress = verifiedAddresses[0];
            await debugInfo(
              'Farcaster: Wallet from Webhook',
              `Using verified address from cast payload: ${walletAddress}`
            );
          }
        }

        if (!walletAddress && author.custody_address) {
          walletAddress = author.custody_address;
          await debugInfo(
            'Farcaster: Wallet from Webhook (custody)',
            `Using custody address: ${walletAddress}`
          );
        }

        let fcUser: FarcasterUser | null = null;
        if (!walletAddress) {
          await debugInfo(
            'Farcaster: Fetching Wallet via API',
            `No address yet, looking up FID ${author.fid} (@${author.username})`
          );
          fcUser = await this.neynar.getUserByFid(author.fid);
          if (fcUser && fcUser.ethAddresses.length > 0) {
            walletAddress = fcUser.ethAddresses[0];
            await debugInfo('Farcaster: Wallet Found via API', `Using: ${walletAddress}`);
          }
        }

        if (!walletAddress) {
          if (config.privy.enabled && config.features.usePrivyWallets) {
            await this.neynar.publishCast(
              `@${author.username} ❌ Could not resolve a fee wallet (Privy provisioning failed and no Farcaster-linked address). Check launcher Privy configuration.`,
              cast.hash
            );
            return;
          }

          if (!fcUser) {
            fcUser = await this.neynar.getUserByFid(author.fid);
          }
          const xHint = fcUser?.xUsername ? ` (X: @${fcUser.xUsername})` : '';
          await debugError(
            'Farcaster: No Wallet Found',
            `No verified ETH address for @${author.username}${xHint} (FID: ${author.fid})`
          );

          const alreadyWaiting = this.pendingDeploys.get(author.fid);
          if (
            alreadyWaiting &&
            alreadyWaiting.name === name &&
            alreadyWaiting.symbol === symbol
          ) {
            await debugInfo(
              'Farcaster: Already asked for wallet (same deploy)',
              `Skipping second reply for ${name} ($${symbol})`
            );
            return;
          }
          const pendingImageUrl = await this.resolveTokenImageUrl(cast);
          this.pendingDeploys.set(author.fid, {
            name,
            symbol,
            authorFid: author.fid,
            authorUsername: author.username,
            replyToCastHash: cast.hash,
            imageUrl: pendingImageUrl,
            deployChain,
          });
          await this.neynar.publishCast(
            `@${author.username} What is your wallet address? Reply with your Base wallet (0x...) and I'll deploy ${name} ($${symbol}) for you! 🚀`,
            cast.hash
          );
          return;
        }
      }

      let feeWalletForThirdPartyHint: `0x${string}` | null = null;
      if (!memeFees && walletAddress) {
        try {
          feeWalletForThirdPartyHint = getAddress(walletAddress as `0x${string}`);
        } catch {
          feeWalletForThirdPartyHint = null;
        }
      }

      let feeToSelfDeploy = !memeFees && !farcasterExplicitThirdParty;
      let rateLimitForcedBurnFc = false;
      if (!memeFees && walletAddress) {
        const limited = await applyDeployRateLimitBurn({
          walletAddress: walletAddress!,
          feeRecipientLabel,
          feeToSelf: feeToSelfDeploy,
          platform: 'farcaster',
          deployerId: String(author.fid),
          privyUserId: farcasterPrivyUserId ?? null,
        });
        walletAddress = limited.walletAddress;
        if (limited.feeRecipientLabel) feeRecipientLabel = limited.feeRecipientLabel;
        feeToSelfDeploy = limited.feeToSelf;
        rateLimitForcedBurnFc = limited.rateLimitForcedBurn;
      }

      if (rateLimitForcedBurnFc) {
        await this.neynar.publishCast(
          `@${author.username} ⚠️ Deploy limit: ${DEPLOY_LIMIT_MEME_PROCEED_USER_NOTICE}`,
          cast.hash,
        );
      }

      const rollingHFc = deployRateLimitRollingHours();
      if (feeWalletForThirdPartyHint && rollingHFc > 0) {
        const thirdPartyRecentFc = await listThirdPartyFeeTokensForFeeRecipientRollingHours(
          feeWalletForThirdPartyHint,
          rollingHFc,
          6,
        );
        if (thirdPartyRecentFc.length > 0) {
          await this.neynar.publishCast(
            `@${author.username} ⚠️ Others launched for this fee wallet in the last ${rollingHFc}h (${thirdPartyRecentFc.length}).\n\n${thirdPartyRollingWindowDeployWarnUserMessage(rollingHFc)}`,
            cast.hash,
          );
        }
      }

      // Confirm deployment
      const feeLine = memeFees
        ? `Fee recipient: No Dev (meme) — burn address`
        : `Fee recipient: ${walletAddress!.slice(0, 6)}...${walletAddress!.slice(-4)}`;
      await this.neynar.publishCast(
        `@${author.username} 🚀 Deploying ${name} ($${symbol})...\n${feeLine}`,
        cast.hash,
      );
      
      await debugInfo('Farcaster: Deployment Started', 
        `Deploying ${name} ($${symbol}) for @${author.username}\nWallet: ${walletAddress}`
      );

      const originalCastUrl = `https://warpcast.com/${author.username}/${cast.hash}`;
      const castImageUrl = await this.resolveTokenImageUrl(cast);

      // Deploy with attribution + original cast link in on-chain metadata
      const baseDesc = `Deployed by Farcaster @${author.username} | ${originalCastUrl}`;
      const useMemeDescription = memeFees || rateLimitForcedBurnFc;
      let farcasterDescription = useMemeDescription
        ? `${baseDesc}\n\n${MEME_TOKEN_DESCRIPTION_TAGLINE}`
        : baseDesc;
      if (!useMemeDescription && userCastDescription) {
        farcasterDescription = `${baseDesc}\n\n${userCastDescription}`;
      }
      if (!memeFees && walletAddress) {
        const feeCd = await thirdPartyFeeRecipientCooldownErrorOrNull(walletAddress, {
          feeToSelf: feeToSelfDeploy,
          rateLimitForcedBurn: rateLimitForcedBurnFc,
          feeRecipientLabel,
        });
        if (feeCd) {
          await this.neynar.publishCast(`@${author.username} ❌ ${feeCd}`, cast.hash);
          return;
        }
      }
      const result = await this.deployer.deployToken({
        name,
        symbol,
        walletAddress: walletAddress!,
        devBuyAmount: config.deployBondWei,
        hookType: 'static',
        description: farcasterDescription,
        username: author.username,
        platform: 'farcaster',
        deployerId: String(author.fid),
        deployerLabel: `@${author.username}`,
        sourceUrl: originalCastUrl,
        ...(feeRecipientLabel ? { feeRecipientLabel } : {}),
        ...(castImageUrl ? { imageUrl: castImageUrl } : {}),
        feeToSelf: feeToSelfDeploy,
        ...(farcasterPrivyUserId ? { privyUserId: farcasterPrivyUserId } : {}),
        chain: deployChain,
      });
      
      const links = this.deployer.generateTokenLinks(result.tokenAddress, result.chain);

      await debugSuccess('Farcaster: Token Deployed!', 
        `${name} ($${symbol}) deployed by @${author.username}`,
        {
          'Token': result.tokenAddress,
          'Pool': result.poolId,
          'Tx': result.transactionHash,
          'Liquid': links.liquid,
          'Original Cast': originalCastUrl,
          ...(castImageUrl ? { Image: castImageUrl.slice(0, 200) } : {}),
        }
      );

      // Success response
      await this.neynar.publishCast(
        `@${author.username} 🎉 Token Deployed!\n\n` +
        `👤 User: @${author.username}\n` +
        `${name} ($${symbol})\n` +
        `Chain: ${result.chain === 'ethereum' ? 'Ethereum' : 'Base'}\n\n` +
        `Token: ${result.tokenAddress.slice(0, 10)}...\n` +
        `Pool: ${result.poolId.slice(0, 10)}...\n\n` +
        `💰 Fees: ${
          memeFees || rateLimitForcedBurnFc
            ? 'No Dev (meme) — burn address (unclaimable)'
            : `${walletAddress!.slice(0, 6)}...${walletAddress!.slice(-4)}`
        }\n\n` +
        `🌊 ${links.liquid}\n` +
        `💱 ${links.uniswapSwap}\n` +
        `📊 ${links.dexscreener}\n` +
        `🎯 ${links.launcherInAppSwap}\n` +
        `🚀 ${links.launcherApp}\n\n` +
        `🔗 Original request: ${originalCastUrl}`,
        cast.hash
      );
      
      // Post to X if enabled
      if (config.features.autoPostToX && config.x.enabled) {
        await this.postToX(name, symbol, result.tokenAddress, author.username);
      }
      
    } catch (error: any) {
      logger.error('Farcaster deployment failed:', error);
      await debugError('Farcaster: Deployment Failed', error.message, {
        'Author': `@${author.username}`,
        'Name': name,
        'Symbol': symbol,
        'Wallet': walletAddress || 'unknown',
      });
      await this.neynar.publishCast(
        `@${author.username} ❌ Deployment failed: ${error.message?.slice(0, 200)}`,
        cast.hash
      );
    }
  }
  
  private async deployWithWallet(
    cast: CastData,
    pending: PendingDeploy,
    walletAddress: string
  ): Promise<void> {
    const { name, symbol, replyToCastHash } = pending;
    const author = cast.author;

    await debugInfo('Farcaster: Deploying with supplied wallet',
      `${name} ($${symbol}) for @${author.username}\nWallet: ${walletAddress}`
    );

    const originalCastUrl = `https://warpcast.com/${author.username}/${replyToCastHash}`;
    const baseDesc = `Deployed by Farcaster @${author.username} | ${originalCastUrl}`;
    const withUser =
      pending.userDescription?.trim() && pending.userDescription.trim().length > 0
        ? `${baseDesc}\n\n${pending.userDescription.trim()}`
        : baseDesc;

    let feeWalletThirdPartyHintDw: `0x${string}` | null = null;
    try {
      feeWalletThirdPartyHintDw = getAddress(walletAddress as `0x${string}`);
    } catch {
      feeWalletThirdPartyHintDw = null;
    }

    const pw = await getOrCreateWalletForUser(
      'farcaster',
      String(author.fid),
      author.username,
    );
    const limited = await applyDeployRateLimitBurn({
      walletAddress,
      feeToSelf: true,
      platform: 'farcaster',
      deployerId: String(author.fid),
      privyUserId: pw?.privyUserId ?? null,
    });

    if (limited.rateLimitForcedBurn) {
      await this.neynar.publishCast(
        `@${author.username} ⚠️ Deploy limit: ${DEPLOY_LIMIT_MEME_PROCEED_USER_NOTICE}`,
        cast.hash,
      );
    }

    const rollingHDw = deployRateLimitRollingHours();
    if (feeWalletThirdPartyHintDw && rollingHDw > 0) {
      const thirdRecentDw = await listThirdPartyFeeTokensForFeeRecipientRollingHours(
        feeWalletThirdPartyHintDw,
        rollingHDw,
        6,
      );
      if (thirdRecentDw.length > 0) {
        await this.neynar.publishCast(
          `@${author.username} ⚠️ Others launched for this fee wallet in the last ${rollingHDw}h (${thirdRecentDw.length}).\n\n${thirdPartyRollingWindowDeployWarnUserMessage(rollingHDw)}`,
          cast.hash,
        );
      }
    }

    await this.neynar.publishCast(
      `@${author.username} 🚀 Deploying ${name} ($${symbol})...\nFee recipient: ${limited.walletAddress.slice(0, 6)}...${limited.walletAddress.slice(-4)}`,
      cast.hash,
    );

    try {
      const descriptionFinal = limited.rateLimitForcedBurn
        ? `${baseDesc}\n\n${MEME_TOKEN_DESCRIPTION_TAGLINE}`
        : withUser;
      const result = await this.deployer.deployToken({
        name,
        symbol,
        walletAddress: limited.walletAddress,
        devBuyAmount: config.deployBondWei,
        hookType: 'static',
        description: descriptionFinal,
        username: author.username,
        platform: 'farcaster',
        deployerId: String(author.fid),
        deployerLabel: `@${author.username}`,
        sourceUrl: originalCastUrl,
        ...(pending.imageUrl ? { imageUrl: pending.imageUrl } : {}),
        ...(limited.feeRecipientLabel ? { feeRecipientLabel: limited.feeRecipientLabel } : {}),
        feeToSelf: limited.feeToSelf,
        ...(pw?.privyUserId ? { privyUserId: pw.privyUserId } : {}),
        chain: pending.deployChain,
      });

      const links = this.deployer.generateTokenLinks(result.tokenAddress, result.chain);

      await debugSuccess('Farcaster: Token Deployed (wallet reply)!',
        `${name} ($${symbol}) by @${author.username}`,
        {
          'Token': result.tokenAddress,
          'Liquid': links.liquid,
          'Original Cast': originalCastUrl,
          ...(pending.imageUrl ? { Image: pending.imageUrl.slice(0, 200) } : {}),
        }
      );

      await this.neynar.publishCast(
        `@${author.username} 🎉 Token Deployed!\n\n` +
        `${name} ($${symbol})\n` +
        `Chain: ${result.chain === 'ethereum' ? 'Ethereum' : 'Base'}\n\n` +
        `Token: ${result.tokenAddress.slice(0, 10)}...\n\n` +
        `💰 Fees: ${limited.walletAddress.slice(0, 6)}...${limited.walletAddress.slice(-4)}\n\n` +
        `🌊 ${links.liquid}\n` +
        `💱 ${links.uniswapSwap}\n` +
        `📊 ${links.dexscreener}\n` +
        `🎯 ${links.launcherInAppSwap}\n` +
        `🚀 ${links.launcherApp}\n\n` +
        `🔗 Original request: ${originalCastUrl}`,
        cast.hash
      );
    } catch (error: any) {
      await debugError('Farcaster: Deployment Failed (wallet reply)', error.message, {
        'Author': `@${author.username}`,
        'Name': name,
        'Symbol': symbol,
        'Wallet': walletAddress,
      });
      await this.neynar.publishCast(
        `@${author.username} ❌ Deployment failed: ${error.message?.slice(0, 200)}`,
        cast.hash
      );
    }
  }

  private async handleHelp(cast: CastData | undefined): Promise<void> {
    if (!cast) return;
    
    await this.neynar.publishCast(
      `@${cast.author.username} 🤖 Liquid Launcher\n\n` +
      `Deploy tokens on Base with locked liquidity.\n\n` +
      `Commands:\n` +
      `• deploy NAME / deploy NAME SYMBOL — fee wallet from Privy (default), then your profile\n` +
      `• deploy NAME SYMBOL 0x… — optional explicit fee recipient; add text after for description\n` +
      `• More lines below the first line become the token description (paragraphs) on-chain\n` +
      `• claim 0x… or claim $TICKER — claim trading fees (same Farcaster account + fee wallet as deploy)\n` +
      `• Say *meme*, *no dev*, or *fees to no one* in the cast for No Dev (fees to burn — unclaimable)\n\n` +
      `Example:\n` +
      `@liquidlauncher deploy AnalToken ANAL`,
      cast.hash
    );
  }
  
  private async postToX(
    name: string, 
    symbol: string, 
    tokenAddress: string, 
    author: string
  ): Promise<void> {
    logger.info('Would post to X:', { name, symbol, author });
  }
}
