import { config } from '../config.js';
import { logger } from '../logger.js';
import TelegramBot from 'node-telegram-bot-api';
import { formatEther, getAddress } from 'viem';
import { LiquidDeployer, type TokenDeploymentParams } from '../deployer.js';
import { NeynarClient } from '../neynar.js';
import { parseOptionalHttpUrl } from '../lib/url.js';
import { parseClaimTokenHint } from '../parser.js';
import { runSocialTradingFeesClaim } from '../lib/socialFeeClaim.js';
import {
  isReservedTokenName,
  isReservedTicker,
  reservedNameUserMessage,
  reservedTickerUserMessage,
} from '../lib/reservedTokens.js';
import { debugError, debugSuccess, feedPost } from '../lib/discordDebug.js';
import { EmbedBuilder } from 'discord.js';
import {
  getWalletForUser,
  shouldAskForWallet,
} from '../lib/walletResolver.js';
import { resolveDeploySourceFromUrl } from '../lib/resolveDeploySource.js';
import { resolveFeeRecipientFromSocialPaste } from '../lib/webFeeRecipient.js';
import {
  DEPLOY_LIMIT_MEME_PROCEED_USER_NOTICE,
  isNoDevOrForcedBurnFeeLabel,
  MEME_FEE_RECIPIENT_LABEL,
  MEME_TOKEN_DESCRIPTION_TAGLINE,
  matchesMemeFeeRecipientToken,
  memeFeeWalletAndLabel,
  X_FORCED_DEAD_FEE_LABEL,
} from '../lib/memeFeeRecipient.js';
import {
  formatGlobalTickerCooldownMessage,
  isTickerGloballyReserved,
  thirdPartyFeeRecipientCooldownErrorOrNull,
} from '../lib/globalTickerCooldown.js';
import { applyDeployRateLimitBurn } from '../lib/deployRateLimitBurn.js';
import {
  listSelfFeeTokensForFeeRecipient,
  listThirdPartyFeeTokensForFeeRecipientRollingHours,
  type FeeRecipientToken,
} from '../lib/deploymentCatalog.js';
import {
  deployRateLimitRollingHours,
  thirdPartyRollingWindowDeployWarnUserMessage,
} from '../lib/selfFeeLimit.js';
import {
  launcherTradeDeepLink,
  parseTradeIntentMessage,
  type ParsedTradeIntent,
} from '../lib/tradeIntent.js';
import { createIdentity } from '../lib/privy.js';
import { executeDelegatedSwapFromChat, isDelegatedServerSwapConfigured } from '../lib/delegatedSwapExecution.js';
import { createPendingChatSwap, takePendingChatSwap } from '../lib/pendingChatSwaps.js';
import {
  isChatAgentConfigured,
  runChatAgentForIdentity,
  truncateForTelegram,
} from '../lib/chatAgentBridge.js';
import {
  executeWalletTransfer,
  getWalletBalanceText,
  getWalletPortfolioText,
  parseWalletCommandMessage,
  type ParsedWalletCommand,
} from '../lib/walletActions.js';
import {
  inferExplicitDeployChainFromText,
  resolveDeployChain,
  type DeployChain,
} from '../lib/deployChain.js';
import { formatTelegramUserError } from '../lib/telegramUserMessage.js';

