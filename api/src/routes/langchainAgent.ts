import type { Express, Request, Response } from 'express';
import { config } from '../config.js';
import { logger } from '../logger.js';
import { createIdentity, type IdentityClaim } from '../lib/privy.js';
import { runLiquidLauncherLangchainAgent } from '../lib/langchainAgentRunner.js';

const rateLastByUser = new Map<string, number>();

function clientIp(req: Request): string {
  const xf = req.headers['x-forwarded-for'];
  if (typeof xf === 'string' && xf.length) return xf.split(',')[0]!.trim();
  return req.socket?.remoteAddress || 'unknown';
}

function rateLimitOk(userKey: string, ip: string): boolean {
  const now = Date.now();
  const windowMs = Math.max(config.botSwap.rateLimitMs, 5000);
  const k = `langchain:${userKey}|${ip}`;
  const last = rateLastByUser.get(k) ?? 0;
  if (now - last < windowMs) return false;
  rateLastByUser.set(k, now);
  return true;
}

function effectiveSecret(): string {
  return config.langchainAgent.apiSecret || config.botSwap.apiSecret;
}

function authorize(req: Request): boolean {
  const secret = effectiveSecret();
  if (!secret) return false;
  const auth = req.headers.authorization;
  if (typeof auth === 'string' && auth.startsWith('Bearer ')) {
    return auth.slice(7) === secret;
  }
  const h = req.headers['x-langchain-agent-secret'];
  return typeof h === 'string' && h === secret;
}

function parseBody(body: unknown): { identity: IdentityClaim; message: string } | null {
  if (!body || typeof body !== 'object') return null;
  const o = body as Record<string, unknown>;
  const platform = o.platform;
  const userId = o.userId;
  const message = o.message;

  if (
    platform !== 'telegram' &&
    platform !== 'discord' &&
    platform !== 'x' &&
    platform !== 'farcaster' &&
    platform !== 'github'
  ) {
    return null;
  }
  if (typeof userId !== 'string' || !userId.trim()) return null;
  if (typeof message !== 'string' || !message.trim()) return null;

  const username = typeof o.username === 'string' ? o.username : undefined;
  const discordDiscriminator =
    typeof o.discordDiscriminator === 'string' ? o.discordDiscriminator : undefined;

  const identity = createIdentity(
    platform,
    userId.trim(),
    username,
    platform === 'discord' ? discordDiscriminator : undefined,
  );

  return { identity, message: message.trim() };
}

/**
 * LangChain + OpenAI tool-calling agent (CoinGecko resolve + delegated swap preview/execute).
 *
 * Auth: `Authorization: Bearer <LANGCHAIN_AGENT_SECRET>` — if unset, uses `BOT_SWAP_API_SECRET`.
 * Requires `OPENAI_API_KEY`.
 */
export function registerLangchainAgentRoutes(app: Express): void {
  app.post('/api/agent/langchain', async (req: Request, res: Response) => {
    if (!effectiveSecret()) {
      res.status(503).json({
        ok: false,
        error:
          'LANGCHAIN_AGENT_SECRET or BOT_SWAP_API_SECRET must be set to use the LangChain agent API.',
      });
      return;
    }

    if (!config.langchainAgent.llmApiKey) {
      res.status(503).json({
        ok: false,
        error:
          'LANGCHAIN_LLM_API_KEY or OPENAI_API_KEY is not set; LangChain agent is disabled.',
      });
      return;
    }

    if (!authorize(req)) {
      res.status(401).json({ ok: false, error: 'Unauthorized' });
      return;
    }

    const parsed = parseBody(req.body);
    if (!parsed) {
      res.status(400).json({
        ok: false,
        error:
          'Invalid body. Expected: { message: string, platform: telegram|discord|x|farcaster|github, userId: string, username?, discordDiscriminator? }',
      });
      return;
    }

    const { identity, message } = parsed;
    const userKey = `${identity.platform}:${identity.userId}`;
    if (!rateLimitOk(userKey, clientIp(req))) {
      res.status(429).json({ ok: false, error: 'Rate limited. Try again shortly.' });
      return;
    }

    try {
      const { output } = await runLiquidLauncherLangchainAgent({ userMessage: message, identity });
      res.status(200).json({ ok: true, reply: output });
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : 'agent failed';
      logger.error('POST /api/agent/langchain', { msg });
      res.status(500).json({ ok: false, error: msg });
    }
  });
}
