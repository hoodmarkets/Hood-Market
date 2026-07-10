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
  Interaction,
  TextChannel,
  Message
} from 'discord.js';
import { CommandContext, TokenConfig, Platform } from '../types';
import { WalletManager } from '../services/wallet-manager';
import { LiquidDeployer } from '../services/liquid-deployer';
import { config } from '../config/config';
import { Logger } from 'winston';
import { formatEther } from 'viem';
import { parseOptionalHttpUrl } from '../lib/url.js';

export class DiscordHandler {
  private client: Client;
  private walletManager: WalletManager;
  private deployer: LiquidDeployer;
  private logger: Logger;
  private userSessions: Map<string, any> = new Map();

  constructor(
    walletManager: WalletManager,
    deployer: LiquidDeployer,
    logger: Logger
  ) {
    this.walletManager = walletManager;
    this.deployer = deployer;
    this.logger = logger;

    if (!config.discord.token) {
      throw new Error('Discord token not configured');
    }

    this.client = new Client({
      intents: [
        GatewayIntentBits.Guilds,
        GatewayIntentBits.GuildMessages,
        GatewayIntentBits.MessageContent,
        GatewayIntentBits.DirectMessages,
      ]
    });

    this.setupHandlers();
  }

  async initialize(): Promise<void> {
    // Register slash commands
    await this.registerCommands();
    
    // Login
    await this.client.login(config.discord.token);
    this.logger.info('Discord bot initialized');
  }

  private async registerCommands(): Promise<void> {
    const commands = [
      new SlashCommandBuilder()
        .setName('wallet')
        .setDescription('Create or view your wallet'),
      new SlashCommandBuilder()
        .setName('balance')
        .setDescription('Check your ETH balance'),
      new SlashCommandBuilder()
        .setName('launch')
        .setDescription('Quick launch a token')
        .addStringOption(option =>
          option.setName('name')
            .setDescription('Token name')
            .setRequired(true))
        .addStringOption(option =>
          option.setName('symbol')
            .setDescription('Token symbol')
            .setRequired(true))
        .addStringOption(option =>
          option.setName('description')
            .setDescription('Description (optional)')
            .setRequired(false)
            .setMaxLength(500))
        .addStringOption(option =>
          option.setName('image')
            .setDescription('Image URL https://... (optional)')
            .setRequired(false)
            .setMaxLength(2048)),
      new SlashCommandBuilder()
        .setName('deploy')
        .setDescription('Interactive deployment wizard'),
      new SlashCommandBuilder()
        .setName('history')
        .setDescription('View your deployments'),
      new SlashCommandBuilder()
        .setName('help')
        .setDescription('Show help information'),
    ].map(command => command.toJSON());

    const rest = new REST({ version: '10' }).setToken(config.discord.token);

    try {
      await rest.put(
        Routes.applicationCommands(config.discord.clientId),
        { body: commands }
      );
      this.logger.info('Discord slash commands registered');
    } catch (error) {
      this.logger.error('Failed to register Discord commands', { error });
    }
  }

  private setupHandlers(): void {
    this.client.on('clientReady', () => {
      this.logger.info(`Discord bot logged in as ${this.client.user?.tag}`);
    });

    this.client.on('interactionCreate', this.handleInteraction.bind(this));
  }

  private async handleInteraction(interaction: Interaction): Promise<void> {
    if (!interaction.isCommand() && !interaction.isButton()) return;

    const userId = interaction.user.id;

    try {
      if (interaction.isCommand()) {
        switch (interaction.commandName) {
          case 'wallet':
            await this.handleWallet(interaction);
            break;
          case 'balance':
            await this.handleBalance(interaction);
            break;
          case 'launch':
            await this.handleLaunch(interaction);
            break;
          case 'deploy':
            await this.handleDeployWizard(interaction);
            break;
          case 'history':
            await this.handleHistory(interaction);
            break;
          case 'help':
            await this.handleHelp(interaction);
            break;
        }
      } else if (interaction.isButton()) {
        await this.handleButton(interaction);
      }
    } catch (error: any) {
      this.logger.error('Discord interaction failed', { error: error.message, userId });
      
      if (interaction.isRepliable()) {
        await interaction.reply({
          content: `❌ Error: ${error.message}`,
          ephemeral: true
        }).catch(() => {});
      }
    }
  }

