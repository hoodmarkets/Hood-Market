import {
  Client,
  GatewayIntentBits,
  SlashCommandBuilder,
  REST,
  Routes,
  EmbedBuilder,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  MessageFlags,
  type Interaction,
  type TextChannel,
  type Message,
  type ButtonInteraction,
  type ChatInputCommandInteraction,
  type MessageComponentInteraction,
} from 'discord.js';
import { config } from '../config.js';
import { logger } from '../logger.js';
import { LiquidDeployer, type TokenDeploymentParams } from '../deployer.js';
import { NeynarClient } from '../neynar.js';
import { formatEther, getAddress } from 'viem';
import { formatDeployError } from '../lib/formatDeployError.js';
import { resolveDeploySourceFromUrl } from '../lib/resolveDeploySource.js';
import { parseOptionalHttpUrl } from '../lib/url.js';
import { setDiscordDebugClient } from '../lib/discordDebug.js';
import { getWalletForUser, shouldAskForWallet } from '../lib/walletResolver.js';
import { resolveFeeRecipientFromSocialPaste } from '../lib/webFeeRecipient.js';
import {
  DEPLOY_LIMIT_MEME_PROCEED_USER_NOTICE,
  isNoDevOrForcedBurnFeeLabel,
  MEME_FEE_RECIPIENT_LABEL,
  MEME_TOKEN_DESCRIPTION_TAGLINE,
  matchesMemeFeeRecipientToken,
  memeFeeWalletAndLabel,
} from '../lib/memeFeeRecipient.js';
import {
  formatGlobalTickerCooldownMessage,
  isTickerGloballyReserved,
  thirdPartyFeeRecipientCooldownErrorOrNull,
} from '../lib/globalTickerCooldown.js';
import { applyDeployRateLimitBurn } from '../lib/deployRateLimitBurn.js';
import { runSocialTradingFeesClaim } from '../lib/socialFeeClaim.js';
import {
  isReservedTokenName,
  isReservedTicker,
  reservedNameUserMessage,
  reservedTickerUserMessage,
} from '../lib/reservedTokens.js';
import {
  listSelfFeeTokensForFeeRecipient,
  listThirdPartyFeeTokensForFeeRecipientRollingHours,
} from '../lib/deploymentCatalog.js';
import {
  deployRateLimitRollingHours,
  thirdPartyRollingWindowDeployWarnUserMessage,
} from '../lib/selfFeeLimit.js';
import { launcherTradeDeepLink, parseTradeIntentMessage } from '../lib/tradeIntent.js';
import { createIdentity } from '../lib/privy.js';
import { executeDelegatedSwapFromChat, isDelegatedServerSwapConfigured } from '../lib/delegatedSwapExecution.js';
import { createPendingChatSwap, takePendingChatSwap } from '../lib/pendingChatSwaps.js';
import {
  isChatAgentConfigured,
  runChatAgentForIdentity,
  truncateForDiscord,
} from '../lib/chatAgentBridge.js';
import {
  executeWalletTransfer,
  getWalletBalanceText,
  getWalletPortfolioText,
  parseWalletCommandMessage,
} from '../lib/walletActions.js';
import { resolveDeployChain } from '../lib/deployChain.js';

interface DiscordSession {
  userId: string;
  channelId: string;
  step: number;
  data: Partial<TokenDeploymentParams>;
}

export class DiscordHandler {
  private client: Client;
  private deployer: LiquidDeployer;
  private neynar: NeynarClient;
  private sessions: Map<string, DiscordSession> = new Map();
  /** Pending slash /deploy confirmation (avoids brittle customId encoding) */
  private pendingDeployByUser = new Map<string, TokenDeploymentParams>();
  
  constructor(deployer: LiquidDeployer, neynar: NeynarClient) {
    if (!config.discord.token) {
      throw new Error('Discord token not configured');
    }
    
    this.deployer = deployer;
    this.neynar = neynar;
    
    this.client = new Client({
      intents: [
        GatewayIntentBits.Guilds,
        GatewayIntentBits.GuildMessages,
        GatewayIntentBits.MessageContent,
        GatewayIntentBits.DirectMessages,
      ]
    });
    
    this.setupHandlers();
    logger.info('Discord handler initialized');
  }
  
  async initialize(): Promise<void> {
    await this.registerCommands();
    await this.client.login(config.discord.token);
    // login() resolves when the client is ready — register for debug webhook + startup report
    setDiscordDebugClient(this.client);
    logger.info('Discord bot logged in');
  }
  
