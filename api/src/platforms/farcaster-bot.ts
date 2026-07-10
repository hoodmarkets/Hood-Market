import { NeynarAPIClient } from '@neynar/nodejs-sdk';
import { TokenConfig, Platform } from '../types';
import { WalletManager } from '../services/wallet-manager';
import { LiquidDeployer } from '../services/liquid-deployer';
import { config } from '../config/config';
import { Logger } from 'winston';
import { parseEther, formatEther } from 'viem';

export class FarcasterHandler {
  private client: NeynarAPIClient;
  private walletManager: WalletManager;
  private deployer: LiquidDeployer;
  private logger: Logger;
  private signerUuid: string;
  private userSessions: Map<number, any> = new Map();

  constructor(
    walletManager: WalletManager,
    deployer: LiquidDeployer,
    logger: Logger
  ) {
    this.walletManager = walletManager;
    this.deployer = deployer;
    this.logger = logger;
    this.signerUuid = config.farcaster.signerUuid;

    if (!config.farcaster.apiKey) {
      throw new Error('Neynar API key not configured');
    }

    this.client = new NeynarAPIClient(config.farcaster.apiKey);
  }

  async handleWebhook(payload: any): Promise<void> {
    try {
      // Handle mention or reply events
      if (payload.type === 'cast.created') {
        const cast = payload.cast;
        const text = cast.text.toLowerCase();
        const author = cast.author;
        const castHash = cast.hash;

        this.logger.info('Farcaster webhook received', { 
          author: author.username, 
          text: cast.text,
          castHash 
        });

        // Check if it's a command
        if (text.includes('@liquidlauncher') || text.includes('@ll')) {
          await this.handleCommand(cast, author);
        }
      }
    } catch (error: any) {
      this.logger.error('Farcaster webhook error', { error: error.message });
    }
  }

  private async handleCommand(cast: any, author: any): Promise<void> {
    const text = cast.text;
    const userFid = author.fid;
    const username = author.username;
    const castHash = cast.hash;

    // Parse command
    const parts = text.split(/\s+/);
    const command = parts.find((p: string) => 
      p.toLowerCase().includes('launch') || 
      p.toLowerCase().includes('deploy') ||
      p.toLowerCase().includes('wallet') ||
      p.toLowerCase().includes('balance') ||
      p.toLowerCase().includes('help')
    )?.toLowerCase() || '';

    try {
      if (command.includes('wallet')) {
        await this.handleWallet(userFid, username, castHash);
      } else if (command.includes('balance')) {
        await this.handleBalance(userFid, username, castHash);
      } else if (command.includes('launch')) {
        await this.handleLaunch(userFid, username, castHash, parts);
      } else if (command.includes('deploy')) {
        await this.reply(castHash, `🧙‍♂️ Use the full command format:\n\n@liquidlauncher launch NAME SYMBOL ETH_AMOUNT\n\nExample: @liquidlauncher launch ANAL AnalToken 0.1`);
      } else {
        await this.handleHelp(castHash);
      }
    } catch (error: any) {
      this.logger.error('Farcaster command error', { error: error.message, userFid });
      await this.reply(castHash, `❌ Error: ${error.message}`);
    }
  }

  private async handleWallet(fid: number, username: string, replyTo: string): Promise<void> {
    const userId = fid.toString();

    try {
      let wallet = await this.walletManager.getWallet(userId, 'farcaster');
      
      if (!wallet) {
        wallet = await this.walletManager.createWallet(userId, 'farcaster');
        
        await this.reply(replyTo, 
          `✅ New Wallet Created!\n\n` +
          `Address: ${wallet.address}\n\n` +
          `Send Base ETH to this address to deploy tokens.\n\n` +
          `Your private key is encrypted and secure.`
        );
      } else {
        const balance = await this.walletManager.getBalance(userId, 'farcaster');
        
        await this.reply(replyTo,
          `👛 Your Wallet\n\n` +
          `Address: ${wallet.address}\n` +
          `Balance: ${formatEther(balance.eth)} ETH`
        );
      }
    } catch (error: any) {
      await this.reply(replyTo, `❌ Error: ${error.message}`);
    }
  }

  private async handleBalance(fid: number, username: string, replyTo: string): Promise<void> {
    const userId = fid.toString();

    try {
      const balance = await this.walletManager.getBalance(userId, 'farcaster');
      
      await this.reply(replyTo,
        `💰 Balance\n\n` +
        `${formatEther(balance.eth)} ETH\n` +
        `Address: ${balance.address}`
      );
    } catch (error: any) {
      await this.reply(replyTo, `❌ Error: ${error.message}`);
    }
  }