  private async handleWallet(interaction: any): Promise<void> {
    await interaction.deferReply({ ephemeral: true });

    const userId = interaction.user.id;

    try {
      let wallet = await this.walletManager.getWallet(userId, 'discord');
      
      if (!wallet) {
        wallet = await this.walletManager.createWallet(userId, 'discord');

        const embed = new EmbedBuilder()
          .setTitle('✅ New Wallet Created!')
          .setDescription(`Your wallet has been created and is ready for token deployment.`)
          .addFields(
            { name: 'Address', value: `\`${wallet.address}\``, inline: false },
            { name: 'Next Steps', value: 'Send Base ETH to this address to deploy tokens.', inline: false }
          )
          .setColor(0x00ff00)
          .setTimestamp();

        await interaction.editReply({ embeds: [embed] });
      } else {
        const balance = await this.walletManager.getBalance(userId, 'discord');

        const embed = new EmbedBuilder()
          .setTitle('👛 Your Wallet')
          .addFields(
            { name: 'Address', value: `\`${wallet.address}\``, inline: false },
            { name: 'Balance', value: `${formatEther(balance.eth)} ETH`, inline: true },
            { name: 'Network', value: 'Base', inline: true }
          )
          .setColor(0x0099ff)
          .setTimestamp();

        await interaction.editReply({ embeds: [embed] });
      }
    } catch (error: any) {
      await interaction.editReply({ content: `❌ Error: ${error.message}` });
    }
  }

  private async handleBalance(interaction: any): Promise<void> {
    await interaction.deferReply({ ephemeral: true });

    const userId = interaction.user.id;

    try {
      const balance = await this.walletManager.getBalance(userId, 'discord');

      const embed = new EmbedBuilder()
        .setTitle('💰 Wallet Balance')
        .addFields(
          { name: 'ETH Balance', value: `${formatEther(balance.eth)} ETH`, inline: true },
          { name: 'Address', value: `\`${balance.address}\``, inline: false }
        )
        .setColor(0xf1c40f)
        .setTimestamp();

      await interaction.editReply({ embeds: [embed] });
    } catch (error: any) {
      await interaction.editReply({ content: `❌ Error: ${error.message}` });
    }
  }

  private async handleLaunch(interaction: any): Promise<void> {
    const userId = interaction.user.id;
    const name = interaction.options.getString('name');
    const symbol = interaction.options.getString('symbol');
    const description = interaction.options.getString('description')?.trim();
    const imageRaw = interaction.options.getString('image')?.trim() ?? '';

    try {
      if (name!.length < 2 || name!.length > 32) {
        throw new Error('Token name must be 2-32 characters');
      }
      if (symbol!.length < 2 || symbol!.length > 10) {
        throw new Error('Symbol must be 2-10 characters');
      }

      const imageUrl = parseOptionalHttpUrl(imageRaw);
      if (imageRaw && !imageUrl) {
        throw new Error('Image must be a valid http(s) URL, or omit the option');
      }

      const bond = config.deployBondWei;
      const wallet = await this.walletManager.getOrCreateWallet(userId, 'discord');
      const balance = await this.walletManager.getBalance(userId, 'discord');

      if (balance.eth < bond) {
        await interaction.reply({
          content: `❌ Insufficient balance. You have ${formatEther(balance.eth)} ETH; need at least ${formatEther(bond)} ETH for deploy.\n\nSend Base ETH to: \`${wallet.address}\``,
          ephemeral: true
        });
        return;
      }

      const tokenConfig: TokenConfig = {
        name: name!,
        symbol: symbol!.toUpperCase(),
        devBuyAmount: bond,
        hookType: 'dynamic',
      };
      if (description || imageUrl) {
        tokenConfig.metadata = {};
        if (description) tokenConfig.metadata.description = description;
        if (imageUrl) tokenConfig.metadata.image = imageUrl;
      }

      this.userSessions.set(userId, {
        tokenConfig,
        step: 'confirming_launch',
      });

      const embed = new EmbedBuilder()
        .setTitle('🚀 Confirm Token Launch')
        .addFields(
          { name: 'Name', value: name!, inline: true },
          { name: 'Symbol', value: symbol!.toUpperCase(), inline: true },
          {
            name: 'Deploy bond',
            value: `${formatEther(bond)} ETH (from your launcher wallet)`,
            inline: false,
          },
          { name: 'From', value: `\`${wallet.address}\``, inline: false }
        )
        .setColor(0xff6600)
        .setTimestamp();

      if (description) {
        embed.addFields({
          name: 'Description',
          value: description.length > 1024 ? `${description.slice(0, 1021)}…` : description,
          inline: false,
        });
      }
      if (imageUrl) {
        embed.setImage(imageUrl);
      }

      const row = new ActionRowBuilder()
        .addComponents(
          new ButtonBuilder()
            .setCustomId('confirm_launch_deploy')
            .setLabel('✅ Deploy')
            .setStyle(ButtonStyle.Success),
          new ButtonBuilder()
            .setCustomId('cancel_launch')
            .setLabel('❌ Cancel')
            .setStyle(ButtonStyle.Danger)
        );

      await interaction.reply({
        embeds: [embed],
        components: [row as any],
        ephemeral: true
      });

    } catch (error: any) {
      await interaction.reply({
        content: `❌ Error: ${error.message}`,
        ephemeral: true
      });
    }
  }