  private async registerCommands(): Promise<void> {
    // Discord requires every required option before any optional option on the same command.
    const deployCmd = new SlashCommandBuilder()
      .setName('deploy')
      .setDescription(
        config.ethereum.deployEnabled
          ? 'Deploy a token — choose Base (Liquid) or Ethereum'
          : 'Deploy a token on Base (Liquid Protocol)',
      );

    if (config.ethereum.deployEnabled) {
      deployCmd.addStringOption((option) =>
        option
          .setName('chain')
          .setDescription('Which chain should this token be deployed on?')
          .setRequired(true)
          .addChoices(
            { name: 'Base (Liquid Protocol)', value: 'base' },
            { name: 'Ethereum', value: 'ethereum' },
          ),
      );
    }

    deployCmd
      .addStringOption((option) =>
        option
          .setName('name')
          .setDescription('Token name (optional if source_url fills it)')
          .setRequired(false),
      )
      .addStringOption((option) =>
        option
          .setName('symbol')
          .setDescription('Token symbol e.g. TEST (optional if source_url fills it)')
          .setRequired(false),
      )
      .addStringOption((option) =>
        option
          .setName('wallet')
          // Discord option description max 100 characters
          .setDescription('Optional 0x fee wallet. Omit for Privy-linked default.')
          .setRequired(false),
      )
      .addStringOption((option) =>
        option
          .setName('fee_recipient')
          .setDescription(
            'Fees: omit = you. Or meme / no dev / 0x / social link (see /help). Not on X.',
          )
          .setRequired(false)
          .setMaxLength(2048),
      )
      .addStringOption((option) =>
        option
          .setName('description')
          .setDescription('Token description (optional)')
          .setRequired(false)
          .setMaxLength(500),
      )
      .addStringOption((option) =>
        option
          .setName('image')
          .setDescription('Token image URL — https://... (optional)')
          .setRequired(false)
          .setMaxLength(2048),
      )
      .addStringOption((option) =>
        option
          .setName('source_url')
          .setDescription(
            'X post, GitHub, Warpcast, t.me, or Discord URL — prefill like the website importer',
          )
          .setRequired(false)
          .setMaxLength(2048),
      )
      .addAttachmentOption((option) =>
        option
          .setName('image_file')
          .setDescription('Or upload an image file (PNG, JPG, WebP, GIF)')
          .setRequired(false),
      );

    const commands = [
      deployCmd,
      new SlashCommandBuilder()
        .setName('claim')
        .setDescription('Claim WETH trading fees for a token you deployed from Discord')
        .addStringOption((option) =>
          option
            .setName('token')
            .setDescription('Token contract 0x… or ticker (e.g. PEPE)')
            .setRequired(true)
            .setMaxLength(128)),
      new SlashCommandBuilder()
        .setName('help')
        .setDescription('Show help information'),
      new SlashCommandBuilder()
        .setName('balance')
        .setDescription('Your Base wallet: ETH + indexed tokens (same as Telegram “balance”)')
        .addStringOption((option) =>
          option
            .setName('token')
            .setDescription('Optional ERC-20 on Base (0x…). Omit for ETH + portfolio snippet.')
            .setRequired(false)
            .setMaxLength(42),
        ),
      new SlashCommandBuilder()
        .setName('portfolio')
        .setDescription('Base token holdings summary (all tokens when available)'),
      new SlashCommandBuilder()
        .setName('ai')
        .setDescription('Ask the Liquid Launcher AI (markets, wallet, delegated swaps)')
        .addStringOption((option) =>
          option
            .setName('prompt')
            .setDescription('Your question')
            .setRequired(true)
            .setMaxLength(2000),
        ),
      new SlashCommandBuilder()
        .setName('ask')
        .setDescription('Same as /ai — ask the Liquid Launcher assistant')
        .addStringOption((option) =>
          option
            .setName('prompt')
            .setDescription('Your question')
            .setRequired(true)
            .setMaxLength(2000),
        ),
    ].map(command => command.toJSON());
    
    const clientId = config.discord.clientId?.trim();
    if (!clientId) {
      throw new Error(
        'DISCORD_CLIENT_ID is missing. Set it in Railway to your Application ID (Discord Developer Portal → Your app → General). Required to register slash commands.',
      );
    }

    const rest = new REST({ version: '10' }).setToken(config.discord.token!);

    try {
      await rest.put(Routes.applicationCommands(clientId), { body: commands });
      logger.info('Discord slash commands registered');
    } catch (error) {
      logger.error('Failed to register Discord commands:', error);
      throw error;
    }
  }
  
