import dotenv from 'dotenv';
import { parseEther } from 'viem';
import { base } from 'viem/chains';
import { parseDeployBondWeiFromEnv } from '../lib/deployBondEnv.js';

dotenv.config();

export const config = {
  // Server
  port: parseInt(process.env.PORT || '3000'),
  nodeEnv: process.env.NODE_ENV || 'development',
  
  // Database
  database: {
    path: process.env.DB_PATH || './data/launcher.db',
  },
  
  // Blockchain (Base)
  chain: base,
  rpcUrl: process.env.BASE_RPC_URL || 'https://mainnet.base.org',

  /** Minimal ETH attached to deploy (launcher / user wallet in wallet-based flows) */
  deployBondWei: parseDeployBondWeiFromEnv(),
  
  // Liquid Protocol Contracts
  liquid: {
    factory: '0x04F1a284168743759BE6554f607a10CEBdB77760' as `0x${string}`,
    feeLocker: '0xF7d3BE3FC0de76fA5550C29A8F6fa53667B876FF' as `0x${string}`,
    hookDynamic: '0x80E2F7dC8C2C880BbC4BDF80A5Fb0eB8B1DB68CC' as `0x${string}`,
    hookStatic: '0x9811f10Cd549c754Fa9E5785989c422A762c28cc' as `0x${string}`,
    lpLocker: '0x77247fCD1d5e34A3703AcA898A591Dc7422435f3' as `0x${string}`,
  },
  
  // Telegram
  telegram: {
    enabled: process.env.TELEGRAM_ENABLED === 'true',
    botToken: process.env.TELEGRAM_BOT_TOKEN || '',
    webhookUrl: process.env.TELEGRAM_WEBHOOK_URL,
  },
  
  // Discord
  discord: {
    enabled: process.env.DISCORD_ENABLED === 'true',
    token: process.env.DISCORD_TOKEN || '',
    clientId: process.env.DISCORD_CLIENT_ID || '',
    guildId: process.env.DISCORD_GUILD_ID,
    webhookUrl: process.env.DISCORD_WEBHOOK_URL,
  },
  
  // Farcaster (Neynar)
  farcaster: {
    enabled: process.env.FARCASTER_ENABLED === 'true',
    apiKey: process.env.NEYNAR_API_KEY || '',
    signerUuid: process.env.NEYNAR_SIGNER_UUID || '',
    webhookSecret: process.env.FARCASTER_WEBHOOK_SECRET,
  },
  
  // X/Twitter
  x: {
    enabled: process.env.X_ENABLED === 'true',
    consumerKey: process.env.X_CONSUMER_KEY || '',
    consumerSecret: process.env.X_CONSUMER_SECRET || '',
    accessToken: process.env.X_ACCESS_TOKEN || '',
    accessTokenSecret: process.env.X_ACCESS_TOKEN_SECRET || '',
    webhookUrl: process.env.X_WEBHOOK_URL,
    webhookSecret: process.env.X_WEBHOOK_SECRET,
  },
  
  // Security
  encryption: {
    key: process.env.ENCRYPTION_KEY || '',
  },
  
  // Features
  features: {
    autoPostToX: process.env.AUTO_POST_TO_X === 'true',
    autoPostToFarcaster: process.env.AUTO_POST_TO_FARCASTER === 'true',
    sniperEnabled: process.env.SNIPER_ENABLED === 'true',
    analyticsEnabled: process.env.ANALYTICS_ENABLED === 'true',
  },
  
  // Logging
  logLevel: process.env.LOG_LEVEL || 'info',
};

export function validateConfig(): void {
  const required = [
    'ENCRYPTION_KEY',
    'BASE_RPC_URL',
  ];
  
  const missing = required.filter(key => !process.env[key]);
  
  if (config.telegram.enabled && !config.telegram.botToken) {
    missing.push('TELEGRAM_BOT_TOKEN (when TELEGRAM_ENABLED=true)');
  }
  
  if (config.discord.enabled && !config.discord.token) {
    missing.push('DISCORD_TOKEN (when DISCORD_ENABLED=true)');
  }
  
  if (config.farcaster.enabled && !config.farcaster.apiKey) {
    missing.push('NEYNAR_API_KEY (when FARCASTER_ENABLED=true)');
  }
  
  if (config.x.enabled && (!config.x.consumerKey || !config.x.accessToken)) {
    missing.push('X OAuth credentials (when X_ENABLED=true)');
  }
  
  if (missing.length > 0) {
    throw new Error(`Missing required environment variables: ${missing.join(', ')}`);
  }
}
