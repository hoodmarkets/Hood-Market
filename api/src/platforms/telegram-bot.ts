import TelegramBot from 'node-telegram-bot-api';
import { CommandContext, TokenConfig, Platform } from '../types';
import { WalletManager } from '../services/wallet-manager';
import { LiquidDeployer } from '../services/liquid-deployer';
import { config } from '../config/config';
import { Logger } from 'winston';
import { parseEther, formatEther } from 'viem';

export class TelegramHandler {
  private bot: TelegramBot;
  private walletManager: WalletManager;
  private deployer: LiquidDeployer;
  private logger: Logger;
  private userSessions: Map<number, any> = new Map();

  constructor(
    walletManager: WalletManager,
    deployer: LiquidDeployer,
    logger: Logger
  ) {
    this.walletManager = walletManager;
    this.deployer = deployer;
    this.logger = logger;

    if (!config.telegram.botToken) {
      throw new Error('Telegram bot token not configured');
    }

    this.bot = new TelegramBot(config.telegram.botToken, { polling: true });
    this.setupHandlers();
  }

  private setupHandlers(): void {
    // Start command
    this.bot.onText(/\/start/, this.handleStart.bind(this));
    
    // Wallet commands
    this.bot.onText(/\/wallet/, this.handleWallet.bind(this));
    this.bot.onText(/\/balance/, this.handleBalance.bind(this));
    
    // Launch commands
    this.bot.onText(/\/launch(?:\s+(\S+)\s+(\S+)\s+(\S+))?/, this.handleLaunch.bind(this));
    this.bot.onText(/\/deploy/, this.handleDeployWizard.bind(this));
    
    // History
    this.bot.onText(/\/history/, this.handleHistory.bind(this));
    this.bot.onText(/\/help/, this.handleHelp.bind(this));

    // Handle callback queries for buttons
    this.bot.on('callback_query', this.handleCallback.bind(this));

    this.logger.info('Telegram bot initialized');
  }

  private async handleStart(msg: TelegramBot.Message): Promise<void> {
    const chatId = msg.chat.id;
    const userId = msg.from?.id.toString() || '';
    const username = msg.from?.username || 'unknown';

    this.logger.info('User started bot', { platform: 'telegram', userId, username });

    const welcome = `
🚀 *Welcome to Liquid Launcher!*

Deploy tokens on Base with Uniswap V4 liquidity pools, locked LP, and MEV protection.

*Quick Commands:*
/wallet - Create or view your wallet
/balance - Check your ETH balance
/launch NAME SYMBOL ETH_AMOUNT - Quick launch
/deploy - Interactive deployment wizard
/history - View your deployments
/help - Show all commands

*Example:*
\`/launch ANAL AnalToken 0.1\`

Need ETH on Base? Bridge from Ethereum or buy directly on Base.
    `;

    await this.bot.sendMessage(chatId, welcome, { parse_mode: 'Markdown' });
  }

  private async handleWallet(msg: TelegramBot.Message): Promise<void> {
    const chatId = msg.chat.id;
    const userId = msg.from?.id.toString() || '';

    try {
      let wallet = await this.walletManager.getWallet(userId, 'telegram');
      
      if (!wallet) {
        wallet = await this.walletManager.createWallet(userId, 'telegram');
        
        const message = `
✅ *New Wallet Created!*

Address: \`${wallet.address}\`

*IMPORTANT:* Send Base ETH to this address to deploy tokens.

Your private key is encrypted and secure. Never share it with anyone.
        `;
        
        await this.bot.sendMessage(chatId, message, { parse_mode: 'Markdown' });
      } else {
        const balance = await this.walletManager.getBalance(userId, 'telegram');
        
        const message = `
👛 *Your Wallet*

Address: \`${wallet.address}\`
Balance: ${formatEther(balance.eth)} ETH

Send Base ETH to this address to deploy tokens.
        `;
        
        await this.bot.sendMessage(chatId, message, { parse_mode: 'Markdown' });
      }
    } catch (error: any) {
      this.logger.error('Wallet command failed', { error: error.message, userId });
      await this.bot.sendMessage(chatId, `❌ Error: ${error.message}`);
    }
  }