  private setupHandlers(): void {
    this.client.on('clientReady', () => {
      logger.info(`Discord bot ready as ${this.client.user?.tag}`);
    });
    
    this.client.on('interactionCreate', this.handleInteraction.bind(this));

    this.client.on('messageCreate', async (message: Message) => {
      try {
        if (message.author.bot) return;
        const content = message.content?.trim();
        if (!content) return;

        // Same as Telegram: `/ai …` / `/ask …` / `/ai@BotName …` (needs Message Content Intent in guilds)
        const aiMsgMatch = content.match(/^\/(?:ai|ask)(?:@\w+)?\s+([\s\S]+)/i);
        if (aiMsgMatch?.[1]?.trim()) {
          if (!isChatAgentConfigured()) {
            await message.reply({
              content:
                'AI assistant is not configured (set OPENAI_API_KEY or LANGCHAIN_LLM_API_KEY). Or use `/ai` with the prompt option.',
              allowedMentions: { repliedUser: false },
            });
            return;
          }
          await this.handleDiscordAiPrefixMessage(message, aiMsgMatch[1].trim());
          return;
        }

        const walletCmd = parseWalletCommandMessage(content);
        if (walletCmd) {
          const identity = createIdentity(
            'discord',
            message.author.id,
            message.author.username,
            message.author.discriminator ?? undefined,
          );
          if (walletCmd.kind === 'balance') {
            const text = await getWalletBalanceText(identity, walletCmd.tokenAddress);
            await message.reply({
              content: truncateForDiscord(text, 1900),
              allowedMentions: { repliedUser: false },
            });
          } else if (walletCmd.kind === 'portfolio') {
            const text = await getWalletPortfolioText(identity);
            await message.reply({
              content: truncateForDiscord(text, 1900),
              allowedMentions: { repliedUser: false },
            });
          } else {
            const result = await executeWalletTransfer(identity, walletCmd);
            if (result.ok) {
              const pendingLine = result.isPendingUserOperation
                ? '\nStill waiting for the final Base tx hash from Privy smart-wallet bundling.'
                : '';
              await message.reply({
                content: `✅ Transfer submitted.${pendingLine}\n${result.basescanUrl}\n\`${result.transactionHash}\``,
                allowedMentions: { repliedUser: false },
              });
            } else {
              let msg = `❌ ${result.error}`;
              if (result.hint) msg += `\n\n${result.hint}`;
              await message.reply({
                content: truncateForDiscord(msg, 1900),
                allowedMentions: { repliedUser: false },
              });
            }
          }
          return;
        }
        const intent = parseTradeIntentMessage(content);
        if (!intent) return;
        if (intent.amount && isDelegatedServerSwapConfigured()) {
          const identity = createIdentity(
            'discord',
            message.author.id,
            message.author.username,
            message.author.discriminator ?? undefined,
          );
          const result = await executeDelegatedSwapFromChat(identity, intent);
          if (result.ok) {
            const pendingLine = result.isPendingUserOperation
              ? '\nStill waiting for the final Base tx hash from Privy smart-wallet bundling.'
              : '';
            await message.reply({
              content: `✅ Submitted ${intent.side} for ${intent.amount}.${pendingLine}\n${result.basescanUrl}\n\`${result.transactionHash}\``,
              allowedMentions: { repliedUser: false },
            });
          } else {
            let msg = `❌ ${result.error}`;
            if (result.hint) msg += `\n\n${result.hint}`;
            await message.reply({
              content: msg,
              allowedMentions: { repliedUser: false },
            });
          }
          return;
        }
        const url = launcherTradeDeepLink(intent.address, intent.side);
        const flip = intent.side === 'buy' ? 'sell' : 'buy';
        const flipUrl = launcherTradeDeepLink(intent.address, flip);
        const title = intent.side === 'buy' ? 'Buy with ETH' : 'Sell for ETH';
        let baseContent =
          `💱 **${title}** (Base · 0x) — \`${intent.address}\`${intent.amount ? `\nAmount: **${intent.amount}** ${intent.side === 'buy' ? 'ETH' : 'token units'}` : ''}\n\n` +
          `${url}\n\n` +
          `${flip === 'buy' ? 'Buy' : 'Sell'} instead: ${flipUrl}\n\n` +
          `Open the link, sign in, then you’ll see the live quote and gas estimate. You pay Base gas (ETH); the launcher doesn’t sponsor gas by default.`;
        if (isDelegatedServerSwapConfigured()) {
          baseContent +=
            `\n\nIf you granted **server access** in the web app, use **Confirm (server)** below (same linked wallet).`;
        }
        const components =
          isDelegatedServerSwapConfigured()
            ? [
                new ActionRowBuilder<ButtonBuilder>().addComponents(
                  new ButtonBuilder()
                    .setCustomId(
                      `swc:${createPendingChatSwap({
                        kind: 'discord',
                        discordUserId: message.author.id,
                        username: message.author.username,
                        discriminator: message.author.discriminator ?? undefined,
                        intent,
                      })}`,
                    )
                    .setLabel('Confirm (server)')
                    .setStyle(ButtonStyle.Primary),
                  new ButtonBuilder()
                    .setLabel('Open in browser')
                    .setStyle(ButtonStyle.Link)
                    .setURL(url),
                ),
              ]
            : [];
        await message.reply({
          content: baseContent,
          allowedMentions: { repliedUser: false },
          ...(components.length ? { components } : {}),
        });
      } catch (error: unknown) {
        logger.error('Discord trade intent:', error);
      }
    });
  }
  
  private async handleInteraction(interaction: Interaction): Promise<void> {
    if (interaction.isButton() && interaction.customId.startsWith('swc:')) {
      await this.handleDelegatedSwapButton(interaction);
      return;
    }

    if (!interaction.isCommand()) return;
    
    try {
      switch (interaction.commandName) {
        case 'deploy':
          await this.handleDeploy(interaction);
          break;
        case 'claim':
          await this.handleClaim(interaction);
          break;
        case 'help':
          await this.handleHelp(interaction);
          break;
        case 'balance':
          if (interaction.isChatInputCommand()) {
            await this.handleBalanceSlashCommand(interaction);
          }
          break;
        case 'portfolio':
          if (interaction.isChatInputCommand()) {
            await this.handlePortfolioSlashCommand(interaction);
          }
          break;
        case 'ai':
        case 'ask':
          if (interaction.isChatInputCommand()) {
            await this.handleAiSlashCommand(interaction);
          }
          break;
      }
    } catch (error: any) {
      logger.error('Discord interaction error:', error);
      await interaction.reply({
        content: `❌ Error: ${error.message}`,
        flags: MessageFlags.Ephemeral
      });
    }
  }

  private async handleDelegatedSwapButton(interaction: ButtonInteraction): Promise<void> {
    try {
      const id = interaction.customId.slice(4);
      const pending = takePendingChatSwap(id);
      if (!pending || pending.kind !== 'discord') {
        await interaction.reply({
          content: 'This swap link expired. Send buy/sell again.',
          flags: MessageFlags.Ephemeral,
        });
        return;
      }
      if (pending.discordUserId !== interaction.user.id) {
        await interaction.reply({ content: 'Not your swap request.', flags: MessageFlags.Ephemeral });
        return;
      }
      await interaction.deferUpdate();
      const identity = createIdentity(
        'discord',
        pending.discordUserId,
        pending.username,
        pending.discriminator,
      );
      const result = await executeDelegatedSwapFromChat(identity, pending.intent);
      if (result.ok) {
        await interaction.followUp({
          content: `✅ Submitted: ${result.basescanUrl}\n\`${result.transactionHash}\``,
          flags: MessageFlags.Ephemeral,
        });
      } else {
        let msg = `❌ ${result.error}`;
        if (result.hint) msg += `\n\n${result.hint}`;
        await interaction.followUp({ content: msg, flags: MessageFlags.Ephemeral });
      }
    } catch (error: unknown) {
      logger.error('Discord delegated swap:', error);
      const errMsg = error instanceof Error ? error.message : 'Unknown error';
      try {
        if (interaction.deferred) {
          await interaction.followUp({ content: `❌ ${errMsg}`, flags: MessageFlags.Ephemeral });
        } else if (!interaction.replied) {
          await interaction.reply({ content: `❌ ${errMsg}`, flags: MessageFlags.Ephemeral });
        }
      } catch {
        /* ignore */
      }
    }
  }

