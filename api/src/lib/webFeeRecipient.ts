import { getAddress } from 'viem';
import { config } from '../config.js';
import { logger } from '../logger.js';
import type { NeynarClient } from '../neynar.js';
import { BASE_DEAD_FEE_RECIPIENT } from './deadFeeWallet.js';
import { MEME_TOKEN_DESCRIPTION_TAGLINE } from './memeFeeRecipient.js';
import {
  ensureEmbeddedEthAddressForPrivyUserRecord,
  fetchPrivyUserRecordById,
  formatSelfFeeRecipientLabelFromPrivyUser,
  getEmbeddedEthAddressForPrivyUserId,
  lookupPrivyUserByTwitterUsername,
} from './privy.js';
import { parseRecipientPaste } from './recipientPaste.js';
import { getOrCreateWalletForUser } from './recipientResolver.js';
import { getWalletForUser } from './walletResolver.js';
import { fetchXUserIdByUsername } from './xUserLookup.js';

export interface FeeResolution {
  walletAddress: string;
  /** Shown in token metadata so holders know who receives LP/trading fees */
  feeSummaryLine: string;
  /**
   * Short label for deployment UIs / catalog (e.g. "GitHub @alice", "Farcaster @user").
   * Distinct from on-chain address so social recipients are recognizable.
   */
  feeRecipientLabel: string;
}

/**
 * 1) Privy user linked by Twitter OAuth (web sign-in).
 * 2) Same as X bot: X API username → numeric id → `getOrCreateWalletForUser('x', id)` (custom_auth + embedded wallet).
 * 3) Neynar Farcaster-linked X address.
 */
async function tryResolveFeeRecipientForXUsername(
  neynar: NeynarClient,
  xu: string,
): Promise<FeeResolution | null> {
  if (config.privy.enabled && config.features.usePrivyWallets) {
    const privyUser = await lookupPrivyUserByTwitterUsername(xu);
    if (privyUser) {
      const addr = await ensureEmbeddedEthAddressForPrivyUserRecord(privyUser);
      if (addr) {
        return {
          walletAddress: addr,
          feeSummaryLine: `Trading fees: X @${xu} (launcher / Privy wallet)`,
          feeRecipientLabel: `X @${xu}`,
        };
      }
    }
    const xUid = await fetchXUserIdByUsername(xu);
    if (xUid) {
      const pw = await getOrCreateWalletForUser('x', xUid, xu);
      if (pw?.address) {
        return {
          walletAddress: pw.address,
          feeSummaryLine: `Trading fees: X @${xu} (launcher fee wallet)`,
          feeRecipientLabel: `X @${xu}`,
        };
      }
    }
  }
  const fromFc = config.neynar.enabled ? await neynar.getWalletByXUsername(xu) : null;
  if (fromFc) {
    return {
      walletAddress: fromFc,
      feeSummaryLine: `Trading fees: X @${xu} (via Farcaster-linked address)`,
      feeRecipientLabel: `X @${xu}`,
    };
  }
  return null;
}

function feeRecipientNotResolvedMessage(handle: string): string {
  return (
    `Could not resolve @${handle} as Farcaster or X. ` +
    `For X: they sign in to Liquid Launcher once (Privy wallet), or link that X on Farcaster (Warpcast), or paste a Base 0x address.`
  );
}

async function fetchTelegramNumericUserId(
  botToken: string,
  username: string,
): Promise<string | null> {
  const u = username.replace(/^@/, '').trim();
  if (!u) return null;
  try {
    const url = `https://api.telegram.org/bot${botToken}/getChat?chat_id=${encodeURIComponent('@' + u)}`;
    const res = await fetch(url);
    if (!res.ok) {
      logger.warn('Telegram getChat HTTP error', { status: res.status, username: u });
      return null;
    }
    const j = (await res.json()) as { ok?: boolean; result?: { id?: number } };
    if (!j.ok || typeof j.result?.id !== 'number') return null;
    return String(j.result.id);
  } catch (e: unknown) {
    logger.warn('Telegram getChat failed', { message: e instanceof Error ? e.message : String(e), username: u });
    return null;
  }
}

