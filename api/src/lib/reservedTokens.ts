import { config } from '../config.js';
import {
  compactTokenNameForBlocklist,
  normalizeTokenNameForBlocklist,
} from './blocklistNormalize.js';

/** Reserved / misleading tickers (see `config.tickerBlocklist`, env `TICKER_BLOCKLIST`). */
export function isReservedTicker(symbol: string): boolean {
  const s = symbol
    .trim()
    .toUpperCase()
    .replace(/^\$/u, '')
    .slice(0, 10);
  if (!s) return false;
  return config.tickerBlocklist.has(s);
}

/** Reserved token display names — exact + compact match (env `NAME_BLOCKLIST`). */
export function isReservedTokenName(name: string): boolean {
  const n = normalizeTokenNameForBlocklist(name);
  const c = compactTokenNameForBlocklist(name);
  if (n.length < 2 && c.length < 2) return false;
  return config.nameBlocklist.has(n) || config.nameBlocklist.has(c);
}

export function reservedTickerUserMessage(symbol: string): string {
  const s = symbol.trim().toUpperCase().replace(/^\$/u, '').slice(0, 10);
  return `This ticker ($${s}) is on the reserved list (misleading or protected symbols). Choose a different symbol.`;
}

export function reservedNameUserMessage(): string {
  return 'This token name is on the reserved list. Choose a different name.';
}
