import { getAddress, isAddress, type Address } from 'viem';
import { config } from '../config.js';
import { readAgentCaptchaToken, verifyAgentCaptchaJwt } from './agentCaptchaVerify.js';

export type AgentWalletAuthMethod = 'captcha' | 'x_confirm' | 'trusted_agent';

export type ResolvedAgentWalletAuth = {
  walletAddress: Address;
  agentId?: string;
  auth: AgentWalletAuthMethod;
  agentChannel?: string;
};

const X_CHANNEL_ALIASES = new Set(['x', 'twitter', 'tweet']);

export type AgentChannelBody = {
  agentChannel?: unknown;
  agentRuntime?: unknown;
};

function headerValue(
  headers: { [k: string]: string | string[] | undefined },
  name: string,
): string {
  const header = headers[name] ?? headers[name.replace(/-([a-z])/g, (_, c: string) => c.toUpperCase())];
  if (typeof header === 'string') return header.trim();
  if (Array.isArray(header)) return header[0]?.trim() ?? '';
  return '';
}

/** Normalize X/Twitter channel tags from body or `x-agent-channel` header. */
export function normalizeAgentChannel(
  headers: { [k: string]: string | string[] | undefined },
  body: AgentChannelBody,
): string | null {
  const fromHeader = headerValue(headers, 'x-agent-channel').toLowerCase();
  const bodyChannel =
    typeof body.agentChannel === 'string' ? body.agentChannel.trim().toLowerCase() : '';
  const runtime =
    typeof body.agentRuntime === 'string' ? body.agentRuntime.trim().toLowerCase() : '';

  let raw = bodyChannel || fromHeader;
  if (!raw && (runtime === 'x' || runtime.includes('twitter'))) raw = 'x';
  if (!raw) return null;

  if (X_CHANNEL_ALIASES.has(raw)) return 'x';
  return raw;
}

export function captchaSkippedForChannel(channel: string | null): boolean {
  if (config.agentDeploy.skipCaptchaGlobal) return true;
  if (!channel) return false;
  const allowed = config.agentDeploy.skipCaptchaChannels;
  if (allowed.has(channel)) return true;
  if (channel === 'x' && (allowed.has('twitter') || allowed.has('tweet'))) return true;
  return false;
}

export function agentDeploySkipCaptchaForRequest(
  headers: { [k: string]: string | string[] | undefined },
  body: AgentChannelBody,
): { skip: boolean; channel: string | null } {
  const channel = normalizeAgentChannel(headers, body);
  return { skip: captchaSkippedForChannel(channel), channel };
}

function walletFromHeader(
  headers: { [k: string]: string | string[] | undefined },
): Address | null {
  const raw = headerValue(headers, 'x-wallet-address');
  if (!raw || !isAddress(raw)) return null;
  try {
    return getAddress(raw);
  } catch {
    return null;
  }
}

function walletFromAgentBody(body: {
  agentFeeRecipient?: unknown;
  wallet?: unknown;
}): Address | null {
  for (const field of [body.agentFeeRecipient, body.wallet]) {
    if (typeof field !== 'string') continue;
    const raw = field.trim();
    if (!raw || !isAddress(raw)) continue;
    try {
      return getAddress(raw);
    } catch {
      continue;
    }
  }
  return null;
}

/**
 * Authorize `feeTarget: agent_wallet` deploys/claims.
 * - Default: X-Agent-Captcha-JWT (haiku) binds the fee wallet — automatable for API agents.
 * - X/Twitter (`agentChannel: x`): wallet-only after in-thread user confirm (Bankr UX).
 * - `AGENT_DEPLOY_SKIP_CAPTCHA=true`: legacy global wallet-only skip.
 */
export async function resolveAgentWalletAuth(
  headers: { [k: string]: string | string[] | undefined },
  body: {
    agentCaptchaJwt?: string;
    agentFeeRecipient?: unknown;
    wallet?: unknown;
    agentChannel?: unknown;
    agentRuntime?: unknown;
  },
): Promise<ResolvedAgentWalletAuth> {
  const captchaJwt = readAgentCaptchaToken(headers, body);
  if (captchaJwt) {
    const captchaPayload = await verifyAgentCaptchaJwt(captchaJwt);
    const walletAddress = getAddress(captchaPayload.walletAddress);
    return {
      walletAddress,
      agentId: captchaPayload.agentId,
      auth: 'captcha',
    };
  }

  const { skip, channel } = agentDeploySkipCaptchaForRequest(headers, body);
  if (skip) {
    const walletAddress = walletFromAgentBody(body) ?? walletFromHeader(headers);
    if (!walletAddress) {
      throw new Error(
        'Agent deploy requires a wallet when captcha is skipped — set agentFeeRecipient or wallet in JSON, or x-wallet-address header.',
      );
    }
    return {
      walletAddress,
      auth: channel === 'x' && !config.agentDeploy.skipCaptchaGlobal ? 'x_confirm' : 'trusted_agent',
      agentChannel: channel ?? undefined,
    };
  }

  throw new Error(
    'Agent deploy requires X-Agent-Captcha-JWT header or agentCaptchaJwt in body. For X/Twitter, pass agentChannel: "x" (or x-agent-channel header) after the user confirms in-thread.',
  );
}

/** @deprecated Use agentDeploySkipCaptchaForRequest — kept for callers that only need a boolean. */
export function agentDeploySkipCaptchaEnabled(): boolean {
  return config.agentDeploy.skipCaptchaGlobal;
}