  private async handleLaunch(fid: number, username: string, replyTo: string, parts: string[]): Promise<void> {
    const userId = fid.toString();

    // Parse: @liquidlauncher launch NAME SYMBOL ETH
    const launchIndex = parts.findIndex((p: string) => p.toLowerCase().includes('launch'));
    
    if (launchIndex === -1 || parts.length < launchIndex + 4) {
      await this.reply(replyTo, 
        `⚠️ Usage: @liquidlauncher launch NAME SYMBOL ETH_AMOUNT\n\n` +
        `Example: @liquidlauncher launch ANAL AnalToken 0.1`
      );
      return;
    }

    const name = parts[launchIndex + 1];
    const symbol = parts[launchIndex + 2];
    const ethAmount = parts[launchIndex + 3];

    try {
      // Validate
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

      // Check wallet
      const wallet = await this.walletManager.getOrCreateWallet(userId, 'farcaster');
      const balance = await this.walletManager.getBalance(userId, 'farcaster');

      if (balance.eth < devBuyAmount) {
        await this.reply(replyTo,
          `❌ Insufficient balance.\n\n` +
          `You have: ${formatEther(balance.eth)} ETH\n` +
          `Required: ${ethAmount} ETH\n\n` +
          `Send Base ETH to: ${wallet.address}`
        );
        return;
      }

      // Confirm
      await this.reply(replyTo,
        `🚀 Confirm Token Launch\n\n` +
        `Name: ${name}\n` +
        `Symbol: ${symbol}\n` +
        `Dev Buy: ${ethAmount} ETH\n` +
        `From: ${wallet.address.slice(0, 6)}...${wallet.address.slice(-4)}\n\n` +
        `Reply "confirm" to proceed or "cancel" to abort.`
      );

      // Store pending
      this.userSessions.set(fid, {
        name,
        symbol,
        devBuyAmount,
        replyTo,
        timestamp: Date.now()
      });

      // Set timeout to clear session
      setTimeout(() => {
        this.userSessions.delete(fid);
      }, 300000); // 5 minutes

    } catch (error: any) {
      await this.reply(replyTo, `❌ Error: ${error.message}`);
    }
  }

  async handleConfirmation(cast: any): Promise<void> {
    const fid = cast.author.fid;
    const text = cast.text.toLowerCase().trim();
    const replyTo = cast.hash;
    const parentHash = cast.parent_hash;

    const session = this.userSessions.get(fid);
    if (!session) return;

    // Check if replying to our confirmation
    if (parentHash !== session.replyTo) return;

    if (text === 'confirm') {
      this.userSessions.delete(fid);
      
      const tokenConfig: TokenConfig = {
        name: session.name,
        symbol: session.symbol,
        devBuyAmount: session.devBuyAmount,
        hookType: 'dynamic',
      };

      await this.executeDeployment(fid.toString(), replyTo, tokenConfig);

    } else if (text === 'cancel') {
      this.userSessions.delete(fid);
      await this.reply(replyTo, '❌ Deployment cancelled.');
    }
  }

  private async executeDeployment(
    userId: string,
    replyTo: string,
    tokenConfig: TokenConfig
  ): Promise<void> {
    try {
      await this.reply(replyTo, '🚀 Deploying token... Please wait.');

      const { client, wallet } = await this.walletManager.getWalletClient(userId, 'farcaster');
      
      const result = await this.deployer.deployToken(
        wallet,
        client,
        tokenConfig,
        'farcaster'
      );

      const links = this.deployer.generateTokenLinks(result.tokenAddress, result.poolId);

      await this.reply(replyTo,
        `🎉 Token Deployed Successfully!\n\n` +
        `${tokenConfig.name} ($${tokenConfig.symbol})\n\n` +
        `Token: ${result.tokenAddress}\n` +
        `Pool: ${result.poolId}\n\n` +
        `Links:\n` +
        `• BaseScan: ${links.basescan}\n` +
        `• DexScreener: ${links.dexscreener}\n` +
        `• Uniswap swap: ${links.uniswapSwap}\n` +
        `• Uniswap token: ${links.uniswap}\n` +
        `• Launches: ${links.launcherApp}\n` +
        `• Trade in Launcher (0x): ${links.launcherInAppSwap}\n\n` +
        `Tx: https://basescan.org/tx/${result.transactionHash}`
      );

    } catch (error: any) {
      this.logger.error('Farcaster deployment failed', { error: error.message, userId });
      await this.reply(replyTo, `❌ Deployment failed: ${error.message}`);
    }
  }

  private async handleHelp(replyTo: string): Promise<void> {
    await this.reply(replyTo,
      `🤖 Liquid Launcher\n\n` +
      `Deploy tokens on Base with Uniswap V4 pools.\n\n` +
      `Commands:\n` +
      `• @liquidlauncher wallet - Create/view wallet\n` +
      `• @liquidlauncher balance - Check ETH balance\n` +
      `• @liquidlauncher launch NAME SYMBOL ETH - Quick launch\n\n` +
      `Example:\n` +
      `@liquidlauncher launch ANAL AnalToken 0.1\n\n` +
      `All tokens: 100B supply, locked LP, MEV protection`
    );
  }

  private async reply(castHash: string, text: string): Promise<void> {
    try {
      await this.client.publishCast(this.signerUuid, text, { replyTo: castHash });
    } catch (error: any) {
      this.logger.error('Failed to reply on Farcaster', { error: error.message });
    }
  }

  async postAnnouncement(text: string): Promise<void> {
    try {
      await this.client.publishCast(this.signerUuid, text);
      this.logger.info('Posted announcement to Farcaster');
    } catch (error: any) {
      this.logger.error('Failed to post to Farcaster', { error: error.message });
    }
  }
}
