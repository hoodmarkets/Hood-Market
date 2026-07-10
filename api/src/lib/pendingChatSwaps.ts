import crypto from 'crypto';
import type { ParsedTradeIntent } from './tradeIntent.js';

export type PendingChatSwap =
  | {
      kind: 'telegram';
      telegramUserId: string;
      username?: string;
      intent: ParsedTradeIntent;
      createdAt: number;
    }
  | {
      kind: 'discord';
      discordUserId: string;
      username?: string;
      discriminator?: string;
      intent: ParsedTradeIntent;
      createdAt: number;
    };

const pending = new Map<string, PendingChatSwap>();
const TTL_MS = 10 * 60 * 1000;

export type PendingChatSwapInput =
  | Omit<Extract<PendingChatSwap, { kind: 'telegram' }>, 'createdAt'>
  | Omit<Extract<PendingChatSwap, { kind: 'discord' }>, 'createdAt'>;

function randomId(): string {
  return crypto.randomBytes(12).toString('hex');
}

export function createPendingChatSwap(entry: PendingChatSwapInput & { createdAt?: number }): string {
  const id = randomId();
  const createdAt = entry.createdAt ?? Date.now();
  if (entry.kind === 'telegram') {
    pending.set(id, {
      kind: 'telegram',
      telegramUserId: entry.telegramUserId,
      username: entry.username,
      intent: entry.intent,
      createdAt,
    });
  } else {
    pending.set(id, {
      kind: 'discord',
      discordUserId: entry.discordUserId,
      username: entry.username,
      discriminator: entry.discriminator,
      intent: entry.intent,
      createdAt,
    });
  }
  return id;
}

export function takePendingChatSwap(id: string): PendingChatSwap | null {
  const row = pending.get(id);
  if (!row) return null;
  if (Date.now() - row.createdAt > TTL_MS) {
    pending.delete(id);
    return null;
  }
  pending.delete(id);
  return row;
}

export function peekPendingChatSwap(id: string): PendingChatSwap | null {
  const row = pending.get(id);
  if (!row) return null;
  if (Date.now() - row.createdAt > TTL_MS) {
    pending.delete(id);
    return null;
  }
  return row;
}