  private async handleDeployWizard(interaction: any): Promise<void> {
    const userId = interaction.user.id;

    // Initialize session
    this.userSessions.set(userId, {
      step: 1,
      config: {}
    });

    const embed = new EmbedBuilder()
      .setTitle('🧙‍♂️ Token Deployment Wizard')
      .setDescription('Step 1/5: What is the token name? (2-32 characters)\n\nReply with your answer.')
      .setColor(0x9b59b6);

    await interaction.reply({
      embeds: [embed],
      ephemeral: true
    });

    const filter = (m: Message) => m.author.id === userId;
    const collector = (interaction.channel as TextChannel).createMessageCollector({
      filter,
      time: 300000,
      max: 4,
    });

    let step = 1;

    collector.on('collect', async (message) => {
      const session = this.userSessions.get(userId);
      if (!session) {
        collector.stop();
        return;
      }

      const text = message.content.trim();

      try {
        switch (step) {
          case 1:
            if (text.length < 2 || text.length > 32) {
              await interaction.followUp({
                content: '❌ Name must be 2-32 characters. Try again:',
                ephemeral: true
              });
              return;
            }
            session.config.name = text;
            step = 2;
            await interaction.followUp({
              content: 'Step 2/5: What is the token symbol? (2-10 characters)',
              ephemeral: true
            });
            break;

          case 2:
            if (text.length < 2 || text.length > 10) {
              await interaction.followUp({
                content: '❌ Symbol must be 2-10 characters. Try again:',
                ephemeral: true
              });
              return;
            }
            session.config.symbol = text.toUpperCase();
            step = 3;
            await interaction.followUp({
              content: 'Step 3/5: Description? (optional — reply `skip` to skip)',
              ephemeral: true
            });
            break;

          case 3:
            session.config.description =
              text.toLowerCase() === 'skip' ? undefined : text;
            step = 4;
            await interaction.followUp({
              content: 'Step 4/5: Image URL (https://… for token art)? Reply `skip` to skip.',
              ephemeral: true
            });
            break;

          case 4: {
            const skip = text.length === 0 || text.toLowerCase() === 'skip';
            const url = skip ? undefined : parseOptionalHttpUrl(text);
            if (!skip && !url) {
              await interaction.followUp({
                content: '❌ Must be a valid http(s) URL or `skip`. Try again:',
                ephemeral: true
              });
              return;
            }
            session.config.imageUrl = url;
            step = 5;

            const row = new ActionRowBuilder()
              .addComponents(
                new ButtonBuilder()
                  .setCustomId('wizard_hook_dynamic')
                  .setLabel('⚡ Dynamic Fee')
                  .setStyle(ButtonStyle.Primary),
                new ButtonBuilder()
                  .setCustomId('wizard_hook_static')
                  .setLabel('📊 Static Fee')
                  .setStyle(ButtonStyle.Secondary)
              );

            await interaction.followUp({
              content: 'Step 5/5: Choose hook type:',
              components: [row as any],
              ephemeral: true
            });
            collector.stop();
            break;
          }
        }
      } catch (error: any) {
        await interaction.followUp({
          content: `❌ Error: ${error.message}`,
          ephemeral: true
        });
        collector.stop();
        this.userSessions.delete(userId);
      }
    });

    collector.on('end', () => {
      if (step < 5) {
        this.userSessions.delete(userId);
      }
    });
  }

