import { config } from '../config.js';
import { logger } from '../logger.js';

function coingeckoHeaders(): HeadersInit {
  const h: Record<string, string> = { Accept: 'application/json' };
  if (config.coingecko.apiKey) {
    h['x-cg-demo-api-key'] = config.coingecko.apiKey;
  }
  return h;
}

export interface TokenMarketData {
  name: string;
  symbol: string;
  coingeckoId: string;
  address: string;
  priceUsd: number | null;
  marketCapUsd: number | null;
  fullyDilutedValueUsd: number | null;
  volume24hUsd: number | null;
  priceChange24hPct: number | null;
  priceChange7dPct: number | null;
  totalLiquidityUsd: number | null;
  circulatingSupply: number | null;
  totalSupply: number | null;
  ath: number | null;
  athChangePct: number | null;
}

interface CoinDetailResponse {
  id?: string;
  name?: string;
  symbol?: string;
  platforms?: Record<string, string | null | undefined>;
  market_data?: {
    current_price?: { usd?: number };
    market_cap?: { usd?: number };
    fully_diluted_valuation?: { usd?: number };
    total_volume?: { usd?: number };
    price_change_percentage_24h?: number;
    price_change_percentage_7d?: number;
    total_liquidity?: number;
    circulating_supply?: number;
    total_supply?: number;
    ath?: { usd?: number };
    ath_change_percentage?: { usd?: number };
  };
}

/**
 * Fetch market data for a Base token by contract address using CoinGecko.
 * Uses the `/coins/base/contract/{address}` endpoint.
 */
export async function getTokenMarketData(
  contractAddress: string,
): Promise<{ ok: true; data: TokenMarketData } | { ok: false; error: string }> {
  const addr = contractAddress.toLowerCase();

  try {
    const url = `https://api.coingecko.com/api/v3/coins/base/contract/${encodeURIComponent(addr)}?localization=false&tickers=false&market_data=true&community_data=false&developer_data=false&sparkline=false`;
    const res = await fetch(url, { headers: coingeckoHeaders() });

    if (res.status === 404) {
      return {
        ok: false,
        error: `Token not found on CoinGecko for Base address ${contractAddress}. It may be too new or not listed.`,
      };
    }
    if (!res.ok) {
      return { ok: false, error: `CoinGecko market data failed (HTTP ${res.status}).` };
    }

    const d = (await res.json()) as CoinDetailResponse;
    const md = d.market_data ?? {};

    const data: TokenMarketData = {
      name: d.name ?? 'Unknown',
      symbol: (d.symbol ?? '???').toUpperCase(),
      coingeckoId: d.id ?? '',
      address: contractAddress,
      priceUsd: md.current_price?.usd ?? null,
      marketCapUsd: md.market_cap?.usd ?? null,
      fullyDilutedValueUsd: md.fully_diluted_valuation?.usd ?? null,
      volume24hUsd: md.total_volume?.usd ?? null,
      priceChange24hPct: md.price_change_percentage_24h ?? null,
      priceChange7dPct: md.price_change_percentage_7d ?? null,
      totalLiquidityUsd: md.total_liquidity ?? null,
      circulatingSupply: md.circulating_supply ?? null,
      totalSupply: md.total_supply ?? null,
      ath: md.ath?.usd ?? null,
      athChangePct: md.ath_change_percentage?.usd ?? null,
    };

    return { ok: true, data };
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : String(e);
    logger.warn('CoinGecko market data fetch failed', { msg, contractAddress });
    return { ok: false, error: msg };
  }
}

/** Format market data as a concise human-readable string. */
export function formatMarketData(d: TokenMarketData): string {
  const fmt = (n: number | null, prefix = '$', decimals = 2) =>
    n == null ? 'N/A' : `${prefix}${n.toLocaleString('en-US', { maximumFractionDigits: decimals })}`;

  const fmtLarge = (n: number | null) => {
    if (n == null) return 'N/A';
    if (n >= 1e9) return `$${(n / 1e9).toFixed(2)}B`;
    if (n >= 1e6) return `$${(n / 1e6).toFixed(2)}M`;
    if (n >= 1e3) return `$${(n / 1e3).toFixed(2)}K`;
    return `$${n.toFixed(2)}`;
  };

  const fmtPct = (n: number | null) =>
    n == null ? 'N/A' : `${n >= 0 ? '+' : ''}${n.toFixed(2)}%`;

  const lines = [
    `${d.name} (${d.symbol}) — Base: ${d.address}`,
    `Price: ${fmt(d.priceUsd, '$', 6)}  24h: ${fmtPct(d.priceChange24hPct)}  7d: ${fmtPct(d.priceChange7dPct)}`,
    `Market cap: ${fmtLarge(d.marketCapUsd)}  FDV: ${fmtLarge(d.fullyDilutedValueUsd)}`,
    `Volume 24h: ${fmtLarge(d.volume24hUsd)}${d.totalLiquidityUsd != null ? `  Liquidity: ${fmtLarge(d.totalLiquidityUsd)}` : ''}`,
    `Supply: ${d.circulatingSupply != null ? d.circulatingSupply.toLocaleString('en-US', { maximumFractionDigits: 0 }) : 'N/A'} circulating${d.totalSupply != null ? ` / ${d.totalSupply.toLocaleString('en-US', { maximumFractionDigits: 0 })} total` : ''}`,
    d.ath != null ? `ATH: ${fmt(d.ath, '$', 6)} (${fmtPct(d.athChangePct)} from ATH)` : null,
  ].filter(Boolean);

  return lines.join('\n');
}