  private async handleBalanceSlashCommand(interaction: ChatInputCommandInteraction): Promise<void> {
    const tokenRaw = interaction.options.getString('token')?.trim();
    let tokenAddress: `0x${string}` | undefined;
    if (tokenRaw) {
      try {
        tokenAddress = getAddress(tokenRaw as `0x${string}`);
      } catch {
        await interaction.reply({
          content: '❌ Invalid token address. Use a Base ERC-20 contract (0x + 40 hex).',
          flags: MessageFlags.Ephemeral,
        });
        return;
      }
    }
    await interaction.deferReply();
    const identity = createIdentity(
      'discord',
      interaction.user.id,
      interaction.user.username,
      interaction.user.discriminator ?? undefined,
    );
    try {
      const text = await getWalletBalanceText(identity, tokenAddress);
      await interaction.editReply({ content: truncateForDiscord(text, 1900) });
    } catch (e: unknown) {
      const err = e instanceof Error ? e.message : String(e);
      await interaction.editReply({ content: `❌ ${truncateForDiscord(err, 1900)}` });
    }
  }

  private async handlePortfolioSlashCommand(interaction: ChatInputCommandInteraction): Promise<void> {
    await interaction.deferReply();
    const identity = createIdentity(
      'discord',
      interaction.user.id,
      interaction.user.username,
      interaction.user.discriminator ?? undefined,
    );
    try {
      const text = await getWalletPortfolioText(identity);
      await interaction.editReply({ content: truncateForDiscord(text, 1900) });
    } catch (e: unknown) {
      const err = e instanceof Error ? e.message : String(e);
      await interaction.editReply({ content: `❌ ${truncateForDiscord(err, 1900)}` });
    }
  }

  private async handleDiscordAiPrefixMessage(message: Message, prompt: string): Promise<void> {
    const identity = createIdentity(
      'discord',
      message.author.id,
      message.author.username,
      message.author.discriminator ?? undefined,
    );
    try {
      const { output } = await runChatAgentForIdentity({ identity, userMessage: prompt });
      const text = truncateForDiscord(output, 8000);
      const max = 2000;
      await message.reply({
        content: text.slice(0, max),
        allowedMentions: { repliedUser: false },
      });
      for (let i = max; i < text.length; i += max) {
        await message.reply({
          content: text.slice(i, i + max),
          allowedMentions: { repliedUser: false },
        });
      }
    } catch (e: unknown) {
      logger.error('Discord /ai message:', e);
      const err = e instanceof Error ? e.message : String(e);
      await message.reply({
        content: `❌ ${truncateForDiscord(err, 1900)}`,
        allowedMentions: { repliedUser: false },
      });
    }
  }

  private async handleAiSlashCommand(interaction: ChatInputCommandInteraction): Promise<void> {
    if (!isChatAgentConfigured()) {
      await interaction.reply({
        content: 'AI assistant is not configured (set OPENAI_API_KEY or LANGCHAIN_LLM_API_KEY).',
        flags: MessageFlags.Ephemeral,
      });
      return;
    }
    const prompt = interaction.options.getString('prompt', true);
    await interaction.deferReply();
    const identity = createIdentity(
      'discord',
      interaction.user.id,
      interaction.user.username,
      interaction.user.discriminator ?? undefined,
    );
    try {
      const { output } = await runChatAgentForIdentity({ identity, userMessage: prompt });
      const text = truncateForDiscord(output, 8000);
      const max = 2000;
      await interaction.editReply({ content: text.slice(0, max) || '…' });
      for (let i = max; i < text.length; i += max) {
        await interaction.followUp({ content: text.slice(i, i + max) });
      }
    } catch (e: unknown) {
      logger.error('Discord /ai slash:', e);
      const err = e instanceof Error ? e.message : String(e);
      await interaction.editReply({ content: `❌ ${truncateForDiscord(err, 1900)}` });
    }
  }
  