  private async handleBalance(msg: TelegramBot.Message): Promise<void> {
    const chatId = msg.chat.id;
    const userId = msg.from?.id.toString() || '';

    try {
      const balance = await this.walletManager.getBalance(userId, 'telegram');
      
      await this.bot.sendMessage(
        chatId,
        `💰 Balance: ${formatEther(balance.eth)} ETH\nAddress: \`${balance.address}\``,
        { parse_mode: 'Markdown' }
      );
    } catch (error: any) {
      await this.bot.sendMessage(chatId, `❌ Error: ${error.message}`);
    }
  }

  private async handleLaunch(
    msg: TelegramBot.Message,
    match: RegExpExecArray | null
  ): Promise<void> {
    const chatId = msg.chat.id;
    const userId = msg.from?.id.toString() || '';

    if (!match || !match[1] || !match[2] || !match[3]) {
      await this.bot.sendMessage(
        chatId,
        '⚠️ Usage: /launch NAME SYMBOL ETH_AMOUNT\n\nExample: /launch ANAL AnalToken 0.1'
      );
      return;
    }

    const name = match[1];
    const symbol = match[2];
    const ethAmount = match[3];

    try {
      // Validate inputs
      if (name.length < 2 || name.length > 32) {
        throw new Error('Token name must be 2-32 characters');
      }
      if (symbol.length < 2 || symbol.length > 10) {
        throw new Error('Symbol must be 2-10 characters');
      }

      const devBuyAmount = parseEther(ethAmount);
      if (devBuyAmount <= 0n) {
        throw new Error('ETH amount must be greater than 0');
      }

      // Check wallet exists
      const wallet = await this.walletManager.getOrCreateWallet(userId, 'telegram');
      const balance = await this.walletManager.getBalance(userId, 'telegram');

      if (balance.eth < devBuyAmount) {
        await this.bot.sendMessage(
          chatId,
          `❌ Insufficient balance. You have ${formatEther(balance.eth)} ETH but need ${ethAmount} ETH.`
        );
        return;
      }

      // Confirm deployment
      const confirmMessage = `
🚀 *Confirm Token Launch*

Name: *${name}*
Symbol: *${symbol}*
Dev Buy: *${ethAmount} ETH*
Hook Type: *Dynamic Fee*

From: \`${wallet.address}\`

Proceed with deployment?
      `;

      const confirmKeyboard = {
        inline_keyboard: [
          [
            { text: '✅ Deploy', callback_data: `confirm_launch:${name}:${symbol}:${ethAmount}` },
            { text: '❌ Cancel', callback_data: 'cancel_launch' }
          ]
        ]
      };

      // Store session data
      this.userSessions.set(msg.from!.id, {
        name,
        symbol,
        devBuyAmount,
        step: 'confirming'
      });

      await this.bot.sendMessage(chatId, confirmMessage, {
        parse_mode: 'Markdown',
        reply_markup: confirmKeyboard
      });

    } catch (error: any) {
      this.logger.error('Launch command failed', { error: error.message, userId });
      await this.bot.sendMessage(chatId, `❌ Error: ${error.message}`);
    }
  }

  private async handleDeployWizard(msg: TelegramBot.Message): Promise<void> {
    const chatId = msg.chat.id;
    const userId = msg.from?.id.toString() || '';

    // Initialize wizard session
    this.userSessions.set(msg.from!.id, {
      step: 'name',
      config: {}
    });

    await this.bot.sendMessage(
      chatId,
      '🧙‍♂️ *Token Deployment Wizard*\n\nStep 1/5: What is the token name? (2-32 characters)',
      { parse_mode: 'Markdown' }
    );

    // Set up message handler for wizard flow
    this.bot.once('message', (responseMsg) => {
      if (responseMsg.from?.id === msg.from?.id) {
        this.handleWizardStep(responseMsg);
      }
    });
  }