  private async handleButton(interaction: any): Promise<void> {
    const userId = interaction.user.id;
    const customId = interaction.customId;

    try {
      if (customId === 'confirm_launch_deploy') {
        await interaction.deferUpdate();

        const session = this.userSessions.get(userId);
        const tokenConfig = session?.tokenConfig as TokenConfig | undefined;
        if (!tokenConfig) {
          await interaction.followUp({
            content: '❌ Session expired. Run /launch again.',
            ephemeral: true
          });
          return;
        }

        await this.executeDeployment(interaction, userId, tokenConfig);
        this.userSessions.delete(userId);

      } else if (customId === 'cancel_launch') {
        await interaction.update({
          content: '❌ Deployment cancelled.',
          embeds: [],
          components: []
        });
        this.userSessions.delete(userId);

      } else if (customId === 'wizard_hook_dynamic' || customId === 'wizard_hook_static') {
        const session = this.userSessions.get(userId);
        if (session) {
          session.config.hookType = customId === 'wizard_hook_dynamic' ? 'dynamic' : 'static';

          const bond = config.deployBondWei;
          const summaryEmbed = new EmbedBuilder()
            .setTitle('📋 Deployment Summary')
            .addFields(
              { name: 'Name', value: session.config.name, inline: true },
              { name: 'Symbol', value: session.config.symbol, inline: true },
              {
                name: 'Deploy bond',
                value: `${formatEther(bond)} ETH (from your wallet)`,
                inline: false,
              },
              { name: 'Hook', value: session.config.hookType === 'dynamic' ? 'Dynamic Fee' : 'Static Fee', inline: true }
            )
            .setColor(0x3498db);

          if (session.config.description) {
            summaryEmbed.addFields({
              name: 'Description',
              value:
                session.config.description.length > 1024
                  ? `${session.config.description.slice(0, 1021)}…`
                  : session.config.description,
              inline: false,
            });
          }
          if (session.config.imageUrl) {
            summaryEmbed.setImage(session.config.imageUrl);
          }
          
          const row = new ActionRowBuilder()
            .addComponents(
              new ButtonBuilder()
                .setCustomId('wizard_confirm')
                .setLabel('✅ Deploy Token')
                .setStyle(ButtonStyle.Success),
              new ButtonBuilder()
                .setCustomId('wizard_cancel')
                .setLabel('❌ Cancel')
                .setStyle(ButtonStyle.Danger)
            );
          
          await interaction.update({
            content: 'Step 5/5: Ready to deploy?',
            embeds: [summaryEmbed],
            components: [row as any]
          });
        }

      } else if (customId === 'wizard_confirm') {
        await interaction.deferUpdate();
        
        const session = this.userSessions.get(userId);
        if (session?.config?.name && session.config.symbol && session.config.hookType) {
          const c = session.config;
          const tokenConfig: TokenConfig = {
            name: c.name,
            symbol: c.symbol,
            devBuyAmount: config.deployBondWei,
            hookType: c.hookType,
          };
          if (c.description || c.imageUrl) {
            tokenConfig.metadata = {};
            if (c.description) tokenConfig.metadata.description = c.description;
            if (c.imageUrl) tokenConfig.metadata.image = c.imageUrl;
          }
          await this.executeDeployment(interaction, userId, tokenConfig);
          this.userSessions.delete(userId);
        }

      } else if (customId === 'wizard_cancel') {
        await interaction.update({
          content: '❌ Deployment cancelled.',
          embeds: [],
          components: []
        });
        this.userSessions.delete(userId);
      }

    } catch (error: any) {
      this.logger.error('Discord button handler failed', { error: error.message, customId });
      await interaction.followUp({
        content: `❌ Error: ${error.message}`,
        ephemeral: true
      });
    }
  }

