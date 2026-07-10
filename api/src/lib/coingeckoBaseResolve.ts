import { getAddress, isAddress, type Address } from 'viem';
import { config } from '../config.js';
import { logger } from '../logger.js';

interface CoinSearchItem {
  id: string;
  name: string;
  symbol: string;
}

interface SearchResponse {
  coins?: CoinSearchItem[];
}

interface CoinDetailResponse {
  id?: string;
  name?: string;
  symbol?: string;
  platforms?: Record<string, string | null | undefined>;
}

function coingeckoHeaders(): HeadersInit {
  const h: Record<string, string> = { Accept: 'application/json' };
  if (config.coingecko.apiKey) {
    h['x-cg-demo-api-key'] = config.coingecko.apiKey;
  }
  return h;
}

/**
 * Resolve a name/symbol search string to a Base mainnet token contract via CoinGecko.
 * Uses the public search API + coin detail `platforms.base`.
 */
export async function resolveTokenOnBase(
  query: string,
): Promise<
  | { ok: true; address: Address; name: string; symbol: string; coingeckoId: string }
  | { ok: false; error: string }
> {
  const q = query.trim();
  if (!q) {
    return { ok: false, error: 'Empty query.' };
  }

  try {
    const searchUrl = `https://api.coingecko.com/api/v3/search?query=${encodeURIComponent(q)}`;
    const searchRes = await fetch(searchUrl, { headers: coingeckoHeaders() });
    if (!searchRes.ok) {
      return { ok: false, error: `CoinGecko search failed (HTTP ${searchRes.status}).` };
    }
    const searchJson = (await searchRes.json()) as SearchResponse;
    const coins = searchJson.coins?.slice(0, 8) ?? [];
    if (!coins.length) {
      return { ok: false, error: `No CoinGecko matches for "${q}". Try another symbol or paste a 0x address.` };
    }

    for (const c of coins) {
      const detailUrl = `https://api.coingecko.com/api/v3/coins/${encodeURIComponent(c.id)}?localization=false&tickers=false&market_data=false&community_data=false&developer_data=false&sparkline=false`;
      const detailRes = await fetch(detailUrl, { headers: coingeckoHeaders() });
      if (!detailRes.ok) continue;
      const detail = (await detailRes.json()) as CoinDetailResponse;
      const raw = detail.platforms?.base;
      if (typeof raw !== 'string' || !raw.startsWith('0x')) continue;
      try {
        if (!isAddress(raw)) continue;
        const address = getAddress(raw);
        return {
          ok: true,
          address,
          name: detail.name ?? c.name,
          symbol: (detail.symbol ?? c.symbol).toUpperCase(),
          coingeckoId: detail.id ?? c.id,
        };
      } catch {
        continue;
      }
    }

    return {
      ok: false,
      error:
        'No Base (CoinGecko `platforms.base`) contract found for that search. Paste a Base token 0x address instead.',
    };
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : String(e);
    logger.warn('CoinGecko resolve failed', { msg });
    return { ok: false, error: msg };
  }
}
