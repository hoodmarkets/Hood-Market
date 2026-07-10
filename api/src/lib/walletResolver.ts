import { config } from '../config.js';
import { logger } from '../logger.js';
import { getWalletAddressForIdentity, type IdentityClaim } from './privy.js';

/**
 * Get wallet address for a user.
 * If Privy is enabled, creates/returns a Privy wallet linked to platform identity.
 */
export async function getWalletForUser(
  platform: 'discord' | 'telegram' | 'x' | 'farcaster' | 'github',
  userId: string,
  username?: string,
  /** Discord only — pairs with `username` for Privy `discord_oauth` (same user as web login). */
  discordDiscriminator?: string,
): Promise<{
  address: string;
  isNew: boolean;
  claimUrl?: string;
  privyUserId: string;
} | null> {
  if (!config.privy.enabled || !config.features.usePrivyWallets) {
    return null;
  }

  try {
    const identity: IdentityClaim = {
      platform,
      userId,
      username,
      discordDiscriminator,
    };

    const { address, claimUrl, isNew, privyUserId } =
      await getWalletAddressForIdentity(identity);

    logger.info('Privy wallet resolved', {
      platform,
      userId,
      address,
      isNew,
    });

    return { address, isNew, claimUrl, privyUserId };
  } catch (error: any) {
    logger.error('Failed to get Privy wallet:', error);
    return null;
  }
}

export function generateWalletInfoMessage(
  address: string,
  claimUrl?: string,
  isNew?: boolean
): string {
  let message = '';

  if (isNew) {
    message += `✅ *New wallet created!*\n`;
    message += `Address: \`${address}\`\n\n`;
  } else {
    message += `💳 *Using your existing wallet*\n`;
    message += `Address: \`${address}\`\n\n`;
  }

  if (claimUrl) {
    message += `🔍 *View wallet on BaseScan:*\n`;
    message += `${claimUrl}\n\n`;
  }

  return message;
}

/** When false, fee recipient is resolved via Privy for the deploying user. */
export function shouldAskForWallet(): boolean {
  return !config.privy.enabled || !config.features.usePrivyWallets;
}