  private async handleWizardStep(msg: TelegramBot.Message): Promise<void> {
    const chatId = msg.chat.id;
    const userId = msg.from?.id.toString() || '';
    const session = this.userSessions.get(msg.from!.id);

    if (!session) return;

    const text = msg.text || '';

    try {
      switch (session.step) {
        case 'name':
          if (text.length < 2 || text.length > 32) {
            await this.bot.sendMessage(chatId, '❌ Name must be 2-32 characters. Try again:');
            return;
          }
          session.config.name = text;
          session.step = 'symbol';
          await this.bot.sendMessage(chatId, 'Step 2/5: What is the token symbol? (2-10 characters)');
          this.bot.once('message', (m) => this.handleWizardStep(m));
          break;

        case 'symbol':
          if (text.length < 2 || text.length > 10) {
            await this.bot.sendMessage(chatId, '❌ Symbol must be 2-10 characters. Try again:');
            return;
          }
          session.config.symbol = text;
          session.step = 'eth';
          await this.bot.sendMessage(chatId, 'Step 3/5: How much ETH for dev buy? (e.g., 0.1)');
          this.bot.once('message', (m) => this.handleWizardStep(m));
          break;

        case 'eth':
          const ethAmount = parseFloat(text);
          if (isNaN(ethAmount) || ethAmount <= 0) {
            await this.bot.sendMessage(chatId, '❌ Invalid amount. Try again:');
            return;
          }
          session.config.devBuyAmount = parseEther(text);
          session.step = 'hook';
          
          const hookKeyboard = {
            inline_keyboard: [
              [
                { text: '⚡ Dynamic Fee', callback_data: 'hook_dynamic' },
                { text: '📊 Static Fee', callback_data: 'hook_static' }
              ]
            ]
          };
          
          await this.bot.sendMessage(chatId, 'Step 4/5: Choose hook type:', {
            reply_markup: hookKeyboard
          });
          break;

        case 'confirm':
          // Final confirmation and deployment
          await this.executeDeployment(chatId, userId, session.config);
          this.userSessions.delete(msg.from!.id);
          break;
      }
    } catch (error: any) {
      await this.bot.sendMessage(chatId, `❌ Error: ${error.message}`);
      this.userSessions.delete(msg.from!.id);
    }
  }

  private async handleCallback(query: TelegramBot.CallbackQuery): Promise<void> {
    const chatId = query.message?.chat.id;
    const userId = query.from.id.toString();
    const data = query.data || '';

    if (!chatId) return;

    try {
      if (data.startsWith('confirm_launch:')) {
        const [, name, symbol, ethAmount] = data.split(':');
        
        const tokenConfig: TokenConfig = {
          name,
          symbol,
          devBuyAmount: parseEther(ethAmount),
          hookType: 'dynamic',
        };

        await this.bot.editMessageText('🚀 Deploying token...', {
          chat_id: chatId,
          message_id: query.message?.message_id
        });

        await this.executeDeployment(chatId, userId, tokenConfig);

      } else if (data === 'cancel_launch') {
        await this.bot.editMessageText('❌ Deployment cancelled.', {
          chat_id: chatId,
          message_id: query.message?.message_id
        });
        this.userSessions.delete(query.from.id);

      } else if (data === 'hook_dynamic' || data === 'hook_static') {
        const session = this.userSessions.get(query.from.id);
        if (session) {
          session.config.hookType = data === 'hook_dynamic' ? 'dynamic' : 'static';
          session.step = 'confirm';
          
          const summary = `
📋 *Deployment Summary*

Name: *${session.config.name}*
Symbol: *${session.config.symbol}*
Dev Buy: *${formatEther(session.config.devBuyAmount)} ETH*
Hook: *${session.config.hookType === 'dynamic' ? 'Dynamic Fee' : 'Static Fee'}*

Ready to deploy?
          `;
          
          const confirmKeyboard = {
            inline_keyboard: [
              [
                { text: '✅ Deploy Token', callback_data: 'wizard_confirm' },
                { text: '❌ Cancel', callback_data: 'wizard_cancel' }
              ]
            ]
          };
          
          await this.bot.editMessageText(summary, {
            chat_id: chatId,
            message_id: query.message?.message_id,
            parse_mode: 'Markdown',
            reply_markup: confirmKeyboard
          });
        }

      } else if (data === 'wizard_confirm') {
        const session = this.userSessions.get(query.from.id);
        if (session) {
          await this.executeDeployment(chatId, userId, session.config);
          this.userSessions.delete(query.from.id);
        }

      } else if (data === 'wizard_cancel') {
        await this.bot.editMessageText('❌ Deployment cancelled.', {
          chat_id: chatId,
          message_id: query.message?.message_id
        });
        this.userSessions.delete(query.from.id);
      }

      // Answer callback to remove loading state
      await this.bot.answerCallbackQuery(query.id);

    } catch (error: any) {
      this.logger.error('Callback handler failed', { error: error.message, data });
      await this.bot.sendMessage(chatId, `❌ Error: ${error.message}`);
      await this.bot.answerCallbackQuery(query.id);
    }
  }

