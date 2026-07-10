import { getAddress } from 'viem';
import { launcherAppLaunchesTokenUrl } from './launcherAppUrl.js';

export type TradeSide = 'buy' | 'sell';

export interface ParsedTradeIntent {
  side: TradeSide;
  /** Checksummed Base contract */
  address: `0x${string}`;
  /** Optional human amount from chat. Buy = ETH amount. Sell = token units. */
  amount?: string;
}

/**
 * Parses natural chat text: `buy 0x…` / `buyu 0x…` (common typo) / `sell 0x…`.
 * Optional amount may follow the token address, e.g. `buy 0x... 0.01`.
 * First matching phrase wins (case-insensitive).
 */
export function parseTradeIntentMessage(text: string): ParsedTradeIntent | null {
  const t = text.trim();
  if (!t) return null;

  const buy = /(?:^|[\s,.:;!])(?:buy|buyu)\s+(0x[a-fA-F0-9]{40})\b(?:\s+([0-9]*\.?[0-9]+))?/i.exec(t);
  if (buy?.[1]) {
    try {
      return {
        side: 'buy',
        address: getAddress(buy[1] as `0x${string}`),
        amount: buy[2] || undefined,
      };
    } catch {
      return null;
    }
  }

  const sell = /(?:^|[\s,.:;!])sell\s+(0x[a-fA-F0-9]{40})\b(?:\s+([0-9]*\.?[0-9]+))?/i.exec(t);
  if (sell?.[1]) {
    try {
      return {
        side: 'sell',
        address: getAddress(sell[1] as `0x${string}`),
        amount: sell[2] || undefined,
      };
    } catch {
      return null;
    }
  }

  return null;
}

/** Deep link: Launches tab, token row, swap open, buy vs sell mode. */
export function launcherTradeDeepLink(address: string, side: TradeSide): string {
  return launcherAppLaunchesTokenUrl(address, { openSwap: true, side });
}