async function fetchDiscordUserForFeeLookup(
  botToken: string,
  userId: string,
): Promise<{ username: string; discriminator: string } | null> {
  try {
    const res = await fetch(`https://discord.com/api/v10/users/${userId}`, {
      headers: { Authorization: `Bot ${botToken}` },
    });
    if (!res.ok) {
      logger.warn('Discord user lookup HTTP error', { status: res.status, userId });
      return null;
    }
    const u = (await res.json()) as { username?: string; discriminator?: string };
    if (!u.username) return null;
    const d = u.discriminator && u.discriminator !== '0' ? u.discriminator : '0';
    return { username: u.username, discriminator: d };
  } catch (e: unknown) {
    logger.warn('Discord user lookup failed', { message: e instanceof Error ? e.message : String(e), userId });
    return null;
  }
}

/**
 * Resolve fee wallet from pasted text (same rules as the website): 0x, Warpcast, X, GitHub, t.me, Discord profile URL, etc.
 */
export async function resolveFeeRecipientFromSocialPaste(
  neynar: NeynarClient,
  raw: string,
): Promise<FeeResolution> {
  const t = raw.trim();
  if (!t) {
    throw new Error('Paste a fee recipient (0x address, profile link, or t.me/…).');
  }
  const paste = parseRecipientPaste(t);
  return resolveWebFeeRecipient(neynar, {
    kind: 'other',
    address: paste.walletAddress,
    farcasterUsername: paste.farcasterUsername,
    xUsername: paste.xUsername,
    githubUsername: paste.githubUsername,
    telegramUsername: paste.telegramUsername,
    discordUserId: paste.discordUserId,
  });
}

