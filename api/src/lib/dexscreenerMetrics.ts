/** DexScreener pair metrics for Robinhood Chain (4663) — server-side explore poller. */

const CHAIN_ID = '4663';
const CHUNK = 30;

export type DexPairMetrics = {
  volume24hUsd: number;
  mcapUsd: number;
  liquidityUsd: number;
  change24hPct: number | null;
  txnsH24: number;
  priceUsd: number | null;
  dexscreenerUrl: string | null;
};

interface DexPair {
  chainId?: string;
  url?: string;
  baseToken?: { address?: string };
  quoteToken?: { address?: string };
  volume?: { h24?: number };
  priceChange?: { h24?: number };
  fdv?: number;
  marketCap?: number;
  liquidity?: { usd?: number };
  txns?: { h24?: { buys?: number; sells?: number } };
  priceUsd?: string;
}

function chunk<T>(arr: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
  return out;
}

function isRobinhoodPair(p: DexPair): boolean {
  const id = String(p.chainId ?? '').toLowerCase();
  return !id || id === CHAIN_ID || id === 'robinhood';
}

function liquidityUsd(p: DexPair): number {
  const u = p.liquidity?.usd;
  return typeof u === 'number' && Number.isFinite(u) ? u : 0;
}

function pickBestPairForToken(pairs: DexPair[], tokenKey: string): DexPair | null {
  const relevant = pairs.filter((p) => {
    if (!isRobinhoodPair(p)) return false;
    const b = p.baseToken?.address?.toLowerCase();
    const q = p.quoteToken?.address?.toLowerCase();
    return b === tokenKey || q === tokenKey;
  });
  if (relevant.length === 0) return null;
  relevant.sort((a, b) => {
    const lb = liquidityUsd(b) - liquidityUsd(a);
    if (lb !== 0) return lb;
    const fd = (b.fdv ?? 0) - (a.fdv ?? 0);
    if (fd !== 0) return fd;
    return (b.volume?.h24 ?? 0) - (a.volume?.h24 ?? 0);
  });
  return relevant[0] ?? null;
}

function pairToMetrics(best: DexPair): DexPairMetrics {
  const buys = best.txns?.h24?.buys ?? 0;
  const sells = best.txns?.h24?.sells ?? 0;
  const change = best.priceChange?.h24;
  const priceRaw = best.priceUsd;
  let priceUsd: number | null = null;
  if (priceRaw != null) {
    const p = Number(priceRaw);
    if (Number.isFinite(p) && p > 0) priceUsd = p;
  }
  return {
    volume24hUsd: typeof best.volume?.h24 === 'number' && best.volume.h24 > 0 ? best.volume.h24 : 0,
    mcapUsd:
      (typeof best.marketCap === 'number' && best.marketCap > 0
        ? best.marketCap
        : typeof best.fdv === 'number' && best.fdv > 0
          ? best.fdv
          : 0) ?? 0,
    liquidityUsd: liquidityUsd(best),
    change24hPct: typeof change === 'number' && Number.isFinite(change) ? change : null,
    txnsH24: buys + sells,
    priceUsd,
    dexscreenerUrl: typeof best.url === 'string' && best.url.length > 0 ? best.url : null,
  };
}

export async function fetchDexMetricsForTokens(
  addresses: string[],
): Promise<Map<string, DexPairMetrics>> {
  const uniq = [...new Set(addresses.map((a) => a.trim().toLowerCase()).filter(Boolean))];
  const out = new Map<string, DexPairMetrics>();

  const applyPairs = (pairs: DexPair[]) => {
    for (const addr of uniq) {
      if (out.has(addr)) continue;
      const best = pickBestPairForToken(pairs, addr);
      if (!best) continue;
      out.set(addr, pairToMetrics(best));
    }
  };

  for (const group of chunk(uniq, CHUNK)) {
    let pairs: DexPair[] = [];
    try {
      const res = await fetch(
        `https://api.dexscreener.com/tokens/v1/${CHAIN_ID}/${group.join(',')}`,
      );
      if (res.ok) {
        const data = (await res.json()) as DexPair[] | { pairs?: DexPair[] };
        pairs = Array.isArray(data) ? data : (data.pairs ?? []);
      }
    } catch {
      pairs = [];
    }
    applyPairs(pairs);
  }

  const missing = uniq.filter((a) => !out.has(a));
  for (const addr of missing) {
    try {
      const res = await fetch(`https://api.dexscreener.com/latest/dex/tokens/${addr}`);
      if (!res.ok) continue;
      const data = (await res.json()) as { pairs?: DexPair[] };
      applyPairs(data.pairs ?? []);
    } catch {
      continue;
    }
  }

  return out;
}
