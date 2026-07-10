import { config } from '../config.js';
import { logger } from '../logger.js';
import { BASE_DEAD_FEE_RECIPIENT } from './deadFeeWallet.js';
import { hoodmarketsTokenUrl } from './launcherAppUrl.js';
import { telegramTradeLinks } from './tradingLinks.js';

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

export type TelegramDeploymentFeedPayload = {
  platform: string;
  tokenName: string;
  tokenSymbol: string;
  tokenAddress: string;
  feeRecipientAddress: string;
  deployerLabel: string;
  feeRecipientLabel?: string;
  transactionHash: string;
  sourceUrl?: string;
  tokenDescription?: string;
  tokenWebsiteUrl?: string;
  tokenXUrl?: string;
  /**
   * True when trading fees go to the deployer’s own wallet (self / Privy wallet), not burn and not routed to someone else.
   * Used for the “Deployer & fee match” forum topic when configured.
   */
  feeToSelf?: boolean;
  /**
   * `agent` for AI agent automation deploys; `web` or omitted for user-initiated.
   * Used for the "Agent deployments" forum topic when configured.
   */
  clientKind?: string;
};

const DEAD_LOWER = BASE_DEAD_FEE_RECIPIENT.toLowerCase();

function buildMessageHtml(payload: TelegramDeploymentFeedPayload): string {
  const name = escapeHtml(payload.tokenName.slice(0, 120));
  const sym = escapeHtml(payload.tokenSymbol.slice(0, 32));
  const plat = escapeHtml(payload.platform.slice(0, 64));
  const deployer = escapeHtml(payload.deployerLabel.slice(0, 256) || '—');
  const tokenAddr = payload.tokenAddress;
  const feeAddr = payload.feeRecipientAddress;
  const feeLbl = payload.feeRecipientLabel?.trim();

  const liquid = hoodmarketsTokenUrl(tokenAddr);
  const explorerTx = `https://robinhoodchain.blockscout.com/tx/${payload.transactionHash}`;
  const launches = hoodmarketsTokenUrl(tokenAddr);
  const trade = telegramTradeLinks(tokenAddr);

  const feeBlock = feeLbl
    ? `${escapeHtml(feeLbl)}\n<code>${feeAddr}</code>`
    : `<code>${feeAddr}</code>`;

  const rawSource = payload.sourceUrl?.trim();
  const sourceLine =
    rawSource && /^https?:\/\//i.test(rawSource)
      ? `<b>Source</b> <a href="${encodeURI(rawSource)}">link</a>\n`
      : '';

  const desc = payload.tokenDescription?.trim();
  const descLine = desc ? `<i>${escapeHtml(desc.slice(0, 280))}</i>\n` : '';
  const website = payload.tokenWebsiteUrl?.trim();
  const xUrl = payload.tokenXUrl?.trim();
  const socialLine =
    website || xUrl
      ? `\n${website ? `<a href="${encodeURI(website)}">Website</a>` : ''}${website && xUrl ? ' · ' : ''}${xUrl ? `<a href="${encodeURI(xUrl)}">X</a>` : ''}\n`
      : '';

  return (
    `🚀 <b>Token deployed</b>\n\n` +
    `<b>${name}</b> ($${sym})\n` +
    descLine +
    `<b>Platform</b> ${plat}\n` +
    `<b>Deployer</b> ${deployer}\n` +
    (sourceLine || '') +
    socialLine +
    `<b>Fee recipient</b>\n${feeBlock}\n\n` +
    `<a href="${liquid}">hood.markets</a> · <a href="${launches}">Token page</a> · <a href="${explorerTx}">Tx</a>\n\n` +
    `<b>Trading</b>\n` +
    `<a href="${trade.dexscreener}">DexScreener</a> · ` +
    `<a href="${trade.uniswap}">Uniswap</a>`
  );
}

function hasAnyThreadConfigured(): boolean {
  const t = config.telegram.feedThreads;
  return !!(
    t.meme ??
    t.x ??
    t.discord ??
    t.telegram ??
    t.farcaster ??
    t.web ??
    t.agent ??
    t.deployerFeeMatch
  );
}

/**
 * Which forum topics should receive this deploy. Deduped by thread id.
 */
export function resolveTelegramFeedThreadIds(payload: TelegramDeploymentFeedPayload): number[] {
  const t = config.telegram.feedThreads;
  const ids = new Set<number>();

  const feeLower = payload.feeRecipientAddress.trim().toLowerCase();
  const isMeme = feeLower === DEAD_LOWER;
  const plat = payload.platform.trim().toLowerCase();

  /** Meme / burn — fee recipient is the dead wallet. */
  if (isMeme && t.meme != null) ids.add(t.meme);

  /** Platform channel (independent of meme — e.g. web + No Dev still pings “web” + “meme”). */
  if (plat === 'x' && t.x != null) ids.add(t.x);
  if (plat === 'discord' && t.discord != null) ids.add(t.discord);
  if (plat === 'telegram' && t.telegram != null) ids.add(t.telegram);
  if (plat === 'farcaster' && t.farcaster != null) ids.add(t.farcaster);
  if (plat === 'web' && t.web != null) ids.add(t.web);

  if (payload.feeToSelf === true && t.deployerFeeMatch != null) {
    ids.add(t.deployerFeeMatch);
  }

  return [...ids];
}

async function sendTelegramMessage(
  botToken: string,
  chatId: string,
  text: string,
  messageThreadId?: number,
): Promise<void> {
  const url = new URL(`https://api.telegram.org/bot${botToken}/sendMessage`);
  const body: Record<string, unknown> = {
    chat_id: chatId,
    text: text.slice(0, 4096),
    parse_mode: 'HTML',
    disable_web_page_preview: false,
  };
  if (messageThreadId != null && messageThreadId >= 1) {
    body.message_thread_id = messageThreadId;
  }
  const res = await fetch(url.toString(), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const errText = await res.text();
    logger.warn(
      'Telegram feed send failed:',
      res.status,
      messageThreadId ?? '(no thread)',
      errText.slice(0, 400),
    );
  }
}

/**
 * Mirror successful catalog deployments to a Telegram group (and optional forum topics).
 *
 * - With **no** `TELEGRAM_FEED_THREAD_*` vars: one message to `TELEGRAM_FEED_CHAT_ID` (legacy behavior).
 * - With **any** thread id set: posts to **each matching** topic (meme, platform, deployer-fee match); no legacy fallback unless no topic matches (then nothing sent — configure threads or rely on meme+platform coverage).
 *
 * Uses `TELEGRAM_BOT_TOKEN`. Bot must be in the group; for topics, use forum supergroup + ids from t.me links.
 */
export async function notifyTelegramDeploymentFeed(
  payload: TelegramDeploymentFeedPayload,
): Promise<void> {
  const token = config.telegram.botToken?.trim();
  const chatId = config.telegram.feedChatId?.trim();
  if (!token || !chatId) return;

  const text = buildMessageHtml(payload);

  if (!hasAnyThreadConfigured()) {
    await sendTelegramMessage(token, chatId, text, undefined);
    return;
  }

  const threads = resolveTelegramFeedThreadIds(payload);
  if (threads.length === 0) {
    logger.warn(
      'Telegram feed: topic ids are set but no rule matched this deploy — message not sent. Check TELEGRAM_FEED_THREAD_* for your platform, or clear thread envs to use legacy single-message mode.',
      { platform: payload.platform, feeToSelf: payload.feeToSelf },
    );
    return;
  }

  for (const threadId of threads) {
    await sendTelegramMessage(token, chatId, text, threadId);
  }
}
