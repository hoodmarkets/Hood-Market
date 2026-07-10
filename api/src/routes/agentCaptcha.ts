import type { Express, Request, Response } from 'express';
import { getAddress, type Address } from 'viem';
import { SignJWT } from 'jose';
import { config } from '../config.js';
import { logger } from '../logger.js';
import { generateChallenge, verifyChallenge, markChallengeUsed } from '../lib/agentCaptchaChallenge.js';

export function registerAgentCaptchaRoutes(app: Express): void {
  /**
   * GET /api/agent-captcha/challenge
   * Returns a haiku challenge for the agent to solve
   */
  app.get('/api/agent-captcha/challenge', (req: Request, res: Response) => {
    try {
      const session = generateChallenge();
      res.json({
        sessionId: session.sessionId,
        challenge: session.challenge,
        timeLimit: session.timeLimit,
        expiresIn: Math.round((session.expiresAt - Date.now()) / 1000),
      });
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : String(e);
      logger.error('Agent captcha challenge error', { error: msg });
      res.status(500).json({ error: 'Failed to generate challenge' });
    }
  });

  /**
   * POST /api/agent-captcha/verify
   * Verify the haiku response and issue JWT
   *
   * Body:
   * {
   *   sessionId: string,
   *   response: string (haiku),
   *   agentFeeRecipient: string (0x wallet),
   *   name: string (token name),
   *   symbol: string (token symbol),
   *   description?: string,
   *   imageUrl?: string,
   *   clientKind?: string,
   *   agentProvider?: string,
   *   agentRuntime?: string,
   *   walletKind?: string
   * }
   */
  app.post('/api/agent-captcha/verify', async (req: Request, res: Response) => {
    try {
      const { sessionId, response, agentFeeRecipient } = req.body;

      // Validate inputs
      if (!sessionId || typeof sessionId !== 'string') {
        res.status(400).json({ error: 'Missing or invalid sessionId' });
        return;
      }

      if (!response || typeof response !== 'string') {
        res.status(400).json({ error: 'Missing or invalid response' });
        return;
      }

      if (!agentFeeRecipient || typeof agentFeeRecipient !== 'string') {
        res.status(400).json({ error: 'Missing or invalid agentFeeRecipient' });
        return;
      }

      // Validate wallet address
      let walletAddress: Address;
      try {
        walletAddress = getAddress(agentFeeRecipient);
      } catch {
        res.status(400).json({ error: 'Invalid agentFeeRecipient address' });
        return;
      }

      // Verify challenge
      const verification = verifyChallenge(sessionId, response);
      if (!verification.valid) {
        res.status(400).json({ error: verification.error });
        return;
      }

      // Mark challenge as used (one deployment per challenge)
      const marked = markChallengeUsed(sessionId);
      if (!marked) {
        res.status(400).json({ error: 'Challenge already used or expired' });
        return;
      }

      // Create JWT
      const secret = config.agentCaptcha.jwtSecret;
      if (!secret) {
        logger.error('AGENT_CAPTCHA_JWT_SECRET not configured');
        res.status(500).json({ error: 'JWT signing not configured' });
        return;
      }

      const JWT_TTL = 8 * 60 * 60; // 8 hours — plenty of time to deploy, claim, explore
      const jwt = await new SignJWT({
        type: 'agent_verified',
        walletAddress,
        iat: Math.floor(Date.now() / 1000),
        exp: Math.floor(Date.now() / 1000) + JWT_TTL,
      })
        .setProtectedHeader({ alg: 'HS256' })
        .sign(new TextEncoder().encode(secret));

      logger.info('Agent captcha verified and JWT issued', {
        sessionId,
        walletAddress,
      });

      res.json({
        jwt,
        walletAddress,
        expiresIn: JWT_TTL,
        hint: 'JWT valid for 8 hours. Use it to deploy (POST /api/deploy) and claim fees (POST /api/agent/claim) — no need to re-solve the haiku.',
      });
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : String(e);
      logger.error('Agent captcha verify error', { error: msg });
      res.status(500).json({ error: 'Verification failed' });
    }
  });
}
