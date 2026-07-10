import { pathToFileURL } from 'node:url';
import { logger } from './logger.js';
import { extractImageUrlFromText } from './lib/imageSources.js';

function isMainModule(): boolean {
  const entry = process.argv[1];
  if (!entry) return false;
  try {
    return import.meta.url === pathToFileURL(entry).href;
  } catch {
    return false;
  }
}

export interface ParsedLaunchRequest {
  name?: string;
  symbol?: string;
  walletAddress?: string;
  imageUrl?: string;
  description?: string;
  devBuyAmount?: string; // ETH amount
  isValid: boolean;
  missingFields: string[];
}

// Common patterns
const WALLET_PATTERN = /0x[a-fA-F0-9]{40}/;
const DEV_BUY_PATTERN = /(\d+\.?\d*)\s*(?:eth|ETH)/;

/** Strip meme / no-dev fee phrases so they are not swallowed into token name (X / Farcaster). */
function stripMemeFeeNoise(s: string): string {
  return s
    .replace(/\bno[\s_-]*dev\b/gi, ' ')
    .replace(/\bmeme\??\b/gi, ' ')
    .replace(/\bfees?\s+to\s+no\s+(one|body)\b/gi, ' ')
    .replace(/\bfees?\s+to\s+(the\s+)?(burn|dead)\b/gi, ' ')
    .replace(/\bno\s+one\s+(gets\s+)?(the\s+)?fees?\b/gi, ' ')
    .replace(/\bunclaimable\s+fees?\b/gi, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function normalizeTicker(raw: string): string {
  return raw.toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 10);
}

function sanitizeDisplayName(raw: string): string {
  return raw.replace(/[^a-zA-Z0-9\s]/g, '').trim().slice(0, 64);
}

/**
 * Parse a tweet/message for token deployment parameters
 *
 * Examples:
 * - "@liquidlauncher deploy MyToken MTK 0x123..."
 * - "deploy deadx deadx no dev" → name deadx, symbol DEADX
 * - "deploy deadx ticker dx" → name deadx, symbol DX
 * - "launch $PEPE with 0.5 eth dev buy to 0xABC..."
 */
export function parseLaunchRequest(text: string): ParsedLaunchRequest {
  const result: ParsedLaunchRequest = {
    isValid: false,
    missingFields: [],
  };

  const cleanText = text
    .replace(/@\w+/g, '')
    .replace(/#\w+/g, '')
    .replace(/\s+/g, ' ')
    .trim();

  const body = stripMemeFeeNoise(cleanText)
    .replace(/[.!?]+$/g, '')
    .trim();

  logger.debug('Parsing launch request:', { cleanText, body });

  const walletMatch = cleanText.match(WALLET_PATTERN);
  if (walletMatch) {
    result.walletAddress = walletMatch[0];
  }

  result.imageUrl = extractImageUrlFromText(cleanText);

  const devBuyMatch = cleanText.match(DEV_BUY_PATTERN);
  if (devBuyMatch) {
    result.devBuyAmount = devBuyMatch[1];
  }

  let name: string | undefined;
  let symbol: string | undefined;

  const work = body.replace(WALLET_PATTERN, '').replace(/\s+/g, ' ').trim();

  // 1) deploy NAME ticker SYM
  const tickerPhrase = work.match(
    /^(?:deploy|launch|create|make)\s+(\S+)\s+ticker\s+(\S+)/i,
  );
  if (tickerPhrase) {
    const rawName = sanitizeDisplayName(tickerPhrase[1]);
    const rawTicker = tickerPhrase[2];
    name = rawName;
    // "deploy foo ticker foo" → one ticker, not doubled
    if (rawName.toLowerCase() === rawTicker.toLowerCase()) {
      symbol = normalizeTicker(rawName);
    } else {
      symbol = normalizeTicker(rawTicker);
    }
  }

  // 2) deploy NAME SYMBOL — exactly two tokens after command (optional trailing wallet already stripped)
  if (!name || !symbol) {
    const twoOnly = work.match(/^(?:deploy|launch|create|make)\s+(\S+)\s+(\S+)\s*$/i);
    if (twoOnly && twoOnly[2].toLowerCase() !== 'ticker') {
      name = sanitizeDisplayName(twoOnly[1]);
      symbol = normalizeTicker(twoOnly[2]);
    }
  }

  // 3) $TICKER (any case)
  if (!symbol) {
    const dollar = cleanText.match(/\$([A-Za-z0-9]{2,10})\b/);
    if (dollar) {
      symbol = normalizeTicker(dollar[1]);
    }
  }

  // 4) Standalone ALL CAPS words (tickers)
  if (!symbol) {
    const capsWords = cleanText.match(/\b[A-Z]{2,10}\b/g);
    if (capsWords) {
      const commonWords = ['ETH', 'BASE', 'SOL', 'BTC', 'NFT', 'DAO', 'DEFI', 'WEB3'];
      const filtered = capsWords.filter((w) => !commonWords.includes(w));
      if (filtered.length > 0) {
        symbol = normalizeTicker(filtered[0]);
      }
    }
  }

  // 5) Token name — patterns (longer tweets, "called", etc.)
  if (!name) {
    const namePatterns = [
      /(?:deploy|launch|create|make)\s+["']?([A-Za-z0-9\s]+?)["']?\s+(?:0x|https?:\/\/|\$|[A-Z]{2,10}\s+0x)/i,
      /(?:deploy|launch|create|make)\s+["']?([A-Za-z0-9\s]+?)["']?\s*$/i,
      /(?:called|named?)\s+["']?([^"']{2,32})["']?/i,
      /(?:name[:\s]+)["']?([^"']{2,32})["']?/i,
    ];

    for (const pattern of namePatterns) {
      const nameMatch = body.match(pattern);
      if (nameMatch) {
        name = sanitizeDisplayName(nameMatch[1]);
        break;
      }
    }
  }

  // 6) Words before detected symbol
  if (!name && symbol) {
    const beforeSymbol = cleanText
      .split(new RegExp(symbol.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i'))[0]
      ?.trim() ?? '';
    const words = beforeSymbol.split(' ').filter((w) => w.length > 2);
    if (words.length > 0) {
      const potentialName = words
        .slice(-3)
        .join(' ')
        .replace(/[^a-zA-Z0-9\s]/g, '')
        .trim();
      if (potentialName.length >= 2 && potentialName.length <= 32) {
        name = potentialName;
      }
    }
  }

  // 7) Derive symbol from name — never squash a multi-word name into one ticker
  if (name && !symbol) {
    const parts = name.split(/\s+/).filter(Boolean);
    if (parts.length === 1) {
      symbol = normalizeTicker(parts[0]);
    } else if (parts.length > 1) {
      symbol = normalizeTicker(parts[parts.length - 1]!);
      name = parts.slice(0, -1).join(' ');
    }
  }

  result.name = name;
  result.symbol = symbol;

  if (!result.symbol) {
    result.missingFields.push('symbol');
  }
  if (!result.name) {
    result.missingFields.push('token name');
  }

  result.isValid = result.name !== undefined && result.symbol !== undefined;

  logger.debug('Parsed result:', result);
  return result;
}

/**
 * Generate a friendly prompt asking for missing info
 */
export function generateMissingFieldsPrompt(parsed: ParsedLaunchRequest): string {
  if (parsed.missingFields.length === 0) {
    return '';
  }

  const prompts: Record<string, string> = {
    'token name': "What's the token name?",
    symbol: "What's the token symbol? (e.g., TEST)",
    'wallet address': "What's your wallet address for fee recipient? (0x...)",
  };

  return parsed.missingFields
    .map((f) => prompts[f] || `Please provide: ${f}`)
    .join('\n');
}

/**
 * Extract user-written description from a launch post (X, etc.) — name/symbol/deploy noise stripped.
 * Keeps paragraph breaks; caps length for on-chain metadata.
 */
export function extractDescription(
  text: string,
  name?: string,
  symbol?: string,
  maxLen = 4000,
): string {
  let desc = text
    .replace(/@\w+/g, '')
    .replace(/#\w+/g, '')
    .replace(/https?:\/\/[^\s]+/g, '')
    .replace(/0x[a-fA-F0-9]{40}/g, '')
    .replace(/\$[A-Za-z0-9]+/g, '')
    .replace(/\d+\.?\d*\s*(?:eth|ETH)/g, '');

  if (name) desc = desc.replace(new RegExp(name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'gi'), '');
  if (symbol) desc = desc.replace(new RegExp(symbol.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'gi'), '');

  desc = desc
    .replace(/(?:deploy|launch|create|make|called|named)/gi, '')
    .replace(/[ \t]+/g, ' ')
    .replace(/\n[ \t]+/g, '\n')
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
    .join('\n\n')
    .trim();

  if (desc.length > maxLen) {
    desc = `${desc.substring(0, maxLen - 1)}…`;
  }

  return desc || 'Token deployed via Liquid Social Launcher';
}

/** Same as {@link extractDescription} but returns `''` when there is no extra user text (for merging into deploy). */
export function extractLaunchUserDescription(
  text: string,
  name?: string,
  symbol?: string,
  maxLen = 4000,
): string {
  const raw = extractDescription(text, name, symbol, maxLen);
  if (!raw || raw === 'Token deployed via Liquid Social Launcher') return '';
  return raw;
}

/**
 * Extract token contract or ticker from a fee-claim message (X, Farcaster, Telegram, Discord).
 */
export function parseClaimTokenHint(text: string): {
  tokenAddress?: string;
  tokenSymbol?: string;
} {
  const cleaned = text
    .replace(/@\w+/g, ' ')
    .replace(/^\s*\/claim\b\s*/i, '')
    .replace(/\s+/g, ' ')
    .trim();
  const hex = cleaned.match(/0x[a-fA-F0-9]{40}/);
  if (hex) {
    return { tokenAddress: hex[0] };
  }
  const dollar = cleaned.match(/\$([A-Za-z][A-Za-z0-9]{0,31})\b/);
  if (dollar) {
    return { tokenSymbol: dollar[1] };
  }
  const tail = cleaned.match(/\bclaim(?:\s+fees?)?\s+([A-Za-z][A-Za-z0-9]{0,31})\s*$/i);
  if (tail && !/^(claim|fees?)$/i.test(tail[1])) {
    return { tokenSymbol: tail[1] };
  }
  return {};
}

// Test examples (run: node dist/parser.js)
if (isMainModule()) {
  const tests = [
    '@liquidlauncher deploy MyToken MTK 0x1234567890123456789012345678901234567890',
    'launch $PEPE with 0.5 eth dev buy to 0xABC123... https://example.com/pepe.png',
    'create token called Super Coin with ticker SUPER for 0xDEF456...',
    'deploy "Cool Token" COOL 0xGHI789...',
    'make MyToken MTK 0x123...',
    'deploy deadx deadx no dev',
    'Deploy deadx ticker dx. No dev.',
    '@liquidlauncher deploy deadx ticker dx',
    'deploy deadx ticker deadx no dev',
  ];

  for (const test of tests) {
    console.log('\n---');
    console.log('Input:', test);
    const result = parseLaunchRequest(test);
    console.log('Parsed:', result);
  }
}