export async function resolveWebFeeRecipient(
  neynar: NeynarClient,
  input:
    | { kind: 'no_dev' }
    | { kind: 'wallet_self'; walletAddress: `0x${string}`; walletKind?: string }
    | { kind: 'self'; privyUserId: string; privyUser?: unknown }
    | {
        kind: 'other';
        address?: string;
        farcasterUsername?: string;
        xUsername?: string;
        githubUsername?: string;
        telegramUsername?: string;
        discordUserId?: string;
      },
): Promise<FeeResolution> {
  if (input.kind === 'no_dev') {
    return {
      walletAddress: BASE_DEAD_FEE_RECIPIENT,
      feeSummaryLine: `No Dev — ${MEME_TOKEN_DESCRIPTION_TAGLINE}`,
      feeRecipientLabel: 'No Dev (meme)',
    };
  }

  if (input.kind === 'wallet_self') {
    const addr = getAddress(input.walletAddress);
    const label =
      input.walletKind === 'bankr-evm'
        ? 'Bankr wallet'
        : `Wallet ${addr.slice(0, 6)}…${addr.slice(-4)}`;
    return {
      walletAddress: addr,
      feeSummaryLine: `Trading fees: ${label} ${addr.slice(0, 6)}…${addr.slice(-4)}`,
      feeRecipientLabel: label,
    };
  }

  if (input.kind === 'self') {
    const addr = await getEmbeddedEthAddressForPrivyUserId(input.privyUserId);
    if (!addr) {
      throw new Error(
        'No embedded Ethereum wallet found for your account. Open the app and complete wallet setup, then try again.',
      );
    }
    const privyUser =
      input.privyUser ??
      (await fetchPrivyUserRecordById(input.privyUserId).catch(() => null));
    const feeRecipientLabel = formatSelfFeeRecipientLabelFromPrivyUser(privyUser);
    return {
      walletAddress: addr,
      feeSummaryLine: `Trading fees: ${feeRecipientLabel} ${addr.slice(0, 6)}…${addr.slice(-4)}`,
      feeRecipientLabel,
    };
  }

  const a = input.address?.trim();
  if (a && /^0x[a-fA-F0-9]{40}$/i.test(a)) {
    const addr = a as `0x${string}`;
    return {
      walletAddress: addr,
      feeSummaryLine: `Trading fees: wallet ${addr.slice(0, 6)}…${addr.slice(-4)}`,
      feeRecipientLabel: `Wallet ${addr.slice(0, 6)}…${addr.slice(-4)}`,
    };
  }

  const fc = input.farcasterUsername?.replace(/^@/, '').trim();
  if (fc) {
    if (!config.neynar.enabled) {
      throw new Error(
        'Farcaster handles are not supported on this server. Deploy to yourself (Privy wallet) or paste a 0x address.',
      );
    }
    const user = await neynar.getUserByFarcasterUsername(fc);
    if (!user) {
      const asX = await tryResolveFeeRecipientForXUsername(neynar, fc);
      if (asX) return asX;
      throw new Error(feeRecipientNotResolvedMessage(fc));
    }
    if (config.privy.enabled && config.features.usePrivyWallets) {
      const pw = await getOrCreateWalletForUser('farcaster', String(user.fid), user.username);
      if (pw?.address) {
        return {
          walletAddress: pw.address,
          feeSummaryLine: `Trading fees: @${user.username} on Farcaster (launcher fee wallet)`,
          feeRecipientLabel: `Farcaster @${user.username}`,
        };
      }
    }
    if (user.ethAddresses.length > 0) {
      const addr = user.ethAddresses[0];
      return {
        walletAddress: addr,
        feeSummaryLine: `Trading fees: @${user.username} on Farcaster (on-chain profile)`,
        feeRecipientLabel: `Farcaster @${user.username}`,
      };
    }
    throw new Error(
      `Could not resolve a fee wallet for @${user.username}. They can log in at the Liquid Launcher site once, or paste a 0x address.`,
    );
  }

  const xu = input.xUsername?.replace(/^@/, '').trim();
  if (xu) {
    const resolved = await tryResolveFeeRecipientForXUsername(neynar, xu);
    if (resolved) return resolved;
    throw new Error(feeRecipientNotResolvedMessage(xu));
  }

  const gh = input.githubUsername?.replace(/^@/, '').trim();
  if (gh) {
    const res = await fetch(`https://api.github.com/users/${encodeURIComponent(gh)}`, {
      headers: { Accept: 'application/vnd.github+json', 'User-Agent': 'liquid-social-launcher' },
    });
    if (!res.ok) {
      throw new Error(`GitHub user @${gh} not found.`);
    }
    const j = (await res.json()) as { id: number; login: string };
    if (!config.privy.enabled || !config.features.usePrivyWallets) {
      throw new Error('GitHub fee wallets require Privy to be enabled on the server.');
    }
    const pw = await getOrCreateWalletForUser('github', String(j.id), j.login);
    if (!pw?.address) {
      throw new Error('Could not create or load a Privy fee wallet for that GitHub account.');
    }
    return {
      walletAddress: pw.address,
      feeSummaryLine: `Trading fees: GitHub @${j.login} (launcher fee wallet)`,
      feeRecipientLabel: `GitHub @${j.login}`,
    };
  }

  const tg = input.telegramUsername?.replace(/^@/, '').trim();
  if (tg) {
    if (!config.telegram.botToken) {
      throw new Error('Telegram fee recipients require TELEGRAM_BOT_TOKEN on the server.');
    }
    const tid = await fetchTelegramNumericUserId(config.telegram.botToken, tg);
    if (!tid) {
      throw new Error(
        `Could not resolve Telegram @${tg}. They may need to /start the launcher bot once, or paste a 0x address.`,
      );
    }
    if (!config.privy.enabled || !config.features.usePrivyWallets) {
      throw new Error('Telegram fee wallets require Privy to be enabled on the server.');
    }
    const resolved = await getWalletForUser('telegram', tid, tg);
    if (!resolved?.address) {
      throw new Error('Could not create or load a Privy fee wallet for that Telegram user.');
    }
    return {
      walletAddress: resolved.address,
      feeSummaryLine: `Trading fees: Telegram @${tg} (launcher fee wallet)`,
      feeRecipientLabel: `Telegram @${tg}`,
    };
  }

  const did = input.discordUserId?.trim();
  if (did && /^\d{10,20}$/.test(did)) {
    if (!config.discord.token) {
      throw new Error('Discord fee recipients require DISCORD_TOKEN on the server.');
    }
    const du = await fetchDiscordUserForFeeLookup(config.discord.token, did);
    if (!du) {
      throw new Error(
        `Could not resolve Discord user ${did}. Check the profile link or paste a 0x address.`,
      );
    }
    const resolved = await getWalletForUser(
      'discord',
      did,
      du.username,
      du.discriminator,
    );
    if (!resolved?.address) {
      throw new Error(
        'Could not load a Privy fee wallet for that Discord user. They may need to sign in to Liquid Launcher once.',
      );
    }
    return {
      walletAddress: resolved.address,
      feeSummaryLine: `Trading fees: Discord @${du.username} (launcher fee wallet)`,
      feeRecipientLabel: `Discord @${du.username}`,
    };
  }

  throw new Error(
    'Choose a fee recipient: paste a Base 0x address, or a Warpcast / X / GitHub / t.me / Discord (profile or message author) link.',
  );
}
