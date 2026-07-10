import {
  countDeployerDeploymentsCurrentEasternDay,
  getNewestDeployerDeploymentCurrentEasternDay,
  type DeploymentCatalogRow,
} from './deploymentCatalog.js';
import { config } from '../config.js';
import { getEasternDayRangeUtc } from './easternDay.js';

const WEB_BASE = (process.env.LAUNCHER_WEB_URL || 'https://hood.markets').replace(/\/$/, '');
const EASTERN_TZ = 'America/New_York';

export type AgentXDailyLimitToken = {
  tokenName: string;
  tokenSymbol: string;
  tokenAddress: string;
  createdAt: string;
  tokenPageUrl: string;
};

export type AgentXDeployLimitStatus = {
  limited: boolean;
  used: number;
  max: number;
  todayToken: AgentXDailyLimitToken | null;
  resetsAt: string;
  resetsAtEastern: string;
  websiteUrl: string;
};

/** Eastern-day cap for X/Bankr agent launches (`0` = unlimited). */
export function maxAgentXDeploysPerEasternDay(): number {
  return config.agentDeploy.maxXDeploysPerEasternDay;
}

export function isAgentXChannel(channel: string | null | undefined): boolean {
  if (!channel) return false;
  const c = channel.trim().toLowerCase();
  return c === 'x' || c === 'twitter' || c === 'tweet';
}

export function formatEasternResetLabel(now: Date = new Date()): string {
  const { end } = getEasternDayRangeUtc(now);
  return new Intl.DateTimeFormat('en-US', {
    timeZone: EASTERN_TZ,
    weekday: 'short',
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
    timeZoneName: 'short',
  }).format(end);
}

function tokenFromRow(row: DeploymentCatalogRow | null): AgentXDailyLimitToken | null {
  if (!row) return null;
  const sym = row.tokenSymbol.replace(/^\$/, '').trim();
  return {
    tokenName: row.tokenName,
    tokenSymbol: sym,
    tokenAddress: row.tokenAddress,
    createdAt: row.createdAt,
    tokenPageUrl: `${WEB_BASE}/?token=${row.tokenAddress}`,
  };
}

function formatTokenLine(token: AgentXDailyLimitToken): string {
  const sym = token.tokenSymbol ? `$${token.tokenSymbol}` : '';
  const name = token.tokenName?.trim();
  if (sym && name) return `${sym} (${name})`;
  return sym || name || token.tokenAddress;
}

export async function getAgentXDeployLimitStatus(
  deployerId: string,
): Promise<AgentXDeployLimitStatus> {
  const max = maxAgentXDeploysPerEasternDay();
  const { end } = getEasternDayRangeUtc();
  const base: AgentXDeployLimitStatus = {
    limited: false,
    used: 0,
    max,
    todayToken: null,
    resetsAt: end.toISOString(),
    resetsAtEastern: formatEasternResetLabel(),
    websiteUrl: WEB_BASE,
  };

  if (max <= 0 || !deployerId.startsWith('agent:')) return base;

  const used = await countDeployerDeploymentsCurrentEasternDay('web', deployerId);
  const todayRow = used > 0
    ? await getNewestDeployerDeploymentCurrentEasternDay('web', deployerId)
    : null;

  return {
    ...base,
    used,
    limited: used >= max,
    todayToken: tokenFromRow(todayRow),
  };
}

export type AgentXDeployLimitBlock = {
  message: string;
  replyHint: string;
  status: AgentXDeployLimitStatus;
};

export async function buildAgentXDeployLimitBlock(
  deployerId: string,
): Promise<AgentXDeployLimitBlock> {
  const status = await getAgentXDeployLimitStatus(deployerId);
  const max = status.max;
  const launchWord = max === 1 ? 'launch' : 'launches';

  const tokenPart = status.todayToken
    ? `Today's token: ${formatTokenLine(status.todayToken)} — ${status.todayToken.tokenPageUrl}`
    : "You've used your X launch for today.";

  const message =
    `You can only launch ${max} token per day on @bankrbot (X). ${tokenPart} ` +
    `For more launches today, deploy at ${WEB_BASE} — sign in and pay gas from your wallet. ` +
    `Your X limit resets ${status.resetsAtEastern}.`;

  const replyHint = status.todayToken
    ? (
        `Daily @bankrbot X limit reached — you already launched ${formatTokenLine(status.todayToken)} today: ` +
        `${status.todayToken.tokenPageUrl} ` +
        `Launch more at ${WEB_BASE} (wallet). Resets ${status.resetsAtEastern}.`
      )
    : (
        `Daily @bankrbot X limit reached (${max} ${launchWord}/day). ` +
        `Launch more at ${WEB_BASE}. Resets ${status.resetsAtEastern}.`
      );

  return { message, replyHint, status };
}

/** `null` when under limit. */
export async function agentXDeployLimitErrorOrNull(deployerId: string): Promise<string | null> {
  const block = await buildAgentXDeployLimitBlock(deployerId);
  if (!block.status.limited) return null;
  return block.message;
}

/** @deprecated X agent no longer supports paid relaunches — kept for imports only. */
export function agentXDeployLimitUserMessage(): string {
  const max = maxAgentXDeploysPerEasternDay();
  if (max <= 0) return 'Deploy rate limit reached. Try again later.';
  return (
    `You can only launch ${max} token per day on @bankrbot (X). ` +
    `For more launches today, visit ${WEB_BASE}. Resets at midnight Eastern.`
  );
}

/** @deprecated Use buildAgentXDeployLimitBlock().replyHint */
export function agentXDeployLimitReplyHint(): string {
  return (
    `Daily @bankrbot X limit reached. Launch more at ${WEB_BASE} (wallet). Resets midnight Eastern.`
  );
}

/** @deprecated Paid X relaunches removed. */
export function agentXDeployPaymentReplyHint(): string {
  return agentXDeployLimitReplyHint();
}
