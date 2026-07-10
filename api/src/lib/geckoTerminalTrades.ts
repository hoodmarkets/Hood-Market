/**
 * GeckoTerminal trades for Robinhood Chain — server-side with cache (avoids browser rate limits).
 */

const GECKO_API = 'https://api.geckoterminal.com/api/v2';
const GECKO_NETWORK = 'robinhood';
const POOL_CACHE_TTL_MS = 5 * 60_000;
const TRADES_CACHE_TTL_MS = 15_000;
const MAX_TRADES = 30;

export type GeckoTokenTradeRow = {
  id: string;
  txHash: string;
  wallet: string;
  isBuy: boolean;
  ethAmount: number;
  tokenAmount: number;
  timestamp: string;
  usdVolume?: number;
};

type GeckoPool = {
  attributes?: {
    address?: string;
    reserve_in_usd?: string;
  };
};

type GeckoTrade = {
  id: string;
  attributes?: {
    kind?: string;
    tx_hash?: string;
    tx_from_address?: string;
    block_timestamp?: string;
    from_token_amount?: string;
    to_token_amount?: string;
    volume_in_usd?: string;
  };
};

const poolByToken = new Map<string, { pool: string; at: number }>();
const tradesByToken = new Map<string, { trades: GeckoTokenTradeRow[]; at: number }>();

async function geckoGet<T>(path: string): Promise<T | null> {
  try {
    const res = await fetch(`${GECKO_API}${path}`, {
      headers: { Accept: 'application/json' },
    });
    if (res.status === 429 || res.status === 404) return null;
    if (!res.ok) return null;
    return (await res.json()) as T;
  } catch {
    return null;
  }
}

async function resolveTopPoolAddress(tokenAddress: string): Promise<string | null> {
  const key = tokenAddress.trim().toLowerCase();
  const cached = poolByToken.get(key);
  if (cached && Date.now() - cached.at < POOL_CACHE_TTL_MS) {
    return cached.pool;
  }

  const data = await geckoGet<{ data?: GeckoPool[] }>(
    `/networks/${GECKO_NETWORK}/tokens/${key}/pools`,
  );
  const pools = [...(data?.data ?? [])].sort((a, b) => {
    const av = Number(a.attributes?.reserve_in_usd ?? 0);
    const bv = Number(b.attributes?.reserve_in_usd ?? 0);
    return bv - av;
  });
  const pool = pools[0]?.attributes?.address?.trim().toLowerCase();
  if (!pool) return null;
  poolByToken.set(key, { pool, at: Date.now() });
  return pool;
}

function mapGeckoTrade(raw: GeckoTrade): GeckoTokenTradeRow | null {
  const a = raw.attributes;
  if (!a?.tx_hash || !a.tx_from_address || !a.block_timestamp) return null;

  const kind = String(a.kind ?? '').toLowerCase();
  const isBuy = kind === 'buy';
  const fromAmt = Number.parseFloat(a.from_token_amount ?? '');
  const toAmt = Number.parseFloat(a.to_token_amount ?? '');
  const usd = Number.parseFloat(a.volume_in_usd ?? '');

  const ethAmount = isBuy
    ? Number.isFinite(fromAmt)
      ? fromAmt
      : 0
    : Number.isFinite(toAmt)
      ? toAmt
      : 0;
  const tokenAmount = isBuy
    ? Number.isFinite(toAmt)
      ? toAmt
      : 0
    : Number.isFinite(fromAmt)
      ? fromAmt
      : 0;

  if (ethAmount <= 0 && tokenAmount <= 0) return null;

  return {
    id: raw.id || a.tx_hash,
    txHash: a.tx_hash,
    wallet: a.tx_from_address,
    isBuy,
    ethAmount,
    tokenAmount,
    timestamp: a.block_timestamp,
    usdVolume: Number.isFinite(usd) && usd > 0 ? usd : undefined,
  };
}

export async function fetchGeckoTokenTrades(tokenAddress: string): Promise<GeckoTokenTradeRow[]> {
  const key = tokenAddress.trim().toLowerCase();
  const cached = tradesByToken.get(key);
  if (cached && Date.now() - cached.at < TRADES_CACHE_TTL_MS) {
    return cached.trades;
  }

  const pool = await resolveTopPoolAddress(key);
  if (!pool) return cached?.trades ?? [];

  const data = await geckoGet<{ data?: GeckoTrade[] }>(
    `/networks/${GECKO_NETWORK}/pools/${pool}/trades`,
  );
  const trades = (data?.data ?? [])
    .map(mapGeckoTrade)
    .filter((t): t is GeckoTokenTradeRow => t != null)
    .slice(0, MAX_TRADES);

  // Avoid caching empty responses from transient Gecko failures (429, timeouts).
  if (trades.length > 0) {
    tradesByToken.set(key, { trades, at: Date.now() });
  }
  return trades.length > 0 ? trades : cached?.trades ?? [];
}
