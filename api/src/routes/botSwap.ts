import type { Express, Request, Response } from 'express';
import { getAddress, isAddress } from 'viem';
import { config } from '../config.js';
import { logger } from '../logger.js';
import { executeBotSwap, type QuoteProvider } from '../lib/delegatedSwapExecution.js';
import { createIdentity, type IdentityClaim } from '../lib/privy.js';

const rateLastByUser = new Map<string, number>();

function clientIp(req: Request): string {
  const xf = req.headers['x-forwarded-for'];
  if (typeof xf === 'string' && xf.length) return xf.split(',')[0]!.trim();
  return req.socket?.remoteAddress || 'unknown';
}

function rateLimitOk(userKey: string, ip: string): boolean {
  const now = Date.now();
  const windowMs = config.botSwap.rateLimitMs;
  const k = `${userKey}|${ip}`;
  const last = rateLastByUser.get(k) ?? 0;
  if (now - last < windowMs) return false;
  rateLastByUser.set(k, now);
  return true;
}

function authorize(req: Request): boolean {
  const secret = config.botSwap.apiSecret;
  if (!secret) return false;
  const auth = req.headers.authorization;
  if (typeof auth === 'string' && auth.startsWith('Bearer ')) {
    return auth.slice(7) === secret;
  }
  const h = req.headers['x-bot-swap-secret'];
  return typeof h === 'string' && h === secret;
}

function parseBody(body: unknown): {
  identity: IdentityClaim;
  token: `0x${string}`;
  side: 'buy' | 'sell';
  quoteProvider?: QuoteProvider;
} | null {
  if (!body || typeof body !== 'object') return null;
  const o = body as Record<string, unknown>;
  const platform = o.platform;
  const userId = o.userId;
  const side = o.side;
  const tokenAddress = o.tokenAddress;
  if (
    platform !== 'telegram' &&
    platform !== 'discord' &&
    platform !== 'x' &&
    platform !== 'farcaster'
  ) {
    return null;
  }
  if (typeof userId !== 'string' || !userId.trim()) return null;
  if (side !== 'buy' && side !== 'sell') return null;
  if (typeof tokenAddress !== 'string' || !isAddress(tokenAddress)) return null;

  const username = typeof o.username === 'string' ? o.username : undefined;
  const discordDiscriminator =
    typeof o.discordDiscriminator === 'string' ? o.discordDiscriminator : undefined;
  let quoteProvider: QuoteProvider | undefined;
  if (o.quoteProvider === '0x' || o.quoteProvider === 'odos') {
    quoteProvider = o.quoteProvider;
  }

  const identity = createIdentity(
    platform,
    userId.trim(),
    username,
    platform === 'discord' ? discordDiscriminator : undefined,
  );

  return {
    identity,
    token: getAddress(tokenAddress),
    side,
    quoteProvider,
  };
}

/**
 * Authenticated server execution for delegated swaps (Telegram/Discord/agents).
 *
 * Auth: `Authorization: Bearer <BOT_SWAP_API_SECRET>` or header `X-Bot-Swap-Secret`.
 *
 * Complements Privy **dashboard policies** (spend limits, allowed contracts): enforce matching
 * server-side caps via `BOT_SWAP_MAX_ETH` and router allowlist (`botSwapPolicy.ts`).
 */
export function registerBotSwapRoutes(app: Express): void {
  app.post('/api/bot/swap', async (req: Request, res: Response) => {
    if (!config.botSwap.apiSecret) {
      res.status(503).json({
        ok: false,
        error: 'BOT_SWAP_API_SECRET is not set; bot swap API is disabled.',
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
          'Invalid body. Expected: { platform, userId, side, tokenAddress, username?, discordDiscriminator?, quoteProvider? }',
      });
      return;
    }

    const { identity, token, side, quoteProvider } = parsed;
    const userKey = `${identity.platform}:${identity.userId}`;
    if (!rateLimitOk(userKey, clientIp(req))) {
      res.status(429).json({ ok: false, error: 'Rate limited. Try again shortly.' });
      return;
    }

    try {
      const result = await executeBotSwap(
        identity,
        { side, address: token },
        quoteProvider ? { quoteProvider } : undefined,
      );
      if (result.ok) {
        res.status(200).json({
          ok: true,
          transactionHash: result.transactionHash,
          basescanUrl: result.basescanUrl,
          quoteProvider: result.quoteProvider,
        });
      } else {
        res.status(400).json({
          ok: false,
          error: result.error,
          ...(result.hint ? { hint: result.hint } : {}),
        });
      }
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : 'swap failed';
      logger.error('POST /api/bot/swap', { msg });
      res.status(500).json({ ok: false, error: msg });
    }
  });
}
