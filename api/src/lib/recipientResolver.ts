import { config } from '../config.js';
import { logger } from '../logger.js';
import { getOrCreatePrivyWallet, createIdentity, walletExplorerUrl } from './privy.js';
import { NeynarClient } from '../neynar.js';

export type RecipientType = 'me' | 'telegram' | 'discord' | 'x' | 'farcaster' | 'wallet';

export interface RecipientInfo {
  type: RecipientType;
  identifier: string;
  walletAddress?: string;
  displayName?: string;
  platform?: string;
}

/**
 * Resolve a recipient identifier to a wallet address
 */
export async function resolveRecipient(
  type: RecipientType,
  identifier: string
): Promise<RecipientInfo | null> {
  switch (type) {
    case 'me':
      // Create/get wallet for the current user (handled by caller)
      return null; // Caller should use their own platform identity

    case 'wallet':
      // Direct wallet address
      if (!identifier.match(/^0x[a-fA-F0-9]{40}$/)) {
        throw new Error('Invalid wallet address format');
      }
      return {
        type: 'wallet',
        identifier,
        walletAddress: identifier,
      };

    case 'telegram':
      return await resolveTelegramUser(identifier);

    case 'discord':
      return await resolveDiscordUser(identifier);

    case 'x':
      return await resolveXUser(identifier);

    case 'farcaster':
      return await resolveFarcasterUser(identifier);

    default:
      return null;
  }
}

/**
 * Look up a Telegram user by username
 */
async function resolveTelegramUser(username: string): Promise<RecipientInfo | null> {
  // Clean up username
  const cleanUsername = username.replace(/^@/, '').toLowerCase();

  // For now, return placeholder - would need Telegram Bot API to look up by username
  // This requires the bot to have interacted with the user before
  logger.warn('Telegram user lookup not implemented - would need user ID from prior interaction');
  
  return {
    type: 'telegram',
    identifier: cleanUsername,
    displayName: `@${cleanUsername}`,
    platform: 'telegram',
    // Cannot resolve wallet without user ID
  };
}

/**
 * Look up a Discord user by username
 */
async function resolveDiscordUser(username: string): Promise<RecipientInfo | null> {
  // Clean up username
  const cleanUsername = username.replace(/^@/, '').toLowerCase();

  // Would need Discord API to resolve username to user ID
  logger.warn('Discord user lookup not implemented - would need Discord client integration');
  
  return {
    type: 'discord',
    identifier: cleanUsername,
    displayName: `@${cleanUsername}`,
    platform: 'discord',
  };
}

/**
 * Look up an X/Twitter user and try to get their Farcaster wallet
 */
async function resolveXUser(username: string): Promise<RecipientInfo | null> {
  const cleanUsername = username.replace(/^@/, '').toLowerCase();

  try {
    // Try to find Farcaster profile with same username
    const neynar = new NeynarClient();
    
    // Search for user by username
    // Note: Neynar doesn't have direct username search, we'd need to use their API
    // For now, return placeholder
    logger.info(`Looking up X user @${cleanUsername} for wallet resolution`);

    // In a full implementation:
    // 1. Use Neynar to search for Farcaster user by username
    // 2. Get their verified addresses
    // 3. Return the first ETH address

    return {
      type: 'x',
      identifier: cleanUsername,
      displayName: `@${cleanUsername}`,
      platform: 'x',
    };
  } catch (error) {
    logger.error('Failed to resolve X user:', error);
    return null;
  }
}

/**
 * Look up a Farcaster user and get their wallet
 */
async function resolveFarcasterUser(identifier: string): Promise<RecipientInfo | null> {
  try {
    const neynar = new NeynarClient();
    
    // Try to parse as FID first
    const fid = parseInt(identifier, 10);
    
    let user;
    if (!isNaN(fid)) {
      // Look up by FID
      user = await neynar.getUserByFid(fid);
    } else {
      // Look up by username (remove @ if present)
      const username = identifier.replace(/^@/, '');
      // Note: Would need Neynar's user search endpoint
      logger.warn(`Farcaster username lookup not implemented for: ${username}`);
      return null;
    }

    if (!user || user.ethAddresses.length === 0) {
      return null;
    }

    return {
      type: 'farcaster',
      identifier: user.fid.toString(),
      displayName: `@${user.username}`,
      walletAddress: user.ethAddresses[0],
      platform: 'farcaster',
    };
  } catch (error) {
    logger.error('Failed to resolve Farcaster user:', error);
    return null;
  }
}

/**
 * Get or create a wallet for a user (for "me" option)
 */
export async function getOrCreateWalletForUser(
  platform: 'telegram' | 'discord' | 'x' | 'farcaster' | 'github',
  userId: string,
  username?: string
): Promise<{
  address: string;
  isNew: boolean;
  claimUrl?: string;
  privyUserId: string;
} | null> {
  if (!config.privy.enabled || !config.features.usePrivyWallets) {
    logger.warn('getOrCreateWalletForUser skipped (Privy wallets disabled)', {
      platform,
      privyConfigured: config.privy.enabled,
      usePrivyWallets: config.features.usePrivyWallets,
    });
    return null;
  }

  try {
    const identity = createIdentity(platform, userId, username);
    const { wallet, isNew, privyUserId } = await getOrCreatePrivyWallet(identity);

    return {
      address: wallet.address,
      isNew,
      claimUrl: walletExplorerUrl(wallet.address),
      privyUserId,
    };
  } catch (error) {
    logger.error('Failed to get/create wallet:', error);
    return null;
  }
}

/**
 * Generate fee recipient selection message
 */
export function generateRecipientSelectionMessage(): string {
  return `
🎯 **Who should receive the trading fees?**

1️⃣ **Me** — Create/link my wallet via Privy
2️⃣ **Telegram user** — @username on Telegram
3️⃣ **Discord user** — @username on Discord  
4️⃣ **X/Twitter user** — @username on X
5️⃣ **Farcaster user** — @username or FID
6️⃣ **Wallet address** — Paste 0x... address

Reply with the number (1-6):
  `.trim();
}