/** Legacy Telegram `Markdown` — escape user/content so `_ * ` [ ]` do not break entities. */
function escapeTelegramMarkdownLegacy(text: string): string {
  return text
    .replace(/\\/g, '\\\\')
    .replace(/`/g, '\\`')
    .replace(/\[/g, '\\[')
    .replace(/\]/g, '\\]')
    .replace(/_/g, '\\_')
    .replace(/\*/g, '\\*');
}

function formatFeeRecipientTokenLineTelegram(t: FeeRecipientToken): string {
  return `• ${escapeTelegramMarkdownLegacy(`${t.tokenName} ($${t.tokenSymbol})`)}\n  \`${t.tokenAddress}\``;
}

interface TelegramSession {
  userId: string;
  step: 'name' | 'symbol' | 'description' | 'image' | 'chain' | 'fee' | 'confirm';
  data: Partial<TokenDeploymentParams> & {
    feeRecipientLabel?: string;
    /** Catalog: true only when fees go to deployer’s own wallet (not third party / burn). */
    feeToSelf?: boolean;
  };
  /** Set when fee wallet came from Privy (for success / claim link) */
  privyClaimUrl?: string;
  privyIsNew?: boolean;
  /** Privy DID for “me” fee path — stored for deployment catalog when fees stay on the user wallet. */
  privyUserIdForFee?: string;
}

function sessionKey(userId: string | number, chatId: string | number): string {
  return `${userId}:${chatId}`;
}

/**
 * Legacy Telegram `Markdown` treats `_` as formatting, which corrupts Privy URLs
 * (`app_id` → `appid`, `identity_hint` → `identityhint`). Escape underscores in URLs.
 */
function escapeMarkdownUrlForTelegram(url: string): string {
  return url.replace(/_/g, '\\_');
}

/** Shown after deploy: Liquid Protocol + optional Liquid Launcher login/export link. */
function telegramPostDeployFooter(): string {
  const liquidProtocol = escapeMarkdownUrlForTelegram('https://app.liquidprotocol.org');
  const parts: string[] = [
    '',
    `📈 [Liquid Protocol](${liquidProtocol}) — open the app to monitor the pool and fees.`,
  ];
  const web = config.launcherWebUrl;
  if (web) {
    parts.push(
      `🔐 [Liquid Launcher](${escapeMarkdownUrlForTelegram(
        web,
      )}) — sign in with Telegram to view your fee wallet and export your key. In-bot fee claiming is coming later.`,
    );
  }
  return parts.join('\n\n');
}

export class TelegramHandler {
  private bot: TelegramBot;
  private deployer: LiquidDeployer;
  private neynar: NeynarClient;
  private sessions: Map<string, TelegramSession> = new Map();
  
  constructor(deployer: LiquidDeployer, neynar: NeynarClient) {
    if (!config.telegram.botToken) {
      throw new Error('Telegram bot token not configured');
    }
    
    this.deployer = deployer;
    this.neynar = neynar;
    this.bot = new TelegramBot(config.telegram.botToken, { polling: true });
    
    this.setupHandlers();
    logger.info('Telegram bot initialized');
  }

  /** Fallback token image when user did not provide a URL or photo. */
  private async resolveTelegramProfileImageUrl(
    from: TelegramBot.User
  ): Promise<string | undefined> {
    try {
      const res = await this.bot.getUserProfilePhotos(from.id, { limit: 1 });
      if (!res.total_count || !res.photos[0]?.length) return undefined;
      const sizes = res.photos[0];
      const best = sizes[sizes.length - 1];
      return await this.bot.getFileLink(best.file_id);
    } catch {
      return undefined;
    }
  }
  
  private setupHandlers(): void {
    this.bot.onText(/\/start/, this.handleStart.bind(this));
    this.bot.onText(/\/deploy/, this.handleDeploy.bind(this));
    this.bot.onText(/\/launch(?:\s+(.+))?/, this.handleQuickLaunch.bind(this));
    this.bot.onText(/\/help/, this.handleHelp.bind(this));
    this.bot.onText(/\/claim(?:\s+(.+))?/, this.handleClaim.bind(this));
    this.bot.onText(/\/cancel/, this.handleCancel.bind(this));
    this.bot.on('message', this.handleMessage.bind(this));
    this.bot.on('callback_query', this.handleCallback.bind(this));
    
    // Handle polling errors gracefully (don't crash on 409 conflicts)
    this.bot.on('polling_error', (error: any) => {
      if (error.code === 'ETELEGRAM' && error.message?.includes('409')) {
        logger.warn('Telegram 409 conflict - another instance may be running. Continuing...');
        // Don't throw - let other handlers continue
      } else {
        logger.error('Telegram polling error:', error.message);
      }
    });
  }
  
  private wizardTotal(): number {
    return config.ethereum.deployEnabled ? 6 : 5;
  }

  private async handleStart(msg: TelegramBot.Message): Promise<void> {
    const feeLine = shouldAskForWallet()
      ? '• Fee wallet: your Base 0x address'
      : '• Who receives fees: *you*, a 0x address, or a profile link (Warpcast, X, GitHub, t.me, Discord — same as the website). *Not available on X.*';

    const welcome = `
🚀 *Liquid Launcher*

Deploy tokens on Base with Uniswap V4 pools.

*Commands:*
/deploy - Full deployment wizard
${shouldAskForWallet() ? '/launch NAME SYMBOL WALLET - Quick deploy' : '/launch NAME SYMBOL - Quick deploy (fees to you)\n/launch + https URL — import from X / GitHub / Warpcast / t.me / Discord (same as website). If both chains are enabled, include *base* or *ethereum* in the same message.\n/launch NAME SYMBOL + link — send fees to a profile URL'}
/claim 0x… or /claim $TICKER — claim trading fees for a token you deployed here
/help - Show help

*Example:*
\`${shouldAskForWallet() ? '/launch ANAL AnalToken 0x123...' : '/launch ANAL AnalToken'}\`

*Wizard:*
/deploy will ask for:
• Token name & symbol
• Description (optional)
• Token image: paste a URL or send a photo (optional)
${config.ethereum.deployEnabled ? '• **Which chain** — Base (Liquid) or Ethereum\n' : ''}${feeLine}

Deployment uses a small bond from the launcher wallet (not your fee wallet).
    `;
    
    await this.bot.sendMessage(msg.chat.id, welcome, { parse_mode: 'Markdown' });
  }
  
  private async handleHelp(msg: TelegramBot.Message): Promise<void> {
    const quickLine = shouldAskForWallet()
      ? '`/launch TOKENNAME TICKER 0xWALLET`'
      : '`/launch TOKENNAME TICKER` (Privy) or `/launch TOKENNAME TICKER 0xWALLET`\n`/launch` + paste an X/GitHub/Warpcast link + *base* or *ethereum* when both chains are on — one-link import';

    const help = `
🤖 *Liquid Launcher Help*

*Quick Launch:*
${quickLine}

*Full Wizard:*
\`/deploy\` - Step-by-step setup

*After Deployment:*
You'll receive:
• Token contract address
• Pool ID
• Links to BaseScan, DexScreener

*Trade (opens Liquid Launcher in your browser):*
\`buy 0x…\` — buy with ETH (0x)
\`sell 0x…\` — sell for ETH
(\`buyu\` works if you typo \`buy\`)

*Fee Recipient:*
${shouldAskForWallet() ? 'Paste your Base 0x that should receive trading fees.' : 'With Privy: you can keep fees on your linked Telegram wallet, or paste a 0x / social link (Farcaster, X, GitHub, t.me, Discord profile) — same as the website. X does not allow routing fees to third parties.'}
    `;
    
    await this.bot.sendMessage(msg.chat.id, help, { parse_mode: 'Markdown' });
  }

  private async handleClaim(msg: TelegramBot.Message): Promise<void> {
    const from = msg.from;
    if (!from) return;
    const chatId = msg.chat.id;
    const text = msg.text ?? '';
    const hint = parseClaimTokenHint(text);
    if (!hint.tokenAddress && !hint.tokenSymbol) {
      await this.bot.sendMessage(
        chatId,
        'Usage: `/claim 0x…` (token contract) or `/claim $TICKER` — for a token you deployed from this Telegram account with fees to your linked wallet.',
        { parse_mode: 'Markdown' },
      );
      return;
    }

    const pw = await getWalletForUser(
      'telegram',
      String(from.id),
      from.username ? `@${from.username}` : undefined,
    );
    if (!pw) {
      await this.bot.sendMessage(
        chatId,
        'Could not resolve your Privy wallet. Set `PRIVY_APP_ID` and ensure `USE_PRIVY_WALLETS` is enabled.',
      );
      return;
    }

    const result = await runSocialTradingFeesClaim({
      platform: 'telegram',
      deployerId: String(from.id),
      feeRecipientAddress: pw.address,
      tokenAddress: hint.tokenAddress,
      tokenSymbol: hint.tokenSymbol,
    });

    if (!result.ok) {
      await this.bot.sendMessage(chatId, result.message);
      return;
    }

    await this.bot.sendMessage(
      chatId,
      `Claimed *${result.feeAmountHuman}* ETH (WETH) trading fees.\n${result.basescanUrl}`,
      { parse_mode: 'Markdown' },
    );
  }
  
  /** `buy 0x…` / `buyu 0x…` / `sell 0x…` — deep link to web 0x swap (user signs in; pays gas). */
  private async replyTradeIntent(msg: TelegramBot.Message, intent: ParsedTradeIntent): Promise<void> {
    if (intent.amount && msg.from && isDelegatedServerSwapConfigured()) {
      const identity = createIdentity('telegram', String(msg.from.id), msg.from.username);
      await this.bot.sendChatAction(msg.chat.id, 'typing');
      const result = await executeDelegatedSwapFromChat(identity, intent);
      if (result.ok) {
        const pendingLine = result.isPendingUserOperation
          ? '\nStill waiting for the final Base tx hash from Privy smart-wallet bundling.'
          : '';
        await this.bot.sendMessage(
          msg.chat.id,
          `✅ Submitted ${intent.side} for ${intent.amount}.${pendingLine}\n${result.basescanUrl}\n\`${result.transactionHash}\``,
          { parse_mode: 'Markdown' },
        );
      } else {
        const parts = [`❌ ${result.error}`];
        if (result.hint) parts.push('', result.hint);
        await this.bot.sendMessage(msg.chat.id, parts.join('\n').slice(0, 3900));
      }
      return;
    }

    const url = launcherTradeDeepLink(intent.address, intent.side);
    const flip: 'buy' | 'sell' = intent.side === 'buy' ? 'sell' : 'buy';
    const flipUrl = launcherTradeDeepLink(intent.address, flip);
    const title = intent.side === 'buy' ? 'Buy with ETH' : 'Sell for ETH';
    const lines = [
      `💱 *${title}* (Base · 0x)`,
      '',
      `Token: \`${intent.address}\``,
      ...(intent.amount ? ['', `Amount: *${intent.amount}* ${intent.side === 'buy' ? 'ETH' : 'token units'}`] : []),
      '',
      `[Open Liquid Launcher](${escapeMarkdownUrlForTelegram(url)})`,
      '',
      `_${flip === 'buy' ? 'Buy' : 'Sell'} instead:_ [tap here](${escapeMarkdownUrlForTelegram(flipUrl)})`,
      '',
      '_Exact amounts & fees show after you sign in on the site. You pay Base network gas (ETH) — the launcher does not cover gas by default._',
    ];
    if (isDelegatedServerSwapConfigured() && msg.from) {
      lines.push(
        '',
        '_If you granted **server access** in the web app, you can tap **Confirm on server** below (same linked wallet)._',
      );
    }
    let reply_markup: TelegramBot.InlineKeyboardMarkup | undefined;
    if (isDelegatedServerSwapConfigured() && msg.from) {
      const swapId = createPendingChatSwap({
        kind: 'telegram',
        telegramUserId: String(msg.from.id),
        username: msg.from.username,
        intent,
      });
      reply_markup = {
        inline_keyboard: [
          [{ text: '✅ Confirm on server', callback_data: `swc:${swapId}` }],
          [{ text: 'Open in browser', url }],
        ],
      };
    }
    await this.bot.sendMessage(msg.chat.id, lines.join('\n'), {
      parse_mode: 'Markdown',
      ...(reply_markup ? { reply_markup } : {}),
    });
  }

  /** `/ai` / `/ask` — LangChain agent (same identity as Privy-linked Telegram user). */
  private async handleAiCommand(msg: TelegramBot.Message, prompt: string): Promise<void> {
    const uid = msg.from!.id.toString();
    const identity = createIdentity('telegram', uid, msg.from?.username);
    try {
      await this.bot.sendChatAction(msg.chat.id, 'typing');
      const { output } = await runChatAgentForIdentity({ identity, userMessage: prompt });
      await this.bot.sendMessage(msg.chat.id, truncateForTelegram(output, 4096));
    } catch (e: unknown) {
      const err = e instanceof Error ? e.message : String(e);
      logger.error('Telegram /ai:', e);
      await this.bot.sendMessage(msg.chat.id, `❌ ${err.slice(0, 500)}`);
    }
  }

  /** `balance [0xTOKEN]` and `transfer|send eth|0xTOKEN <amount> <0xRECIPIENT>` */
  private async handleWalletCommand(
    msg: TelegramBot.Message,
    command: ParsedWalletCommand,
  ): Promise<void> {
    const identity = createIdentity('telegram', String(msg.from!.id), msg.from?.username);
    if (command.kind === 'balance') {
      await this.bot.sendChatAction(msg.chat.id, 'typing');
      const text = await getWalletBalanceText(identity, command.tokenAddress);
      await this.bot.sendMessage(msg.chat.id, truncateForTelegram(text, 4096));
      return;
    }
    if (command.kind === 'portfolio') {
      await this.bot.sendChatAction(msg.chat.id, 'typing');
      const text = await getWalletPortfolioText(identity);
      await this.bot.sendMessage(msg.chat.id, truncateForTelegram(text, 4096));
      return;
    }

    await this.bot.sendChatAction(msg.chat.id, 'typing');
    const result = await executeWalletTransfer(identity, command);
    if (result.ok) {
      const pendingLine = result.isPendingUserOperation
        ? '\nStill waiting for the final Base tx hash from Privy smart-wallet bundling.'
        : '';
      await this.bot.sendMessage(
        msg.chat.id,
        `✅ Transfer submitted.${pendingLine}\n${result.basescanUrl}\n\`${result.transactionHash}\``,
        { parse_mode: 'Markdown' },
      );
      return;
    }
    const parts = [`❌ ${result.error}`];
    if (result.hint) parts.push('', result.hint);
    await this.bot.sendMessage(msg.chat.id, parts.join('\n').slice(0, 3900));
  }

  private async handleDelegatedSwapCallback(query: TelegramBot.CallbackQuery): Promise<void> {
    const data = query.data;
    if (!data?.startsWith('swc:')) return;
    const id = data.slice(4);
    const pending = takePendingChatSwap(id);
    if (!pending || pending.kind !== 'telegram') {
      await this.bot.answerCallbackQuery(query.id, {
        text: 'This swap link expired. Send buy/sell again.',
      });
      return;
    }
    if (pending.telegramUserId !== query.from.id.toString()) {
      await this.bot.answerCallbackQuery(query.id, { text: 'Not your swap request.' });
      return;
    }
    await this.bot.answerCallbackQuery(query.id, { text: 'Submitting on Base…' });
    const identity = createIdentity('telegram', pending.telegramUserId, pending.username);
    const result = await executeDelegatedSwapFromChat(identity, pending.intent);
    const chatId = query.message?.chat.id;
    if (!chatId) return;
    if (result.ok) {
      await this.bot.sendMessage(
        chatId,
        `✅ Submitted: [BaseScan](${escapeMarkdownUrlForTelegram(result.basescanUrl)})\n\`${result.transactionHash}\``,
        { parse_mode: 'Markdown' },
      );
    } else {
      // Plain text — long viem errors contain `_` and hex that break Telegram Markdown.
      const parts = [`❌ ${result.error}`];
      if (result.hint) parts.push('', result.hint);
      await this.bot.sendMessage(chatId, parts.join('\n').slice(0, 3900));
    }
  }

  private async handleCancel(msg: TelegramBot.Message): Promise<void> {
    const userId = msg.from?.id.toString();
    if (!userId) return;
    const key = sessionKey(userId, msg.chat.id);
    if (this.sessions.has(key)) {
      this.sessions.delete(key);
      await this.bot.sendMessage(msg.chat.id, '❌ Deployment cancelled.');
    } else {
      await this.bot.sendMessage(msg.chat.id, 'No active deployment to cancel.');
    }
  }

  private async handleDeploy(msg: TelegramBot.Message): Promise<void> {
    const userId = msg.from?.id.toString();
    if (!userId) return;
    const key = sessionKey(userId, msg.chat.id);

    // Start wizard
    this.sessions.set(key, {
      userId,
      step: 'name',
      data: {},
    });
    
    await this.bot.sendMessage(
      msg.chat.id,
      `🚀 *Token Deployment Wizard*\n\nStep 1/${this.wizardTotal()}: What is the token name? (2-32 characters)`,
      { parse_mode: 'Markdown' }
    );
  }

  /** After image step: ask who receives fees (0x, me, or social paste) or legacy 0x-only mode. */
  private async promptWalletOrPrivySummary(
    msg: TelegramBot.Message,
    session: TelegramSession,
    key: string
  ): Promise<void> {
    const chatId = msg.chat.id;

    if (shouldAskForWallet()) {
      session.step = 'fee';
      const n = this.wizardTotal();
      await this.bot.sendMessage(
        chatId,
        `Step ${n}/${n}: Wallet address for fee recipient?\n\n` +
          'This wallet receives trading fees. Use your Base address (0x...).'
      );
      return;
    }

    session.step = 'fee';
    const n = this.wizardTotal();
    await this.bot.sendMessage(
      chatId,
      `Step ${n}/${n}: Who should receive trading fees?\n\n` +
        '• Send *me* — your linked Telegram wallet (Privy)\n' +
        '• Send *meme*, *meme?*, or *no dev* — No Dev (fees to burn, unclaimable)\n' +
        '• Or paste a Base *0x…* address\n' +
        '• Or paste a profile link: Warpcast, X, GitHub, *t.me/username*, or *discord.com/users/id* (same as the website).\n\n' +
        '_On X, fees can only go to the poster — use Telegram, Discord, or the site to assign fees to someone else._',
      { parse_mode: 'Markdown' },
    );
    return;
  }

  /**
   * After the image step: when Ethereum deploys are enabled, ask Base vs Ethereum; otherwise use the server default and go to fees.
   */
  private async beginChainSelectionOrFeeStep(
    msg: TelegramBot.Message,
    session: TelegramSession,
    _key: string,
  ): Promise<void> {
    const chatId = msg.chat.id;
    if (config.ethereum.deployEnabled) {
      session.step = 'chain';
      const n = this.wizardTotal();
      await this.bot.sendMessage(
        chatId,
        `Step 5/${n}: Which chain?\n\n` +
          '• *Base* — Liquid on Base\n' +
          '• *Ethereum* — Ethereum mainnet\n\n' +
          'Reply *base* or *ethereum*, or use the buttons below.',
        {
          parse_mode: 'Markdown',
          reply_markup: {
            inline_keyboard: [
              [
                { text: 'Base (Liquid)', callback_data: 'twc_base' },
                { text: 'Ethereum', callback_data: 'twc_eth' },
              ],
            ],
          },
        },
      );
      return;
    }
    session.data.chain = config.deployDefaultChain;
    await this.promptWalletOrPrivySummary(msg, session, _key);
  }

  private async handleMessage(msg: TelegramBot.Message): Promise<void> {
    const text = msg.text?.trim() || '';
    const userId = msg.from?.id.toString();
    if (!userId) return;

    const aiMatch = text.match(/^\/(?:ai|ask)(?:@\w+)?\s+([\s\S]+)/i);
    if (aiMatch?.[1]?.trim()) {
      if (!isChatAgentConfigured()) {
        await this.bot.sendMessage(
          msg.chat.id,
          'AI assistant is not configured on this server (set OPENAI_API_KEY or LANGCHAIN_LLM_API_KEY).',
        );
        return;
      }
      await this.handleAiCommand(msg, aiMatch[1].trim());
      return;
    }

    const walletCmd = parseWalletCommandMessage(text);
    if (walletCmd) {
      await this.handleWalletCommand(msg, walletCmd);
      return;
    }

    if (text && !text.startsWith('/')) {
      const trade = parseTradeIntentMessage(text);
      if (trade) {
        await this.replyTradeIntent(msg, trade);
        return;
      }
    }
    const key = sessionKey(userId, msg.chat.id);
    
    const session = this.sessions.get(key);
    if (!session) return;

    // Step 4: accept uploaded photo or image file (URL still handled in switch)
    if (session.step === 'image') {
      const photo = msg.photo;
      const doc = msg.document;
      if (photo?.length) {
        try {
          const fileId = photo[photo.length - 1].file_id;
          const imageUrl = await this.bot.getFileLink(fileId);
          session.data.imageUrl = imageUrl;
          await this.beginChainSelectionOrFeeStep(msg, session, key);
        } catch (e: any) {
          await this.bot.sendMessage(
            msg.chat.id,
            '❌ Could not load that image. Paste an https image link or try another photo.'
          );
        }
        return;
      }
      if (doc?.mime_type?.startsWith('image/') && doc.file_id) {
        try {
          const imageUrl = await this.bot.getFileLink(doc.file_id);
          session.data.imageUrl = imageUrl;
          await this.beginChainSelectionOrFeeStep(msg, session, key);
        } catch (e: any) {
          await this.bot.sendMessage(
            msg.chat.id,
            '❌ Could not load that file. Paste an https image link or send a photo.'
          );
        }
        return;
      }
    }
    
    // Skip commands (slash handlers run separately)
    if (msg.text?.startsWith('/')) return;

    try {
      switch (session.step) {
        case 'name':
          if (text.length < 2 || text.length > 32) {
            await this.bot.sendMessage(msg.chat.id, '❌ Name must be 2-32 characters. Try again:');
            return;
          }
          if (isReservedTokenName(text)) {
            await this.bot.sendMessage(msg.chat.id, `❌ ${reservedNameUserMessage()}`);
            return;
          }
          session.data.name = text;
          session.step = 'symbol';
          await this.bot.sendMessage(
            msg.chat.id,
            `Step 2/${this.wizardTotal()}: What is the token symbol? (2-10 characters, e.g., TEST)`
          );
          break;
          
        case 'symbol':
          if (text.length < 2 || text.length > 10) {
            await this.bot.sendMessage(msg.chat.id, '❌ Symbol must be 2-10 characters. Try again:');
            return;
          }
          if (isReservedTicker(text)) {
            await this.bot.sendMessage(
              msg.chat.id,
              `❌ ${reservedTickerUserMessage(text)} Try a different symbol:`,
            );
            return;
          }
          const symUpper = text.toUpperCase();
          if (await isTickerGloballyReserved(symUpper)) {
            await this.bot.sendMessage(
              msg.chat.id,
              `❌ ${await formatGlobalTickerCooldownMessage(symUpper)}`,
            );
            return;
          }
          session.data.symbol = symUpper;
          session.step = 'description';
          await this.bot.sendMessage(
            msg.chat.id,
            `Step 3/${this.wizardTotal()}: Short description? (optional — to skip, reply with skip)`
          );
          break;
          
        case 'description': {
          const isSkip = text.toLowerCase() === 'skip';
          // Store undefined when skipped so the platform attribution fallback kicks in
          session.data.description = isSkip ? undefined : text;
          session.step = 'image';
          await this.bot.sendMessage(
            msg.chat.id,
            `Step 4/${this.wizardTotal()}: Token image — paste an https:// image link or send a photo. If you want to skip, reply with skip.`
          );
          break;
        }

        case 'image': {
          const skip = text.toLowerCase() === 'skip';
          const url = skip ? undefined : parseOptionalHttpUrl(text);
          if (!skip && !url) {
            await this.bot.sendMessage(
              msg.chat.id,
              '❌ Paste a valid https image link, send a photo, or reply with skip.'
            );
            return;
          }
          session.data.imageUrl = url;
          await this.beginChainSelectionOrFeeStep(msg, session, key);
          break;
        }

        case 'chain': {
          const lc = text.toLowerCase();
          if (lc === 'base' || lc === 'ethereum' || lc === 'eth') {
            session.data.chain = lc === 'ethereum' || lc === 'eth' ? 'ethereum' : 'base';
            await this.promptWalletOrPrivySummary(msg, session, key);
          } else {
            await this.bot.sendMessage(
              msg.chat.id,
              '❌ Reply with *base* or *ethereum*, or tap the buttons in the message above.',
              { parse_mode: 'Markdown' },
            );
          }
          break;
        }

        case 'fee': {
          if (isReservedTicker(session.data.symbol || '')) {
            await this.bot.sendMessage(
              msg.chat.id,
              `❌ ${reservedTickerUserMessage(session.data.symbol || '')} Use /cancel and try a different symbol.`,
            );
            return;
          }

          const myUserId = msg.from?.id.toString();
          const myUsername = msg.from?.username || msg.from?.first_name || 'Unknown';

          if (shouldAskForWallet()) {
            if (matchesMemeFeeRecipientToken(text)) {
              const m = memeFeeWalletAndLabel();
              session.data.walletAddress = m.walletAddress;
              session.data.feeRecipientLabel = m.feeRecipientLabel;
              session.data.feeToSelf = false;
              session.privyClaimUrl = undefined;
              session.privyIsNew = undefined;
              session.privyUserIdForFee = undefined;
            } else if (!text.match(/^0x[a-fA-F0-9]{40}$/)) {
              await this.bot.sendMessage(
                msg.chat.id,
                '❌ Send *meme* / *no dev*, or a valid 0x fee address. Try again:',
                { parse_mode: 'Markdown' },
              );
              return;
            } else {
              session.data.walletAddress = text;
              session.data.feeRecipientLabel = `Wallet ${text.slice(0, 6)}…${text.slice(-4)}`;
              session.data.feeToSelf = true;
              session.privyClaimUrl = undefined;
              session.privyIsNew = undefined;
              session.privyUserIdForFee = undefined;
            }
          } else {
            const t = text.trim();
            const lower = t.toLowerCase();
            if (matchesMemeFeeRecipientToken(t)) {
              const m = memeFeeWalletAndLabel();
              session.data.walletAddress = m.walletAddress;
              session.data.feeRecipientLabel = m.feeRecipientLabel;
              session.data.feeToSelf = false;
              session.privyClaimUrl = undefined;
              session.privyIsNew = undefined;
              session.privyUserIdForFee = undefined;
            } else if (lower === 'me' || lower === 'self') {
              if (!myUserId) {
                await this.bot.sendMessage(msg.chat.id, '❌ Could not read your Telegram user id.');
                return;
              }
              await this.bot.sendMessage(msg.chat.id, '⏳ Linking your fee wallet…');
              const resolved = await getWalletForUser('telegram', myUserId, msg.from?.username || msg.from?.first_name);
              if (!resolved?.address) {
                await this.bot.sendMessage(
                  msg.chat.id,
                  '❌ Could not create or load your linked Privy wallet. Check PRIVY_APP_ID / PRIVY_APP_SECRET and Telegram in Privy.',
                );
                return;
              }
              session.data.walletAddress = resolved.address;
              session.data.feeRecipientLabel = 'Your Telegram wallet';
              session.data.feeToSelf = true;
              session.privyClaimUrl = resolved.claimUrl;
              session.privyIsNew = resolved.isNew;
              session.privyUserIdForFee = resolved.privyUserId;
            } else if (t.match(/^0x[a-fA-F0-9]{40}$/)) {
              if (!myUserId) {
                await this.bot.sendMessage(msg.chat.id, '❌ Could not read your Telegram user id.');
                return;
              }
              session.data.walletAddress = t;
              session.data.feeRecipientLabel = `Wallet ${t.slice(0, 6)}…${t.slice(-4)}`;
              session.data.feeToSelf = false;
              session.privyClaimUrl = undefined;
              session.privyIsNew = undefined;
              session.privyUserIdForFee = undefined;
            } else {
              await this.bot.sendMessage(msg.chat.id, '⏳ Resolving fee recipient…');
              try {
                if (!myUserId) {
                  await this.bot.sendMessage(msg.chat.id, '❌ Could not read your Telegram user id.');
                  return;
                }
                const resolved = await resolveFeeRecipientFromSocialPaste(this.neynar, t);
                session.data.walletAddress = resolved.walletAddress;
                session.data.feeRecipientLabel = resolved.feeRecipientLabel;
                session.data.feeToSelf = false;
                session.privyClaimUrl = undefined;
                session.privyIsNew = undefined;
                session.privyUserIdForFee = undefined;
              } catch (e: any) {
                const raw = e?.message || 'Could not resolve fee recipient.';
                await this.bot.sendMessage(
                  msg.chat.id,
                  `❌ ${escapeTelegramMarkdownLegacy(String(raw))}\n\nSend *me*, *meme*, a 0x address, or a profile link.`,
                  { parse_mode: 'Markdown' },
                );
                return;
              }
            }
          }

          session.data.devBuyAmount = config.deployBondWei;
          session.data.platform = 'telegram';
          session.data.username = myUsername;
          session.step = 'confirm';

          const md = escapeTelegramMarkdownLegacy;
          const feeLabel = session.data.feeRecipientLabel
            ? `\n_Fee target:_ ${md(session.data.feeRecipientLabel)}`
            : '';
          const claimUrlMd = session.privyClaimUrl
            ? escapeMarkdownUrlForTelegram(session.privyClaimUrl)
            : '';
          const feeExtra =
            session.privyClaimUrl && session.privyIsNew
              ? `\n_BaseScan (fee wallet):_ ${claimUrlMd}`
              : session.privyClaimUrl
                ? `\n_BaseScan:_ ${claimUrlMd}`
                : '';

          const feeWallet = session.data.walletAddress;
          const rollingH = deployRateLimitRollingHours();
          const selfFeeTokens = feeWallet ? await listSelfFeeTokensForFeeRecipient(feeWallet, 8) : [];
          const thirdPartyRecent =
            feeWallet && rollingH > 0
              ? await listThirdPartyFeeTokensForFeeRecipientRollingHours(feeWallet, rollingH, 8)
              : [];

          const priorLines: string[] = [];
          if (selfFeeTokens.length > 0) {
            priorLines.push(
              `\n\n⚠️ *Tokens this wallet already launched* (${selfFeeTokens.length}):\n${selfFeeTokens.map(formatFeeRecipientTokenLineTelegram).join('\n')}`,
            );
          }
          if (thirdPartyRecent.length > 0) {
            priorLines.push(
              `\n\n⚠️ *Tokens others launched for this wallet* (last ${rollingH}h, ${thirdPartyRecent.length}):\n${thirdPartyRecent.map(formatFeeRecipientTokenLineTelegram).join('\n')}`,
            );
            priorLines.push(
              `\n\n🚨 ${escapeTelegramMarkdownLegacy(thirdPartyRollingWindowDeployWarnUserMessage(rollingH))}`,
            );
          }
          const priorTokensNote = priorLines.join('');

          let deployLimitNote = '';
          if (myUserId && session.data.walletAddress) {
            const deployerPwPrev = await getWalletForUser(
              'telegram',
              myUserId,
              myUsername,
            );
            const feeSelfPrev =
              session.data.feeToSelf === true &&
              !isNoDevOrForcedBurnFeeLabel(session.data.feeRecipientLabel);
            const catalogPrivyPrev = deployerPwPrev?.privyUserId ?? session.privyUserIdForFee;
            const limitPrev = await applyDeployRateLimitBurn({
              walletAddress: session.data.walletAddress,
              feeRecipientLabel: session.data.feeRecipientLabel,
              feeToSelf: feeSelfPrev,
              platform: 'telegram',
              deployerId: myUserId,
              privyUserId: catalogPrivyPrev ?? null,
            });
            if (limitPrev.rateLimitForcedBurn) {
              deployLimitNote =
                '\n\n🚨 *Deploy limit reached.*\n' +
                escapeTelegramMarkdownLegacy(DEPLOY_LIMIT_MEME_PROCEED_USER_NOTICE);
            }
          }

          const chainLine =
            config.ethereum.deployEnabled && session.data.chain
              ? `\nChain: *${session.data.chain === 'ethereum' ? 'Ethereum' : 'Base'}*`
              : '';

          const summary = `
📋 *Deployment Summary*

👤 User: *${md(session.data.username || '')}*

Name: *${md(session.data.name || '')}*
Symbol: *${md(session.data.symbol || '')}*
Description: ${session.data.description ? md(session.data.description) : 'None'}
Image: ${session.data.imageUrl ? md(session.data.imageUrl) : 'None'}${chainLine}
Fee wallet: \`${session.data.walletAddress}\`${feeLabel}${feeExtra}${priorTokensNote}${deployLimitNote}

Deploy bond: *${formatEther(config.deployBondWei)} ETH* (paid by launcher — not your fee wallet)

Ready to deploy?
          `;

          await this.bot.sendMessage(msg.chat.id, summary, {
            parse_mode: 'Markdown',
            reply_markup: {
              inline_keyboard: [
                [
                  { text: '✅ Deploy', callback_data: 'confirm_deploy' },
                  { text: '❌ Cancel', callback_data: 'cancel_deploy' },
                ],
              ],
            },
          });
          break;
        }
      }
    } catch (error: any) {
      logger.error('Telegram wizard error:', error);
      await this.bot.sendMessage(
        msg.chat.id,
        formatTelegramUserError(error.message, '❌ Error: '),
      );
      this.sessions.delete(key);
    }
  }
  
  private async handleCallback(query: TelegramBot.CallbackQuery): Promise<void> {
    const data = query.data;
    if (data?.startsWith('swc:')) {
      await this.handleDelegatedSwapCallback(query);
      return;
    }

    const userId = query.from.id.toString();
    const chatId = query.message?.chat.id;
    
    if (!chatId) return;
    const key = sessionKey(userId, chatId);

    if (data === 'twc_base' || data === 'twc_eth') {
      const session = this.sessions.get(key);
      if (!session || session.step !== 'chain') {
        await this.bot.answerCallbackQuery(query.id, {
          text: 'No active chain step — start /deploy again.',
        });
        return;
      }
      session.data.chain = data === 'twc_eth' ? 'ethereum' : 'base';
      await this.bot.answerCallbackQuery(query.id, {
        text: session.data.chain === 'ethereum' ? 'Ethereum' : 'Base',
      });
      try {
        await this.bot.editMessageText(
          `✓ Chain: *${session.data.chain === 'ethereum' ? 'Ethereum' : 'Base'}* — next step below.`,
          {
            chat_id: chatId,
            message_id: query.message!.message_id!,
            parse_mode: 'Markdown',
          },
        );
      } catch {
        /* ignore */
      }
      const stub = query.message as TelegramBot.Message;
      await this.promptWalletOrPrivySummary(stub, session, key);
      return;
    }
    
    if (data === 'confirm_deploy') {
      const session = this.sessions.get(key);
      if (!session) return;

      if (
        session.data.symbol &&
        (await isTickerGloballyReserved(session.data.symbol))
      ) {
        await this.bot.answerCallbackQuery(query.id);
        await this.bot.sendMessage(
          chatId,
          `❌ ${await formatGlobalTickerCooldownMessage(session.data.symbol)}`,
        );
        this.sessions.delete(key);
        return;
      }
      
      await this.bot.answerCallbackQuery(query.id);
      await this.bot.editMessageText('🚀 Deploying token...', {
        chat_id: chatId,
        message_id: query.message?.message_id,
      });
      
      try {
        let imageUrl = session.data.imageUrl;
        if (!imageUrl && query.from) {
          imageUrl = await this.resolveTelegramProfileImageUrl(query.from);
        }

        const baseDesc = session.data.description
          ? `${session.data.description} | Deployed by Telegram @${session.data.username}`
          : `Deployed by Telegram @${session.data.username}`;
        const deployerPw = await getWalletForUser(
          'telegram',
          userId,
          query.from?.username || query.from?.first_name || '',
        );
        const feeSelf =
          session.data.feeToSelf === true &&
          !isNoDevOrForcedBurnFeeLabel(session.data.feeRecipientLabel);
        const catalogPrivy = deployerPw?.privyUserId ?? session.privyUserIdForFee;
        const limited = await applyDeployRateLimitBurn({
          walletAddress: session.data.walletAddress!,
          feeRecipientLabel: session.data.feeRecipientLabel,
          feeToSelf: feeSelf,
          platform: 'telegram',
          deployerId: userId,
          privyUserId: catalogPrivy ?? null,
        });
        const withMemeLimited =
          isNoDevOrForcedBurnFeeLabel(session.data.feeRecipientLabel) ||
          limited.rateLimitForcedBurn
            ? `${baseDesc}\n\n${MEME_TOKEN_DESCRIPTION_TAGLINE}`
            : baseDesc;
        const feeCd = await thirdPartyFeeRecipientCooldownErrorOrNull(limited.walletAddress, {
          feeToSelf: limited.feeToSelf,
          rateLimitForcedBurn: limited.rateLimitForcedBurn,
          feeRecipientLabel: limited.feeRecipientLabel ?? session.data.feeRecipientLabel,
        });
        if (feeCd) {
          await this.bot.sendMessage(chatId, `❌ ${feeCd}`);
          this.sessions.delete(key);
          return;
        }
        const result = await this.deployer.deployToken({
          ...(session.data as TokenDeploymentParams),
          walletAddress: limited.walletAddress,
          description: withMemeLimited,
          devBuyAmount: config.deployBondWei,
          hookType: 'static',
          deployerId: userId,
          ...(session.data.feeRecipientLabel || limited.feeRecipientLabel
            ? {
                feeRecipientLabel:
                  limited.feeRecipientLabel ?? session.data.feeRecipientLabel,
              }
            : {}),
          ...(imageUrl ? { imageUrl } : {}),
          feeToSelf: limited.feeToSelf,
          ...(catalogPrivy ? { privyUserId: catalogPrivy } : {}),
          chain: session.data.chain ?? 'base',
        });
        const links = this.deployer.generateTokenLinks(result.tokenAddress, result.chain);
        const scanLabel = result.chain === 'ethereum' ? 'Etherscan' : 'BaseScan';
        const txExplorerTxUrl =
          result.chain === 'ethereum'
            ? `https://etherscan.io/tx/${result.transactionHash}`
            : `https://basescan.org/tx/${result.transactionHash}`;
        
        const privyUrlMd = session.privyClaimUrl
          ? escapeMarkdownUrlForTelegram(session.privyClaimUrl)
          : '';
        const privyFoot =
          session.privyClaimUrl && session.privyIsNew !== undefined
            ? `\n\n🔍 ${session.privyIsNew ? 'New fee wallet — ' : ''}BaseScan: ${privyUrlMd}`
            : session.privyClaimUrl
              ? `\n\n🔍 BaseScan (fee wallet): ${privyUrlMd}`
              : '';

        const mdOk = escapeTelegramMarkdownLegacy;
        const success = `
🎉 *Token Deployed!*

👤 User: *${mdOk(session.data.username || '')}*
*${mdOk(session.data.name || '')}* ($${mdOk(session.data.symbol || '')})

📋 Token: \`${result.tokenAddress}\`
🔗 Pool: \`${result.poolId}\`

💰 Fee Recipient: \`${limited.walletAddress}\`${privyFoot}

📊 Links:
• [${scanLabel}](${links.explorer})
• [DexScreener](${links.dexscreener})
• [Uniswap swap](${links.uniswapSwap})
• [Uniswap token](${links.uniswap})
• [Liquid](${links.liquid})
• [Launches](${links.launcherApp})
• [Trade in Launcher — 0x](${links.launcherInAppSwap}) (sign in; you pay gas)

✅ Transaction: [View on ${scanLabel}](${txExplorerTxUrl})
${telegramPostDeployFooter()}
        `;
        
        await this.bot.sendMessage(chatId, success, { parse_mode: 'Markdown' });

        // Notify Discord debug + feed channels
        await debugSuccess(
          'Telegram: Token Deployed!',
          `**${session.data.name}** ($${session.data.symbol}) deployed by @${session.data.username}`,
          {
            'Token': result.tokenAddress,
            'Pool': result.poolId.slice(0, 20) + '...',
            'Fee Wallet': session.data.walletAddress || '',
            'Liquid': links.liquid,
            [scanLabel]: links.explorer,
          }
        );
        await feedPost(
          new EmbedBuilder()
            .setTitle(`🚀 New Token Deployed via Telegram`)
            .setDescription(`**${session.data.name}** ($${session.data.symbol})`)
            .addFields(
              { name: 'User', value: `@${session.data.username || 'unknown'}`, inline: true },
              { name: 'Chain', value: result.chain === 'ethereum' ? 'Ethereum' : 'Base', inline: true },
              { name: 'Token', value: result.tokenAddress, inline: false },
              { name: 'Liquid', value: links.liquid, inline: false },
              { name: scanLabel, value: links.explorer, inline: false }
            )
            .setColor(0x0088ff)
            .setTimestamp()
        );
        
      } catch (error: any) {
        await debugError('Telegram: Deployment Failed', error.message, {
          'User': `@${session.data.username || 'unknown'}`,
          'Token': `${session.data.name} ($${session.data.symbol})`,
        });
        await this.bot.sendMessage(
          chatId,
          formatTelegramUserError(error.message, '❌ Deployment failed: '),
        );
      }
      
      this.sessions.delete(key);
      
    } else if (data === 'cancel_deploy') {
      await this.bot.answerCallbackQuery(query.id);
      await this.bot.editMessageText('❌ Deployment cancelled.', {
        chat_id: chatId,
        message_id: query.message?.message_id,
      });
      this.sessions.delete(key);
    }
  }
  
  private async handleQuickLaunch(msg: TelegramBot.Message, match: RegExpExecArray | null): Promise<void> {
    if (!match || !match[1]) {
      const usage = shouldAskForWallet()
        ? '⚠️ Usage: /launch NAME SYMBOL WALLET [IMAGE_URL]\n\nExample: /launch ANAL AnalToken 0x123...\nOptional: https://... image at the end.\n\nOr: /launch https://x.com/…/status/… — add *base* or *ethereum* if both chains are enabled.'
        : '⚠️ Usage: /launch NAME SYMBOL [WALLET] [IMAGE_URL]\n\nExamples:\n/launch ANAL AnalToken\n/launch ANAL AnalToken 0xabc...\nOr one-link import:\n/launch https://x.com/…/status/… base\n\nIf both chains are on, include *base* or *ethereum* in the same message.';
      await this.bot.sendMessage(msg.chat.id, usage);
      return;
    }

    const parts = match[1].trim().split(/\s+/);
    const askWallet = shouldAskForWallet();
    const firstTok = parts[0] ?? '';
    const launchesFromImportUrl =
      /^https?:\/\//i.test(firstTok) || /^www\./i.test(firstTok);

    if (parts.length < 2 && !launchesFromImportUrl) {
      await this.bot.sendMessage(
        msg.chat.id,
        askWallet
          ? '⚠️ Usage: /launch NAME SYMBOL WALLET [IMAGE_URL]\n\nOr: /launch https://… (import) + *base*/*ethereum* if both chains are on.'
          : '⚠️ Usage: /launch NAME SYMBOL [WALLET] [IMAGE_URL]\n\nOr: /launch https://… — one-link import (add *base* or *ethereum* when both chains are enabled).',
      );
      return;
    }

    let name: string;
    let symbol: string;
    let wallet = '';
    let imageUrl: string | undefined;
    let privyClaimUrl: string | undefined;
    let privyIsNew: boolean | undefined;
    let feeRecipientLabel: string | undefined;
    let privyUserIdForQuickDeploy: string | undefined;
    /** True only when fees go to deployer's own Privy-linked wallet (not third party / burn). */
    let quickDeployFeeToSelf = false;
    let deployDescriptionOverride: string | undefined;

    if (launchesFromImportUrl) {
      const urlRaw = /^www\./i.test(firstTok) ? `https://${firstTok}` : firstTok;
      await this.bot.sendMessage(msg.chat.id, '⏳ Importing token from link…');
      let imported: NonNullable<Awaited<ReturnType<typeof resolveDeploySourceFromUrl>>> | null = null;
      try {
        imported = await resolveDeploySourceFromUrl(urlRaw, this.neynar);
      } catch (e: unknown) {
        const m = e instanceof Error ? e.message : String(e);
        await this.bot.sendMessage(msg.chat.id, `❌ ${m}`);
        return;
      }
      if (!imported) {
        await this.bot.sendMessage(
          msg.chat.id,
          '❌ Unsupported URL. Try an X post, GitHub repo/profile, Warpcast cast/profile, t.me, or Discord message/profile link.',
        );
        return;
      }
      name = (imported.name || '').trim().slice(0, 32);
      symbol = (imported.symbol || '').trim().toUpperCase();
      if (name.length < 2) {
        await this.bot.sendMessage(msg.chat.id, '❌ Could not derive a token name from that link.');
        return;
      }
      if (symbol.length < 2 || symbol.length > 10) {
        await this.bot.sendMessage(msg.chat.id, '❌ Symbol from that link is invalid.');
        return;
      }
      if (isReservedTokenName(name)) {
        await this.bot.sendMessage(msg.chat.id, `❌ ${reservedNameUserMessage()}`);
        return;
      }
      if (isReservedTicker(symbol)) {
        await this.bot.sendMessage(msg.chat.id, `❌ ${reservedTickerUserMessage(symbol)}`);
        return;
      }
      if (await isTickerGloballyReserved(symbol)) {
        await this.bot.sendMessage(
          msg.chat.id,
          `❌ ${await formatGlobalTickerCooldownMessage(symbol)}`,
        );
        return;
      }

      await this.bot.sendMessage(msg.chat.id, '⏳ Resolving fee recipient…');
      try {
        const resolved = await resolveFeeRecipientFromSocialPaste(this.neynar, imported.recipientPaste);
        wallet = resolved.walletAddress;
        feeRecipientLabel = resolved.feeRecipientLabel;
        quickDeployFeeToSelf = false;
        privyClaimUrl = undefined;
        privyIsNew = undefined;
        privyUserIdForQuickDeploy = undefined;
      } catch (e: unknown) {
        const m = e instanceof Error ? e.message : String(e);
        await this.bot.sendMessage(msg.chat.id, `❌ ${m}`);
        return;
      }

      if (imported.imageUrl && /^https?:\/\//i.test(imported.imageUrl)) {
        imageUrl = imported.imageUrl;
      }

      const fromImp = msg.from;
      const baseQuickDescImp = `Deployed by Telegram @${fromImp?.username || fromImp?.first_name || 'Unknown'}`;
      const importedBody = (imported.description || '').trim();
      deployDescriptionOverride = importedBody
        ? `${importedBody.slice(0, 380)}\n\n${baseQuickDescImp}`.slice(0, 500)
        : baseQuickDescImp;
    } else {
      name = parts[0];
      symbol = parts[1].toUpperCase();

      if (name.length < 2 || name.length > 32) {
        await this.bot.sendMessage(msg.chat.id, '❌ Name must be 2-32 characters.');
        return;
      }
      if (isReservedTokenName(name)) {
        await this.bot.sendMessage(msg.chat.id, `❌ ${reservedNameUserMessage()}`);
        return;
      }
      if (symbol.length < 2 || symbol.length > 10) {
        await this.bot.sendMessage(msg.chat.id, '❌ Symbol must be 2-10 characters.');
        return;
      }
      if (isReservedTicker(symbol)) {
        await this.bot.sendMessage(msg.chat.id, `❌ ${reservedTickerUserMessage(symbol)}`);
        return;
      }
      if (await isTickerGloballyReserved(symbol)) {
        await this.bot.sendMessage(
          msg.chat.id,
          `❌ ${await formatGlobalTickerCooldownMessage(symbol)}`,
        );
        return;
      }

      if (parts.length === 2) {
      if (askWallet) {
        await this.bot.sendMessage(
          msg.chat.id,
          '⚠️ Add your fee wallet: /launch NAME SYMBOL 0x... (or configure Privy so two-arg /launch uses your linked wallet).'
        );
        return;
      }
      const userId = msg.from?.id.toString();
      const username = msg.from?.username || msg.from?.first_name;
      if (!userId) {
        await this.bot.sendMessage(msg.chat.id, '❌ Could not read your Telegram user id.');
        return;
      }
      await this.bot.sendMessage(msg.chat.id, '⏳ Resolving your fee wallet…');
      const resolved = await getWalletForUser('telegram', userId, username);
      if (!resolved?.address) {
        await this.bot.sendMessage(
          msg.chat.id,
          '❌ Could not load your linked Privy wallet. Check server Privy configuration.'
        );
        return;
      }
      wallet = resolved.address;
      privyClaimUrl = resolved.claimUrl;
      privyIsNew = resolved.isNew;
      privyUserIdForQuickDeploy = resolved.privyUserId;
      quickDeployFeeToSelf = true;
    } else {
      const third = parts[2];
      if (matchesMemeFeeRecipientToken(third)) {
        const m = memeFeeWalletAndLabel();
        wallet = m.walletAddress;
        feeRecipientLabel = m.feeRecipientLabel;
        privyClaimUrl = undefined;
        privyIsNew = undefined;
        quickDeployFeeToSelf = false;
        if (parts.length > 3) {
          const rest = parts.slice(3).join(' ');
          imageUrl = parseOptionalHttpUrl(rest);
          if (!imageUrl) {
            await this.bot.sendMessage(
              msg.chat.id,
              '❌ After *meme* / *no dev*, optional image must be a full https:// URL.',
              { parse_mode: 'Markdown' },
            );
            return;
          }
        }
      } else if (third.match(/^0x[a-fA-F0-9]{40}$/)) {
        wallet = third;
        quickDeployFeeToSelf = false;
        if (parts.length > 3) {
          imageUrl = parseOptionalHttpUrl(parts.slice(3).join(' '));
          if (!imageUrl) {
            await this.bot.sendMessage(
              msg.chat.id,
              '❌ Optional image must be a valid https image URL.'
            );
            return;
          }
        }
      } else {
        if (askWallet) {
          await this.bot.sendMessage(
            msg.chat.id,
            '❌ Third argument must be a valid wallet (0x + 40 hex characters).'
          );
          return;
        }
        const rest = parts.slice(2).join(' ');
        const looksSocial =
          /warpcast\.com|twitter\.com\/|x\.com\/[^/]+\/status|github\.com\/[^/\s]+|t\.me\/|discord\.com\/users\/\d/i.test(
            rest,
          );
        if (looksSocial) {
          await this.bot.sendMessage(msg.chat.id, '⏳ Resolving fee recipient…');
          try {
            const resolved = await resolveFeeRecipientFromSocialPaste(this.neynar, rest);
            wallet = resolved.walletAddress;
            feeRecipientLabel = resolved.feeRecipientLabel;
            quickDeployFeeToSelf = false;
            privyClaimUrl = undefined;
            privyIsNew = undefined;
          } catch (e: any) {
            await this.bot.sendMessage(
              msg.chat.id,
              `❌ ${e?.message || 'Could not resolve fee recipient.'}`,
            );
            return;
          }
        } else {
          const userId = msg.from?.id.toString();
          const username = msg.from?.username || msg.from?.first_name;
          if (!userId) {
            await this.bot.sendMessage(msg.chat.id, '❌ Could not read your Telegram user id.');
            return;
          }
          await this.bot.sendMessage(msg.chat.id, '⏳ Resolving your fee wallet…');
          const resolved = await getWalletForUser('telegram', userId, username);
          if (!resolved?.address) {
            await this.bot.sendMessage(
              msg.chat.id,
              '❌ Could not load your linked Privy wallet.'
            );
            return;
          }
          wallet = resolved.address;
          privyClaimUrl = resolved.claimUrl;
          privyIsNew = resolved.isNew;
          privyUserIdForQuickDeploy = resolved.privyUserId;
          quickDeployFeeToSelf = true;
          imageUrl = parseOptionalHttpUrl(rest);
          if (!imageUrl) {
            await this.bot.sendMessage(
              msg.chat.id,
              '❌ Could not parse image URL. Use a full https:// link, or paste a Warpcast / GitHub / t.me / Discord profile link for fees to someone else.'
            );
            return;
          }
        }
      }
    }
    }

    const from = msg.from;
    const baseQuickDesc = `Deployed by Telegram @${from?.username || from?.first_name || 'Unknown'}`;
    const deployerPwQuick = from
      ? await getWalletForUser(
          'telegram',
          String(from.id),
          from.username || from.first_name || '',
        )
      : null;
    const feeSelfQuick =
      quickDeployFeeToSelf && !isNoDevOrForcedBurnFeeLabel(feeRecipientLabel);
    const catalogPrivyQuick = deployerPwQuick?.privyUserId ?? privyUserIdForQuickDeploy;
    const limitedQuick = await applyDeployRateLimitBurn({
      walletAddress: wallet,
      feeRecipientLabel,
      feeToSelf: feeSelfQuick,
      platform: 'telegram',
      deployerId: from ? String(from.id) : 'unknown',
      privyUserId: catalogPrivyQuick ?? null,
    });
    if (limitedQuick.rateLimitForcedBurn) {
      await this.bot.sendMessage(msg.chat.id, `🚨 ${DEPLOY_LIMIT_MEME_PROCEED_USER_NOTICE}`);
    }
    const rollingHQuick = deployRateLimitRollingHours();
    if (rollingHQuick > 0) {
      try {
        const hintAddr = getAddress(wallet as `0x${string}`);
        const thirdRecentQuick = await listThirdPartyFeeTokensForFeeRecipientRollingHours(
          hintAddr,
          rollingHQuick,
          6,
        );
        if (thirdRecentQuick.length > 0) {
          await this.bot.sendMessage(
            msg.chat.id,
            `⚠️ Others launched for this fee wallet in the last ${rollingHQuick}h (${thirdRecentQuick.length}).\n\n${thirdPartyRollingWindowDeployWarnUserMessage(rollingHQuick)}`,
          );
        }
      } catch {
        /* ignore invalid wallet */
      }
    }

    let deployChainQuick: import('../lib/deployChain.js').DeployChain;
    if (config.ethereum.deployEnabled) {
      const ex = inferExplicitDeployChainFromText(msg.text ?? '');
      if (!ex) {
        await this.bot.sendMessage(
          msg.chat.id,
          'Which chain should this token be deployed on? Include the word *base* or *ethereum* in the same `/launch` message — e.g. `/launch MyToken MTK base` or `/launch MyToken MTK ethereum`.',
          { parse_mode: 'Markdown' },
        );
        return;
      }
      deployChainQuick = ex;
    } else {
      deployChainQuick = resolveDeployChain({ messageText: msg.text ?? '' });
    }

    await this.bot.sendMessage(msg.chat.id, `🚀 Deploying ${name} ($${symbol})...`);

    try {
      let resolvedImage = imageUrl;
      if (!resolvedImage && msg.from) {
        resolvedImage = await this.resolveTelegramProfileImageUrl(msg.from);
      }

      const feeCdQuick = await thirdPartyFeeRecipientCooldownErrorOrNull(limitedQuick.walletAddress, {
        feeToSelf: limitedQuick.feeToSelf,
        rateLimitForcedBurn: limitedQuick.rateLimitForcedBurn,
        feeRecipientLabel: limitedQuick.feeRecipientLabel ?? feeRecipientLabel,
      });
      if (feeCdQuick) {
        await this.bot.sendMessage(msg.chat.id, `❌ ${feeCdQuick}`);
        return;
      }
      const feeLabelQuick = limitedQuick.feeRecipientLabel ?? feeRecipientLabel;
      const memeOrBurnDesc =
        feeRecipientLabel === MEME_FEE_RECIPIENT_LABEL ||
        feeRecipientLabel === X_FORCED_DEAD_FEE_LABEL ||
        limitedQuick.rateLimitForcedBurn;
      const quickDescFinal =
        deployDescriptionOverride !== undefined
          ? memeOrBurnDesc
            ? `${deployDescriptionOverride}\n\n${MEME_TOKEN_DESCRIPTION_TAGLINE}`.slice(0, 500)
            : deployDescriptionOverride
          : memeOrBurnDesc
            ? `${baseQuickDesc}\n\n${MEME_TOKEN_DESCRIPTION_TAGLINE}`
            : baseQuickDesc;

      const result = await this.deployer.deployToken({
        name,
        symbol,
        walletAddress: limitedQuick.walletAddress,
        description: quickDescFinal,
        devBuyAmount: config.deployBondWei,
        hookType: 'static',
        platform: 'telegram',
        username: from?.username || from?.first_name || 'Unknown',
        deployerId: from ? String(from.id) : 'unknown',
        ...(feeLabelQuick ? { feeRecipientLabel: feeLabelQuick } : {}),
        ...(resolvedImage ? { imageUrl: resolvedImage } : {}),
        feeToSelf: limitedQuick.feeToSelf,
        ...(catalogPrivyQuick ? { privyUserId: catalogPrivyQuick } : {}),
        chain: deployChainQuick,
      });

      const links = this.deployer.generateTokenLinks(result.tokenAddress, result.chain);
      const scanLabelQuick = result.chain === 'ethereum' ? 'Etherscan' : 'BaseScan';
      const txExplorerTxUrlQuick =
        result.chain === 'ethereum'
          ? `https://etherscan.io/tx/${result.transactionHash}`
          : `https://basescan.org/tx/${result.transactionHash}`;

      const privyUrlMd = privyClaimUrl
        ? escapeMarkdownUrlForTelegram(privyClaimUrl)
        : '';
      const privyFoot =
        privyClaimUrl && privyIsNew !== undefined
          ? `\n\n🔍 ${privyIsNew ? 'New fee wallet — ' : ''}BaseScan: ${privyUrlMd}`
          : privyClaimUrl
            ? `\n\n🔍 BaseScan (fee wallet): ${privyUrlMd}`
            : '';

      const mdQ = escapeTelegramMarkdownLegacy;
      const success = `
🎉 *Token Deployed!*

*${mdQ(name)}* ($${mdQ(symbol)})

📋 Token: \`${result.tokenAddress}\`
🔗 Pool: \`${result.poolId}\`

💰 Fee Recipient: \`${limitedQuick.walletAddress}\`${privyFoot}

📊 Links:
• [${scanLabelQuick}](${links.explorer})
• [DexScreener](${links.dexscreener})
• [Uniswap swap](${links.uniswapSwap})
• [Uniswap token](${links.uniswap})
• [Liquid](${links.liquid})
• [Launches](${links.launcherApp})
• [Trade in Launcher — 0x](${links.launcherInAppSwap}) (sign in; you pay gas)

✅ Transaction: [View on ${scanLabelQuick}](${txExplorerTxUrlQuick})
${telegramPostDeployFooter()}
      `;

      await this.bot.sendMessage(msg.chat.id, success, { parse_mode: 'Markdown' });
    } catch (error: any) {
      await this.bot.sendMessage(
        msg.chat.id,
        formatTelegramUserError(error.message, '❌ Deployment failed: '),
      );
    }
  }
}