  private async handleDeploy(interaction: any): Promise<void> {
    await interaction.deferReply({ flags: MessageFlags.Ephemeral });

    const sourceUrlRaw = interaction.options.getString('source_url')?.trim();
    let imported: NonNullable<Awaited<ReturnType<typeof resolveDeploySourceFromUrl>>> | null = null;
    if (sourceUrlRaw) {
      try {
        const r = await resolveDeploySourceFromUrl(sourceUrlRaw, this.neynar);
        if (!r) {
          await interaction.editReply(
            '❌ Unsupported **source_url**. Use an X status link, GitHub repo/profile, Warpcast cast/profile, Telegram **t.me/…**, or a Discord message/profile URL.',
          );
          return;
        }
        imported = r;
      } catch (e: unknown) {
        const msg = e instanceof Error ? e.message : String(e);
        await interaction.editReply(
          `❌ Could not import **source_url**: ${truncateForDiscord(msg, 1800)}`,
        );
        return;
      }
    }

    const nameOpt = interaction.options.getString('name')?.trim();
    const symbolOpt = interaction.options.getString('symbol')?.trim()?.toUpperCase();
    const name = (nameOpt || imported?.name || '').trim();
    const symbol = (symbolOpt || imported?.symbol || '').trim().toUpperCase();

    if (!name || !symbol) {
      await interaction.editReply(
        '❌ Set **name** and **symbol**, or pass **source_url** with a supported link (same importer as the Liquid Launcher website).',
      );
      return;
    }

    const walletOption = interaction.options.getString('wallet')?.trim();
    const feeRecipientOpt = interaction.options.getString('fee_recipient')?.trim();
    const feeRecipientRaw =
      feeRecipientOpt && feeRecipientOpt.length > 0 ? feeRecipientOpt : imported?.recipientPaste;

    const description =
      interaction.options.getString('description')?.trim() ||
      imported?.description?.trim() ||
      undefined;
    const imageInput = interaction.options.getString('image')?.trim() ?? '';
    const imageAttachment = interaction.options.getAttachment('image_file');
    const importImageUrl =
      imported?.imageUrl && /^https?:\/\//i.test(imported.imageUrl) ? imported.imageUrl : undefined;

    let wallet = '';
    let feeRecipientLabel: string | undefined;
    let privyUserIdForDiscord: string | undefined;
    /** Fees to deployer’s own wallet vs third party / burn — for catalog daily limits. */
    let feeToSelfForDeploy = false;
    let deployerPrivyUserId: string | undefined;

    if (feeRecipientRaw && matchesMemeFeeRecipientToken(feeRecipientRaw)) {
      const m = memeFeeWalletAndLabel();
      wallet = m.walletAddress;
      feeRecipientLabel = m.feeRecipientLabel;
    } else if (!feeRecipientRaw || feeRecipientRaw.toLowerCase() === 'me' || feeRecipientRaw.toLowerCase() === 'self') {
      if (walletOption && /^0x[a-fA-F0-9]{40}$/.test(walletOption)) {
        wallet = walletOption;
        feeRecipientLabel = `Wallet ${walletOption.slice(0, 6)}…${walletOption.slice(-4)}`;
        feeToSelfForDeploy = true;
        const dw = await getWalletForUser(
          'discord',
          interaction.user.id,
          interaction.user.username,
          interaction.user.discriminator ?? '0',
        );
        deployerPrivyUserId = dw?.privyUserId;
      } else if (walletOption) {
        await interaction.editReply('❌ Invalid wallet. Use 0x + 40 hex characters, or omit for Privy fee wallet.');
        return;
      } else if (shouldAskForWallet()) {
        await interaction.editReply(
          '❌ Fee wallet required: set `PRIVY_APP_ID` and `PRIVY_APP_SECRET` (Privy fee wallet is used by default), or pass `wallet` with your 0x address. To disable Privy wallets, set `USE_PRIVY_WALLETS=false`.',
        );
        return;
      } else {
        const resolved = await getWalletForUser(
          'discord',
          interaction.user.id,
          interaction.user.username,
          interaction.user.discriminator ?? '0',
        );
        if (!resolved?.address) {
          await interaction.editReply(
            '❌ Could not resolve your Privy fee wallet. Check `PRIVY_APP_ID` / `PRIVY_APP_SECRET` and Privy Discord login.',
          );
          return;
        }
        wallet = resolved.address;
        feeRecipientLabel = 'Your Discord wallet';
        privyUserIdForDiscord = resolved.privyUserId;
        deployerPrivyUserId = resolved.privyUserId;
        feeToSelfForDeploy = true;
      }
    } else if (feeRecipientRaw.match(/^0x[a-fA-F0-9]{40}$/)) {
      const deployer = await getWalletForUser(
        'discord',
        interaction.user.id,
        interaction.user.username,
        interaction.user.discriminator ?? '0',
      );
      if (deployer?.privyUserId) {
        wallet = feeRecipientRaw;
        feeRecipientLabel = `Wallet ${feeRecipientRaw.slice(0, 6)}…${feeRecipientRaw.slice(-4)}`;
        deployerPrivyUserId = deployer.privyUserId;
        feeToSelfForDeploy = false;
      } else {
        wallet = feeRecipientRaw;
        feeRecipientLabel = `Wallet ${feeRecipientRaw.slice(0, 6)}…${feeRecipientRaw.slice(-4)}`;
        feeToSelfForDeploy = false;
      }
    } else {
      try {
        const deployer = await getWalletForUser(
          'discord',
          interaction.user.id,
          interaction.user.username,
          interaction.user.discriminator ?? '0',
        );
        const resolved = await resolveFeeRecipientFromSocialPaste(this.neynar, feeRecipientRaw);
        if (deployer?.privyUserId) {
          wallet = resolved.walletAddress;
          feeRecipientLabel = resolved.feeRecipientLabel;
          deployerPrivyUserId = deployer.privyUserId;
          feeToSelfForDeploy = false;
        } else {
          wallet = resolved.walletAddress;
          feeRecipientLabel = resolved.feeRecipientLabel;
          feeToSelfForDeploy = false;
        }
      } catch (e: any) {
        await interaction.editReply(`❌ ${e?.message || 'Could not resolve fee recipient.'}`);
        return;
      }
    }

    if (!wallet) {
      await interaction.editReply('❌ Could not determine fee wallet.');
      return;
    }

    if (name && isReservedTokenName(name)) {
      await interaction.editReply(`❌ ${reservedNameUserMessage()}`);
      return;
    }
    if (symbol && isReservedTicker(symbol)) {
      await interaction.editReply(`❌ ${reservedTickerUserMessage(symbol)}`);
      return;
    }
    if (symbol && (await isTickerGloballyReserved(symbol))) {
      await interaction.editReply(`❌ ${await formatGlobalTickerCooldownMessage(symbol)}`);
      return;
    }

    let imageUrl = parseOptionalHttpUrl(imageInput) || importImageUrl;
    if (imageInput && imageInput.length > 0 && !parseOptionalHttpUrl(imageInput)) {
      await interaction.editReply('❌ Image must be a valid http(s) URL, or leave the option empty.');
      return;
    }

    if (imageAttachment) {
      const ct = imageAttachment.contentType ?? '';
      if (!ct.startsWith('image/')) {
        await interaction.editReply('❌ Uploaded file must be an image (PNG, JPG, WebP, GIF, etc.).');
        return;
      }
      imageUrl = imageAttachment.url;
    }

    const resolvedImageUrl =
      imageUrl || interaction.user.displayAvatarURL({ size: 256, extension: 'png' });

    const resolvedChain = config.ethereum.deployEnabled
      ? resolveDeployChain({ explicit: interaction.options.getString('chain', true) })
      : 'base';

    const catalogPrivy = deployerPrivyUserId ?? privyUserIdForDiscord;
    const rateLimitBurnPreview = await applyDeployRateLimitBurn({
      walletAddress: wallet,
      feeRecipientLabel,
      feeToSelf: feeToSelfForDeploy === true,
      platform: 'discord',
      deployerId: interaction.user.id,
      privyUserId: catalogPrivy ?? null,
    });
    const params: TokenDeploymentParams = {
      name: name!,
      symbol: symbol!,
      walletAddress: wallet,
      devBuyAmount: config.deployBondWei,
      hookType: 'static',
      imageUrl: resolvedImageUrl,
      feeToSelf: feeToSelfForDeploy,
      chain: resolvedChain,
      ...(description ? { description } : {}),
      ...(feeRecipientLabel ? { feeRecipientLabel } : {}),
      ...(catalogPrivy ? { privyUserId: catalogPrivy } : {}),
    };
    this.pendingDeployByUser.set(interaction.user.id, params);

    const rollingH = deployRateLimitRollingHours();
    const selfFeeTokens = await listSelfFeeTokensForFeeRecipient(wallet, 6);
    const thirdPartyRecent =
      rollingH > 0
        ? await listThirdPartyFeeTokensForFeeRecipientRollingHours(wallet, rollingH, 6)
        : [];

    const embed = new EmbedBuilder()
      .setTitle('🚀 Confirm Deployment')
      .setDescription(`User: **${interaction.user.username}**`)
      .addFields(
        { name: 'Name', value: name!, inline: true },
        { name: 'Symbol', value: symbol!, inline: true },
        {
          name: 'Chain',
          value: resolvedChain === 'ethereum' ? 'Ethereum' : 'Base',
          inline: true,
        },
        {
          name: 'Fee wallet',
          value: feeRecipientLabel ? `${feeRecipientLabel}\n\`${wallet}\`` : `\`${wallet}\``,
          inline: false,
        },
        {
          name: 'Deploy bond',
          value: `${formatEther(config.deployBondWei)} ETH (launcher wallet — not your fee wallet)`,
          inline: false,
        }
      )
      .setColor(0xff6600);

    if (rateLimitBurnPreview.rateLimitForcedBurn) {
      embed.addFields({
        name: '🚨 Deploy limit reached',
        value: DEPLOY_LIMIT_MEME_PROCEED_USER_NOTICE,
        inline: false,
      });
    }

    const fmtDiscord = (t: { tokenName: string; tokenSymbol: string; tokenAddress: string }) =>
      `• **${t.tokenName}** ($${t.tokenSymbol})\n  \`${t.tokenAddress}\``;

    if (selfFeeTokens.length > 0) {
      embed.addFields({
        name: `⚠️ Tokens this wallet already launched (${selfFeeTokens.length})`,
        value: selfFeeTokens.map(fmtDiscord).join('\n').slice(0, 1024),
        inline: false,
      });
    }
    if (thirdPartyRecent.length > 0) {
      embed.addFields({
        name: `⚠️ Others launched for this wallet (last ${rollingH}h) (${thirdPartyRecent.length})`,
        value: thirdPartyRecent.map(fmtDiscord).join('\n').slice(0, 1024),
        inline: false,
      });
      embed.addFields({
        name: '🚨 If you deploy now',
        value: thirdPartyRollingWindowDeployWarnUserMessage(rollingH),
        inline: false,
      });
    }

    if (description) {
      embed.addFields({
        name: 'Description',
        value: description.length > 1024 ? `${description.slice(0, 1021)}…` : description,
        inline: false,
      });
    }
    embed.setImage(resolvedImageUrl);
    
    const row = new ActionRowBuilder()
      .addComponents(
        new ButtonBuilder()
          .setCustomId('deploy_confirm')
          .setLabel('✅ Deploy')
          .setStyle(ButtonStyle.Success),
        new ButtonBuilder()
          .setCustomId('deploy_cancel')
          .setLabel('❌ Cancel')
          .setStyle(ButtonStyle.Danger)
      );
    
    const confirmMessage = (await interaction.editReply({
      embeds: [embed],
      components: [row as any],
    })) as Message;

    // Ephemeral slash replies are not reliably picked up by `channel.createMessageComponentCollector`.
    // Collect on the edited message so Deploy / Cancel always fire.
    const collector = confirmMessage.createMessageComponentCollector({
      filter: (btn: MessageComponentInteraction) => btn.user.id === interaction.user.id,
      time: 60_000,
    });

    collector.on('collect', async (i: MessageComponentInteraction) => {
      if (i.customId === 'deploy_cancel') {
        this.pendingDeployByUser.delete(i.user.id);
        await i.update({
          content: '❌ Deployment cancelled.',
          embeds: [],
          components: []
        });
        collector.stop();
        return;
      }
      
      if (i.customId === 'deploy_confirm') {
        const pending = this.pendingDeployByUser.get(i.user.id);
        if (!pending) {
          await i.reply({ content: '❌ Session expired. Run /deploy again.', flags: MessageFlags.Ephemeral });
          collector.stop();
          return;
        }
        const pendingChain = pending.chain ?? 'base';
        this.pendingDeployByUser.delete(i.user.id);

        await i.update({
          content: '🚀 Deploying token...',
          embeds: [],
          components: []
        });
        
        try {
          const baseDesc = pending.description
            ? `${pending.description} | Deployed by Discord @${i.user.username}`
            : `Deployed by Discord @${i.user.username}`;
          const limited = await applyDeployRateLimitBurn({
            walletAddress: pending.walletAddress,
            feeRecipientLabel: pending.feeRecipientLabel,
            feeToSelf: pending.feeToSelf === true,
            platform: 'discord',
            deployerId: i.user.id,
            privyUserId: pending.privyUserId ?? null,
          });
          const withMeme =
            isNoDevOrForcedBurnFeeLabel(pending.feeRecipientLabel) ||
            limited.rateLimitForcedBurn
              ? `${baseDesc}\n\n${MEME_TOKEN_DESCRIPTION_TAGLINE}`
              : baseDesc;
          const feeCd = await thirdPartyFeeRecipientCooldownErrorOrNull(limited.walletAddress, {
            feeToSelf: limited.feeToSelf,
            rateLimitForcedBurn: limited.rateLimitForcedBurn,
            feeRecipientLabel: limited.feeRecipientLabel ?? pending.feeRecipientLabel,
          });
          if (feeCd) {
            await i.followUp({ content: `❌ ${feeCd}`, flags: MessageFlags.Ephemeral });
            return;
          }
          const result = await this.deployer.deployToken({
            ...(pending as TokenDeploymentParams),
            walletAddress: limited.walletAddress,
            description: withMeme,
            username: i.user.username,
            platform: 'discord',
            deployerId: i.user.id,
            deployerLabel: `@${i.user.username}`,
            devBuyAmount: config.deployBondWei,
            ...(limited.feeRecipientLabel ?? pending.feeRecipientLabel
              ? {
                  feeRecipientLabel:
                    limited.feeRecipientLabel ?? pending.feeRecipientLabel,
                }
              : {}),
            feeToSelf: limited.feeToSelf,
          });
          
          const links = this.deployer.generateTokenLinks(result.tokenAddress, result.chain);
          const scanLabel = result.chain === 'ethereum' ? 'Etherscan' : 'BaseScan';
          
          // Get wallet claim URL for Privy
          let walletClaimField = {
            name: 'Fee Wallet',
            value: `\`${limited.walletAddress}\``,
            inline: false,
          };
          if (config.privy.enabled && config.features.usePrivyWallets) {
            const { claimUrl, isNew } =
              (await getWalletForUser(
                'discord',
                i.user.id,
                i.user.username,
                i.user.discriminator ?? '0',
              )) || {};
            if (claimUrl) {
              const walletStatus = isNew ? '✅ New wallet created!' : '💳 Using existing wallet';
              walletClaimField = { 
                name: 'Fee Wallet', 
                value: `${walletStatus}\nAddress: \`${limited.walletAddress}\`\n🔍 [View on BaseScan](${claimUrl})`, 
                inline: false 
              };
            }
          }
          
          const successEmbed = new EmbedBuilder()
            .setTitle('🎉 Token Deployed!')
            .setDescription(`${pending.name} ($${pending.symbol})`)
            .addFields(
              { name: 'User', value: `**${i.user.username}**`, inline: true },
              { name: 'Token', value: `\`${result.tokenAddress}\``, inline: false },
              { name: 'Pool ID', value: `\`${result.poolId}\``, inline: false },
              walletClaimField,
              { name: 'Links', value: `[${scanLabel}](${links.explorer}) | [DexScreener](${links.dexscreener}) | [Uniswap swap](${links.uniswapSwap}) | [Uniswap token](${links.uniswap}) | [Liquid](${links.liquid}) | [Trade in Launcher](${links.launcherInAppSwap}) | [Launches](${links.launcherApp})`, inline: false }
            )
            .setColor(0x00ff00)
            .setTimestamp();
          
          await i.followUp({
            embeds: [successEmbed],
          });
          
          // Post to launcher feed channel if configured
          if (config.discord.feedChannelId) {
            try {
              const feedChannel = await this.client?.channels.fetch(config.discord.feedChannelId);
              if (feedChannel && 'send' in feedChannel) {
                await feedChannel.send({ embeds: [successEmbed] });
              }
            } catch (error: any) {
              logger.warn('Failed to post to feed channel:', error.message);
            }
          }
          
        } catch (error: any) {
          const errorMsg = formatDeployError(error);
          logger.error('Discord /deploy failed', {
            error: errorMsg,
            chain: pendingChain,
            user: i.user?.id,
            stack: error instanceof Error ? error.stack : undefined,
          });
          // Discord has 2000 char limit - truncate if needed
          const truncatedMsg = errorMsg.length > 1900 
            ? errorMsg.slice(0, 1897) + '...' 
            : errorMsg;
          
          await i.followUp({
            content: `❌ Deployment failed: ${truncatedMsg}`,
            flags: MessageFlags.Ephemeral,
          });
          
          // Post error to debug channel if configured
          if (config.discord.debugChannelId) {
            try {
              const debugChannel = await this.client?.channels.fetch(config.discord.debugChannelId);
              if (debugChannel && 'send' in debugChannel) {
                const debugEmbed = new EmbedBuilder()
                  .setTitle('❌ Deployment Error')
                  .setDescription(truncatedMsg)
                  .addFields(
                    { name: 'User', value: `${i.user.username}`, inline: true },
                    { name: 'Chain', value: pendingChain, inline: true },
                    { name: 'Time', value: new Date().toISOString(), inline: true }
                  )
                  .setColor(0xff0000)
                  .setTimestamp();
                await debugChannel.send({ embeds: [debugEmbed] });
              }
            } catch (error: any) {
              logger.warn('Failed to post to debug channel:', error.message);
            }
          }
        }
        
        collector.stop();
      }
    });
  }
  