  private async executeDeployment(
    interaction: any,
    userId: string,
    tokenConfig: TokenConfig
  ): Promise<void> {
    try {
      const { client, wallet } = await this.walletManager.getWalletClient(userId, 'discord');
      
      const processingEmbed = new EmbedBuilder()
        .setTitle('🚀 Deploying Token...')
        .setDescription('Please wait while your token is being deployed on Base.')
        .setColor(0xffa500);

      await interaction.editReply({
        embeds: [processingEmbed],
        components: []
      });

      const result = await this.deployer.deployToken(
        wallet,
        client,
        tokenConfig,
        'discord'
      );

      const links = this.deployer.generateTokenLinks(result.tokenAddress, result.poolId);

      const successEmbed = new EmbedBuilder()
        .setTitle('🎉 Token Deployed Successfully!')
        .setDescription(`**${tokenConfig.name}** ($${tokenConfig.symbol})`)
        .addFields(
          { name: 'Token Address', value: `\`${result.tokenAddress}\``, inline: false },
          { name: 'Pool ID', value: `\`${result.poolId}\``, inline: false },
          { name: 'Links', value: `[BaseScan](${links.basescan}) | [DexScreener](${links.dexscreener}) | [Uniswap swap](${links.uniswapSwap}) | [Uniswap token](${links.uniswap}) | [Trade in Launcher](${links.launcherInAppSwap}) | [Launches](${links.launcherApp})`, inline: false },
          { name: 'Transaction', value: `[View on BaseScan](https://basescan.org/tx/${result.transactionHash})`, inline: false }
        )
        .setColor(0x00ff00)
        .setTimestamp();

      await interaction.editReply({
        embeds: [successEmbed],
        components: []
      });

    } catch (error: any) {
      this.logger.error('Discord deployment failed', { error: error.message, userId });
      
      const errorEmbed = new EmbedBuilder()
        .setTitle('❌ Deployment Failed')
        .setDescription(error.message)
        .setColor(0xff0000);

      await interaction.editReply({
        embeds: [errorEmbed],
        components: []
      });
    }
  }

  private async handleHistory(interaction: any): Promise<void> {
    await interaction.deferReply({ ephemeral: true });

    const userId = interaction.user.id;

    try {
      const deployments = await this.deployer.getDeployments(userId, 10);

      if (deployments.length === 0) {
        await interaction.editReply({
          content: '📭 No deployments found. Use /launch to deploy your first token!'
        });
        return;
      }

      const embed = new EmbedBuilder()
        .setTitle('📊 Your Recent Deployments')
        .setColor(0x3498db);

      deployments.forEach((dep, i) => {
        const status = dep.status === 'success' ? '✅' : dep.status === 'pending' ? '⏳' : '❌';
        const date = new Date(dep.createdAt).toLocaleDateString();
        
        embed.addFields({
          name: `${i + 1}. ${status} ${dep.tokenConfig.name} ($${dep.tokenConfig.symbol})`,
          value: `${date} | [View](https://basescan.org/tx/${dep.result.transactionHash})`,
          inline: false
        });
      });

      await interaction.editReply({ embeds: [embed] });

    } catch (error: any) {
      await interaction.editReply({ content: `❌ Error: ${error.message}` });
    }
  }

  private async handleHelp(interaction: any): Promise<void> {
    const embed = new EmbedBuilder()
      .setTitle('🤖 Liquid Launcher Commands')
      .setDescription('Deploy tokens on Base with Uniswap V4 pools and locked liquidity.')
      .addFields(
        { name: '/wallet', value: 'Create or view your wallet', inline: true },
        { name: '/balance', value: 'Check your ETH balance', inline: true },
        { name: '/launch', value: 'Quick launch: `/launch NAME SYMBOL` + optional description & image', inline: false },
        { name: '/deploy', value: 'Interactive deployment wizard', inline: true },
        { name: '/history', value: 'View your past deployments', inline: true }
      )
      .addFields({
        name: 'Example',
        value: '`/launch ANAL AnalToken`',
        inline: false
      })
      .setFooter({ text: 'All tokens deploy on Base with 100B supply, locked LP, and MEV protection' })
      .setColor(0x0099ff);

    await interaction.reply({ embeds: [embed], ephemeral: true });
  }
}