  private async executeDeployment(
    chatId: number,
    userId: string,
    tokenConfig: TokenConfig
  ): Promise<void> {
    try {
      const { client, wallet } = await this.walletManager.getWalletClient(userId, 'telegram');
      
      const result = await this.deployer.deployToken(
        wallet,
        client,
        tokenConfig,
        'telegram'
      );

      const links = this.deployer.generateTokenLinks(result.tokenAddress, result.poolId);

      const successMessage = `
🎉 *Token Deployed Successfully!*

📋 *${tokenConfig.name}* ($${tokenConfig.symbol})

🔗 *Addresses:*
Token: \`${result.tokenAddress}\`
Pool ID: \`${result.poolId}\`

📊 *Links:*
• [BaseScan](${links.basescan})
• [DexScreener](${links.dexscreener})
• [Uniswap swap](${links.uniswapSwap}) (you pay gas)
• [Uniswap token](${links.uniswap})
• [Launches](${links.launcherApp})
• [Trade in Launcher — 0x](${links.launcherInAppSwap}) (sign in; you pay gas)

✅ Transaction: [View on BaseScan](https://basescan.org/tx/${result.transactionHash})

Share your token and start trading!
      `;

      await this.bot.sendMessage(chatId, successMessage, { parse_mode: 'Markdown' });

    } catch (error: any) {
      this.logger.error('Deployment execution failed', { error: error.message, userId });
      await this.bot.sendMessage(chatId, `❌ Deployment failed: ${error.message}`);
    }
  }

  private async handleHistory(msg: TelegramBot.Message): Promise<void> {
    const chatId = msg.chat.id;
    const userId = msg.from?.id.toString() || '';

    try {
      const deployments = await this.deployer.getDeployments(userId, 10);

      if (deployments.length === 0) {
        await this.bot.sendMessage(chatId, '📭 No deployments found. Use /launch to deploy your first token!');
        return;
      }

      let message = '📊 *Your Recent Deployments*\n\n';
      
      deployments.forEach((dep, i) => {
        const status = dep.status === 'success' ? '✅' : dep.status === 'pending' ? '⏳' : '❌';
        const date = new Date(dep.createdAt).toLocaleDateString();
        message += `${i + 1}. ${status} *${dep.tokenConfig.name}* ($${dep.tokenConfig.symbol})\n`;
        message += `   ${date} | [View](https://basescan.org/tx/${dep.result.transactionHash})\n\n`;
      });

      await this.bot.sendMessage(chatId, message, { parse_mode: 'Markdown' });

    } catch (error: any) {
      await this.bot.sendMessage(chatId, `❌ Error: ${error.message}`);
    }
  }

  private async handleHelp(msg: TelegramBot.Message): Promise<void> {
    const chatId = msg.chat.id;

    const helpText = `
🤖 *Liquid Launcher Commands*

*Wallet:*
/wallet - Create or view your wallet
/balance - Check ETH balance

*Token Launch:*
/launch NAME SYMBOL ETH - Quick launch
/deploy - Interactive wizard with full options

*History:*
/history - View your past deployments

*Support:*
/help - Show this message

*Examples:*
\`/launch ANAL AnalToken 0.1\`
\`/balance\`

All tokens deploy on Base with:
• 100B supply
• Uniswap V4 pool
• Locked liquidity
• MEV protection
    `;

    await this.bot.sendMessage(chatId, helpText, { parse_mode: 'Markdown' });
  }
}