  private async handleClaim(interaction: any): Promise<void> {
    await interaction.deferReply({ flags: MessageFlags.Ephemeral });

    const raw = interaction.options.getString('token')?.trim() ?? '';
    let tokenAddress: string | undefined;
    let tokenSymbol: string | undefined;
    if (/^0x[a-fA-F0-9]{40}$/.test(raw)) {
      tokenAddress = raw;
    } else {
      tokenSymbol = raw.replace(/^\$/u, '').trim();
    }

    if (!tokenAddress && !tokenSymbol) {
      await interaction.editReply('❌ Pass a token contract (0x…) or a ticker.');
      return;
    }

    const pw = await getWalletForUser(
      'discord',
      interaction.user.id,
      interaction.user.username,
      interaction.user.discriminator ?? '0',
    );
    if (!pw?.address) {
      await interaction.editReply(
        '❌ Could not resolve your Privy fee wallet. Check Privy Discord login and server configuration.',
      );
      return;
    }

    const result = await runSocialTradingFeesClaim({
      platform: 'discord',
      deployerId: interaction.user.id,
      feeRecipientAddress: pw.address,
      tokenAddress,
      tokenSymbol,
    });

    if (!result.ok) {
      await interaction.editReply(`❌ ${result.message}`);
      return;
    }

    await interaction.editReply(
      `✅ Claimed **${result.feeAmountHuman}** ETH (WETH) trading fees.\n${result.basescanUrl}`,
    );
  }

