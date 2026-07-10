import { config } from '../config.js';
import { logger } from '../logger.js';
import { runLiquidLauncherLangchainAgent } from './langchainAgentRunner.js';
import type { IdentityClaim } from './privy.js';

export function isChatAgentConfigured(): boolean {
  return Boolean(config.langchainAgent.llmApiKey?.trim());
}

/**
 * In-process LangChain agent (same as POST /api/agent/langchain) for platform bots.
 */
export async function runChatAgentForIdentity(input: {
  identity: IdentityClaim;
  userMessage: string;
}): Promise<{ output: string }> {
  try {
    return await runLiquidLauncherLangchainAgent({
      userMessage: input.userMessage,
      identity: input.identity,
    });
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : String(e);
    logger.error('runChatAgentForIdentity failed', { msg });
    throw e;
  }
}

export function truncateForTelegram(text: string, max = 4096): string {
  const t = text.trim();
  if (t.length <= max) return t;
  return `${t.slice(0, max - 1)}…`;
}

export function truncateForDiscord(text: string, max = 2000): string {
  const t = text.trim();
  if (t.length <= max) return t;
  return `${t.slice(0, max - 1)}…`;
}

/** Farcaster reply casts — stay under typical client limits. */
export function truncateForFarcaster(text: string, max = 300): string {
  const t = text.trim();
  if (t.length <= max) return t;
  return `${t.slice(0, max - 1)}…`;
}

/** X v2 single tweet — short mode. */
export function truncateForX(text: string, max = 275): string {
  const t = text.trim();
  if (t.length <= max) return t;
  return `${t.slice(0, max - 1)}…`;
}
