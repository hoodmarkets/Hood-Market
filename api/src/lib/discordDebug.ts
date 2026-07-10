import { EmbedBuilder } from 'discord.js';
import type { TokenLinks } from '../deployer.js';
import { config } from '../config.js';
import { logger } from '../logger.js';
import {
  getPlatformListenSnapshot,
  type PlatformListenSnapshot,
} from './platformListenSnapshot.js';

let discordClient: any = null;

export function setDiscordDebugClient(client: any): void {
  discordClient = client;
}

async function sendToChannel(channelId: string, embed: EmbedBuilder): Promise<void> {
  if (!discordClient || !channelId) return;
  try {
    const channel = await discordClient.channels.fetch(channelId);
    if (channel && 'send' in channel) {
      await channel.send({ embeds: [embed] });
    }
  } catch (error: any) {
    logger.debug('Discord debug send failed:', error.message);
  }
}

export async function debugLog(
  title: string,
  fields: { name: string; value: string; inline?: boolean }[],
  color: number = 0x888888
): Promise<void> {
  if (!config.discord.debugChannelId) return;
  const embed = new EmbedBuilder()
    .setTitle(title)
    .addFields(fields.map(f => ({
      name: f.name,
      value: String(f.value).slice(0, 1024) || '—',
      inline: f.inline ?? false,
    })))
    .setColor(color)
    .setTimestamp();
  await sendToChannel(config.discord.debugChannelId, embed);
}

export async function debugInfo(title: string, description: string): Promise<void> {
  if (!config.discord.debugChannelId) return;
  const embed = new EmbedBuilder()
    .setTitle(`ℹ️ ${title}`)
    .setDescription(description.slice(0, 4096))
    .setColor(0x3498db)
    .setTimestamp();
  await sendToChannel(config.discord.debugChannelId, embed);
}

export async function debugError(title: string, error: string, context?: Record<string, string>): Promise<void> {
  if (!config.discord.debugChannelId) return;
  const fields = context
    ? Object.entries(context).map(([k, v]) => ({ name: k, value: String(v).slice(0, 1024), inline: true }))
    : [];
  const embed = new EmbedBuilder()
    .setTitle(`❌ ${title}`)
    .setDescription(error.slice(0, 4096))
    .addFields(fields)
    .setColor(0xff0000)
    .setTimestamp();
  await sendToChannel(config.discord.debugChannelId, embed);
}

export async function debugSuccess(title: string, description: string, context?: Record<string, string>): Promise<void> {
  if (!config.discord.debugChannelId) return;
  const fields = context
    ? Object.entries(context).map(([k, v]) => ({ name: k, value: String(v).slice(0, 1024), inline: true }))
    : [];
  const embed = new EmbedBuilder()
    .setTitle(`✅ ${title}`)
    .setDescription(description.slice(0, 4096))
    .addFields(fields)
    .setColor(0x00ff00)
    .setTimestamp();
  await sendToChannel(config.discord.debugChannelId, embed);
}

export async function feedPost(embed: EmbedBuilder): Promise<void> {
  if (!config.discord.feedChannelId) return;
  await sendToChannel(config.discord.feedChannelId, embed);
}

/** Subset of `TokenLinks` used for Discord web launch notifications (explorer + stats links). */
export type WebLaunchNotifyLinks = TokenLinks;

/**
 * Announce a successful Privy web deploy to Discord: same feed channel as slash deploys (if bot + feed
 * channel are configured) and/or an optional incoming webhook URL (`DISCORD_LAUNCH_WEBHOOK_URL`).
 */