  private async handleHelp(interaction: any): Promise<void> {
    const embed = new EmbedBuilder()
      .setTitle('🤖 Liquid Launcher')
      .setDescription('Deploy tokens on Base with Uniswap V4 pools')
      .addFields(
        {
          name: '/deploy',
          value:
            config.ethereum.deployEnabled
              ? 'Deploy a new token\n`/deploy chain:…` then **name** + **symbol**, or use **source_url** alone (X/GitHub/Warpcast/t.me/Discord — same as website).\nOptional: `name`, `symbol`, `wallet`, `fee_recipient`, `description`, `image`, `source_url`, `image_file`'
              : 'Deploy a new token\n**name** + **symbol**, or **source_url** only (X/GitHub/Warpcast/t.me/Discord — same importer as the website).\nOptional: `fee_recipient`, `wallet`, `description`, `image`, `source_url`, `image_file`',
          inline: false,
        },
        {
          name: '/claim',
          value:
            'Claim WETH trading fees for a token you deployed from Discord (same account + fee wallet as deploy).\n`/claim token:0x…` or `/claim token:PEPE`',
          inline: false,
        },
        {
          name: '/balance · /portfolio',
          value:
            '**`/balance`** — Base ETH + other tokens when available (optional `token` = ERC-20 `0x…`). **`/portfolio`** — holdings summary. Same as typing `balance` / `portfolio` in Telegram.',
          inline: false,
        },
        {
          name: '/ai · /ask',
          value:
            'Ask the assistant (markets, wallet, delegated swaps). Example: `/ai prompt:What is my ETH?` — or **`/ask`** with the same `prompt` option. In channels where the bot can read messages, you can also send a normal message: `/ai your question` (like Telegram).',
          inline: false,
        },
        {
          name: 'Trade (chat)',
          value:
            '**`buy 0x…`** / **`sell 0x…`** in a channel (same as Telegram). Requires **Message Content Intent** enabled for the bot in the Discord Developer Portal; otherwise the bot never sees your text — use slash **`/balance`** above and open the swap link from **`/ai`** if needed.',
          inline: false,
        },
        {
          name: 'Parameters',
          value:
            '• **name** + **symbol**, or **source_url** (fills name/symbol/description/image + default fees like the site)\n• **fee_recipient** optional — omit with **source_url** = fees to imported author; **`me`** = your wallet; **`meme`** / **`no dev`**; or **0x** / social URL\n• **wallet** optional legacy 0x override\n\nDeploy bond is paid from the launcher wallet.',
          inline: false,
        }
      )
      .setColor(0x0099ff);
    
    await interaction.reply({ embeds: [embed], flags: MessageFlags.Ephemeral });
  }
}
