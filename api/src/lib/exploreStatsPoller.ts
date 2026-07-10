import { logger } from '../logger.js';
import { fetchDexMetricsForTokens } from './dexscreenerMetrics.js';
import {
  listVisibleCatalogTokenAddresses,
  upsertTokenMarketStats,
} from './tokenMarketStats.js';

const POLL_MS = 3 * 60 * 1000;
const TRADES_API =
  process.env.ROBINHOOD_TRADES_API_URL?.trim() ||
  'https://awk00kk00gskkw0o8kc488kg.notoriouslywrong.com/v1/robinhood/trades/latest';

type RobinhoodSwap = {
  token?: string;
  timestamp?: string;
};

async function fetchLatestTradeByToken(): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  try {
    const res = await fetch(`${TRADES_API.replace(/\/$/, '')}?limit=200`);
    if (!res.ok) return out;
    const data = (await res.json()) as { swaps?: RobinhoodSwap[] };
    for (const swap of data.swaps ?? []) {
      const token = swap.token?.trim().toLowerCase();
      const ts = swap.timestamp?.trim();
      if (!token || !ts) continue;
      const prev = out.get(token);
      if (!prev || Date.parse(ts) > Date.parse(prev)) {
        out.set(token, ts);
      }
    }
  } catch (e) {
    logger.warn('exploreStatsPoller: trades feed failed:', e instanceof Error ? e.message : e);
  }
  return out;
}

export async function refreshExploreMarketStats(): Promise<{ updated: number }> {
  const addresses = await listVisibleCatalogTokenAddresses();
  if (addresses.length === 0) return { updated: 0 };

  const [dexByToken, lastTradeByToken] = await Promise.all([
    fetchDexMetricsForTokens(addresses),
    fetchLatestTradeByToken(),
  ]);

  let updated = 0;
  for (const raw of addresses) {
    const key = raw.trim().toLowerCase();
    const dex = dexByToken.get(key);
    const lastTradeAt = lastTradeByToken.get(key) ?? null;
    await upsertTokenMarketStats(raw, {
      volume24hUsd: dex?.volume24hUsd ?? 0,
      mcapUsd: dex?.mcapUsd ?? 0,
      liquidityUsd: dex?.liquidityUsd ?? 0,
      change24hPct: dex?.change24hPct ?? null,
      txnsH24: dex?.txnsH24 ?? 0,
      priceUsd: dex?.priceUsd ?? null,
      dexscreenerUrl: dex?.dexscreenerUrl ?? null,
      lastTradeAt,
    });
    updated += 1;
  }

  return { updated };
}

export function startExploreStatsPoller(): void {
  const tick = async () => {
    try {
      const { updated } = await refreshExploreMarketStats();
      if (updated > 0) {
        logger.info(`Explore stats poller: refreshed ${updated} token(s)`);
      }
    } catch (e) {
      logger.warn('Explore stats poller:', e instanceof Error ? e.message : e);
    }
  };

  setTimeout(() => void tick(), 12_000);
  setInterval(() => void tick(), POLL_MS);
  logger.info('Explore stats poller started (DexScreener + trades feed, every 3m)');
}