export async function notifyDiscordWebLaunch(payload: {
  name: string;
  symbol: string;
  tokenAddress: string;
  poolId: string;
  transactionHash: string;
  feeWallet: string;
  initiatorAttribution: string;
  feeRecipientLabel: string;
  links: WebLaunchNotifyLinks;
  /** Default: Privy web. Set for agent-wallet (captcha) deploys. */
  platformField?: string;
  /** Optional key/values from agent deploy metadata (Bankr, etc.). */
  agentMetadataFields?: Record<string, string>;
}): Promise<void> {
  const hasFeed = !!config.discord.feedChannelId;
  const webhookUrl = config.discord.launchWebhookUrl;
  if (!hasFeed && !webhookUrl) return;

  const scanLabel = payload.links.chain === 'ethereum' ? 'Etherscan' : 'BaseScan';
  const linkLine = `[${scanLabel}](${payload.links.explorer}) | [DexScreener](${payload.links.dexscreener}) | [Uniswap swap](${payload.links.uniswapSwap}) | [Uniswap token](${payload.links.uniswap}) | [Liquid](${payload.links.liquid}) | [Trade in Launcher](${payload.links.launcherInAppSwap}) | [Launches](${payload.links.launcherApp})`;
  const txUrl =
    payload.links.chain === 'ethereum'
      ? `https://etherscan.io/tx/${payload.transactionHash}`
      : `https://basescan.org/tx/${payload.transactionHash}`;
  const feeLines =
    payload.feeRecipientLabel?.trim().length > 0
      ? `${payload.feeRecipientLabel}\n\`${payload.feeWallet}\``
      : `\`${payload.feeWallet}\``;

  const platformValue = (payload.platformField ?? '**Web** (Privy)').slice(0, 1024);
  const metaKeys = payload.agentMetadataFields
    ? Object.keys(payload.agentMetadataFields).filter((k) => payload.agentMetadataFields![k]?.length)
    : [];
  const metaLine =
    metaKeys.length > 0
      ? metaKeys
          .map((k) => `**${k}:** ${payload.agentMetadataFields![k]}`)
          .join('\n')
          .slice(0, 1024)
      : '';

  const embed = new EmbedBuilder()
    .setTitle('🎉 Token Deployed!')
    .setDescription(`${payload.name} ($${payload.symbol})`)
    .addFields(
      { name: 'Platform', value: platformValue, inline: true },
      {
        name: 'Signed in as',
        value: (payload.initiatorAttribution || '—').slice(0, 1024),
        inline: true,
      },
      { name: 'Token', value: `\`${payload.tokenAddress}\``, inline: false },
      { name: 'Pool ID', value: `\`${payload.poolId}\``, inline: false },
      {
        name: 'Transaction',
        value: `[${payload.transactionHash.slice(0, 10)}…${payload.transactionHash.slice(-8)}](${txUrl})`,
        inline: false,
      },
      { name: 'Fee target', value: feeLines.slice(0, 1024), inline: false },
      ...(metaLine
        ? [{ name: 'Agent metadata', value: metaLine, inline: false as const }]
        : []),
      { name: 'Links', value: linkLine.slice(0, 1024), inline: false },
    )
    .setColor(0x00ff00)
    .setTimestamp();

  if (hasFeed) {
    await feedPost(embed);
  }

  if (webhookUrl) {
    try {
      const res = await fetch(webhookUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ embeds: [embed.toJSON()] }),
      });
      if (!res.ok) {
        const t = await res.text();
        logger.warn('Discord launch webhook failed:', res.status, t.slice(0, 300));
      }
    } catch (e: unknown) {
      logger.warn(
        'Discord launch webhook request failed:',
        e instanceof Error ? e.message : e,
      );
    }
  }
}

function platformLine(ok: boolean, name: string, detail: string): string {
  const icon = ok ? '✅' : '⚪';
  return `${icon} **${name}** — ${detail}`;
}

export type StartupListenReportResult =
  | 'sent'
  | 'skipped_no_debug_channel'
  | 'skipped_no_discord_bot'
  | 'pending_discord_client'
  | 'skipped_no_snapshot'
  | 'send_failed';

/** Posted after deploy/restart: which bots and webhooks are active (needs debug channel + Discord client ready). */
export async function postStartupListenReport(): Promise<StartupListenReportResult> {
  if (!config.discord.debugChannelId) {
    return 'skipped_no_debug_channel';
  }
  if (!config.discord.token) {
    logger.debug('Startup report skipped: DISCORD_DEBUG_CHANNEL_ID set but no DISCORD_TOKEN');
    return 'skipped_no_discord_bot';
  }
  if (!discordClient) {
    logger.debug('Startup report deferred: Discord client not ready yet');
    return 'pending_discord_client';
  }
  const snap = getPlatformListenSnapshot();
  if (!snap) {
    logger.debug('Startup report skipped: no platform snapshot');
    return 'skipped_no_snapshot';
  }

  const row = (s: PlatformListenSnapshot, key: keyof Pick<PlatformListenSnapshot, 'telegram' | 'discord' | 'farcaster' | 'x'>, label: string, on: string, off: string) =>
    platformLine(!!s[key], label, s[key] ? on : off);

  const description = [
    `**${config.nodeEnv}** · Public HTTP **${snap.httpServer ? 'listening' : 'starting…'}**`,
    '',
    row(snap, 'telegram', 'Telegram', 'long-poll bot running', 'not configured or failed to start'),
    row(snap, 'discord', 'Discord', 'bot logged in · slash commands', 'not configured or failed to start'),
    row(snap, 'farcaster', 'Farcaster', 'POST `/webhooks/neynar` ready', 'NEYNAR not set or handler off'),
    row(snap, 'x', 'X (Twitter)', 'POST `/webhooks/x` ready', 'OAuth keys not set or handler off'),
  ].join('\n');

  const embed = new EmbedBuilder()
    .setTitle('🚀 Liquid Launcher — platform status')
    .setDescription(description.slice(0, 4096))
    .setColor(
      snap.httpServer && (snap.telegram || snap.discord || snap.farcaster || snap.x)
        ? 0x5865f2
        : 0xf39c12
    )
    .setTimestamp();

  if (snap.errors.length > 0) {
    embed.addFields({
      name: 'Startup warnings',
      value: snap.errors.join('\n').slice(0, 1024),
      inline: false,
    });
  }

  try {
    await sendToChannel(config.discord.debugChannelId, embed);
    logger.info('Posted startup platform status to Discord debug channel');
    return 'sent';
  } catch (e: any) {
    logger.warn('Failed to post startup platform status:', e?.message);
    return 'send_failed';
  }
}
