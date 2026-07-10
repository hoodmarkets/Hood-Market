import { decodeJwt, jwtVerify } from 'jose';
import { getAddress } from 'viem';
import { config } from '../config.js';
import { logger } from '../logger.js';

/**
 * Verifies a JWT issued after solving agent-captcha.
 * The JWT must include `type: "agent_verified"` and `walletAddress` (0x… on Base).
 *
 * This service must use the **same symmetric secret** as your CAPTCHA service:
 * set Railway `AGENT_CAPTCHA_JWT_SECRET` to the **same value** as your CAPTCHA `JWT_SECRET`.
 *
 * Development: `AGENT_CAPTCHA_SKIP_VERIFY=true` decodes only (never in production).
 */
export interface AgentCaptchaPayload {
  type: string;
  walletAddress: string;
  agentId?: string;
  [key: string]: unknown;
}

export async function verifyAgentCaptchaJwt(token: string): Promise<AgentCaptchaPayload> {
  const t = token.trim();
  if (!t) {
    throw new Error('Missing agent captcha JWT');
  }

  if (config.agentCaptcha.skipVerify) {
    logger.warn('AGENT_CAPTCHA_SKIP_VERIFY: accepting agent captcha JWT without verification');
    let p: AgentCaptchaPayload;
    try {
      p = decodeJwt(t) as AgentCaptchaPayload;
    } catch {
      throw new Error('Invalid agent captcha JWT structure');
    }
    if (p.type !== 'agent_verified') {
      throw new Error('Invalid agent captcha JWT: expected type agent_verified');
    }
    if (!p.walletAddress) {
      throw new Error('Invalid agent captcha JWT: missing walletAddress');
    }
    // Validate wallet address format
    try {
      getAddress(p.walletAddress);
    } catch {
      throw new Error('Invalid agent captcha JWT: walletAddress is not a valid Ethereum address');
    }
    return p;
  }

  const secret = config.agentCaptcha.jwtSecret;
  if (!secret) {
    throw new Error(
      'Agent captcha deploy requires AGENT_CAPTCHA_JWT_SECRET (HS256) matching your CAPTCHA JWT_SECRET, or set AGENT_CAPTCHA_SKIP_VERIFY=true for local dev only.',
    );
  }

  try {
    const { payload } = await jwtVerify(t, new TextEncoder().encode(secret), {
      algorithms: ['HS256'],
    });
    if (payload.type !== 'agent_verified') {
      throw new Error('JWT payload type must be agent_verified');
    }
    if (!payload.walletAddress) {
      throw new Error('JWT payload missing walletAddress');
    }
    // Validate wallet address format
    try {
      getAddress(payload.walletAddress as string);
    } catch {
      throw new Error('Invalid walletAddress in JWT: not a valid Ethereum address');
    }
    return payload as AgentCaptchaPayload;
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : String(e);
    throw new Error(`Agent captcha JWT invalid: ${msg}`);
  }
}

/** Read captcha token from `X-Agent-Captcha-JWT` header or body field. */
export function readAgentCaptchaToken(
  headers: { [k: string]: string | string[] | undefined },
  body: { agentCaptchaJwt?: string },
): string | null {
  const h = headers['x-agent-captcha-jwt'] ?? headers['X-Agent-Captcha-JWT'];
  const fromHeader = typeof h === 'string' ? h.trim() : Array.isArray(h) ? h[0]?.trim() : '';
  if (fromHeader) {
    if (fromHeader.startsWith('Bearer ')) return fromHeader.slice('Bearer '.length).trim();
    return fromHeader;
  }
  if (typeof body.agentCaptchaJwt === 'string' && body.agentCaptchaJwt.trim()) {
    return body.agentCaptchaJwt.trim();
  }
  return null;
}
