import { DynamicStructuredTool } from '@langchain/core/tools';
import type { ZodTypeAny } from 'zod';
import { z } from 'zod';
import { createPublicClient, erc20Abi, formatEther, formatUnits, getAddress, http, isAddress } from 'viem';
import { base } from 'viem/chains';
import type { IdentityClaim } from './privy.js';
import { resolveWalletForIdentity } from './privy.js';
import { resolveTokenOnBase } from './coingeckoBaseResolve.js';
import { getTokenMarketData, formatMarketData } from './coingeckoMarketData.js';
import {
  executeBotSwap,
  getDelegatedSwapReadiness,
  previewDelegatedSwapQuote,
  type QuoteProvider,
} from './delegatedSwapExecution.js';
import type { ParsedTradeIntent } from './tradeIntent.js';
import { config } from '../config.js';
import { logger } from '../logger.js';
import { formatV4PoolReadForAgent, readV4PoolState } from './uniswapV4PoolState.js';

const ethAddressString = z
  .string()
  .regex(/^0x[a-fA-F0-9]{40}$/i, 'Must be a 40-character hex 0x address') as ZodTypeAny;

const sideSchema = z.enum(['buy', 'sell']) as ZodTypeAny;
const quoteProviderSchema = z.enum(['0x', 'odos']).optional() as ZodTypeAny;

function parseQuoteProvider(v: unknown): QuoteProvider | undefined {
  if (v === '0x' || v === 'odos') return v;
  return undefined;
}

function parseChecksummedAddress(raw: string): `0x${string}` | null {
  try {
    if (!isAddress(raw)) return null;
    return getAddress(raw as `0x${string}`);
  } catch {
    return null;
  }
}

function getPublicClient() {
  return createPublicClient({
    chain: base,
    transport: http(config.baseRpcUrl),
  });
}

/**
 * All agent tools. `identity` is fixed server-side — never taken from model output.
 */
export function createLiquidLauncherAgentTools(identity: IdentityClaim): DynamicStructuredTool[] {

  // ─── Token resolution ────────────────────────────────────────────────────
  const resolveToken = new DynamicStructuredTool({
    name: 'resolve_token_on_base',
    description:
      'Look up a token by name or ticker on Base using CoinGecko (e.g. "PEPE", "USDC", "Brett"). Returns a checksummed 0x contract address. Always call this first when the user gives a symbol instead of an address.',
    schema: z.object({
      query: z.string().describe('Token name, ticker, or search string'),
    }) as ZodTypeAny,
    func: async ({ query }: { query: string }) => {
      const r = await resolveTokenOnBase(query);
      if (!r.ok) return r.error;
      return JSON.stringify({ address: r.address, name: r.name, symbol: r.symbol, coingeckoId: r.coingeckoId }, null, 2);
    },
  } as never);

  // ─── Token market data ───────────────────────────────────────────────────
  const tokenMarketData = new DynamicStructuredTool({
    name: 'get_token_market_data',
    description:
      'Fetch live price, market cap, FDV, 24h volume, 24h/7d price change, liquidity, supply, and ATH for a Base token by its contract address. Call resolve_token_on_base first if you only have a symbol.',
    schema: z.object({
      tokenAddress: ethAddressString.describe('Base token contract address (0x...)'),
    }) as ZodTypeAny,
    func: async ({ tokenAddress }: { tokenAddress: string }) => {
      const addr = parseChecksummedAddress(tokenAddress);
      if (!addr) return 'Invalid tokenAddress.';
      const r = await getTokenMarketData(addr);
      if (!r.ok) return r.error;
      return formatMarketData(r.data);
    },
  } as never);

  // ─── Uniswap v4 on-chain pool (Base PoolManager, no indexer) ─────────────
  const v4PoolLiquidity = new DynamicStructuredTool({
    name: 'read_v4_pool_liquidity',
    description:
      'Read Uniswap v4 pool state on Base from the canonical PoolManager via RPC: sqrtPriceX96, tick, fee fields, active liquidity, and rough price-impact bands (1–5% of virtual token0 depth, CP approximation). Requires the bytes32 poolId (0x + 64 hex) from a Liquid deployment or Initialize logs — v4 has no per-pool contract address.',
    schema: z.object({
      poolId: z
        .string()
        .regex(/^0x[a-fA-F0-9]{64}$/i, '32-byte pool id: 0x + 64 hex characters'),
    }) as ZodTypeAny,
    func: async ({ poolId }: { poolId: string }) => {
      const r = await readV4PoolState(poolId);
      if ('error' in r) return r.error;
      return formatV4PoolReadForAgent(r);
    },
  } as never);

  // ─── Wallet ETH balance ──────────────────────────────────────────────────
  const walletEthBalance = new DynamicStructuredTool({
    name: 'get_wallet_eth_balance',
    description:
      "Get the current user's ETH balance on Base mainnet. No parameters needed — uses the user's Privy embedded wallet.",
    schema: z.object({
      _noop: z.string().optional().describe('Unused'),
    }) as ZodTypeAny,
    func: async () => {
      try {
        const resolved = await resolveWalletForIdentity(identity);
        const client = getPublicClient();
        const wei = await client.getBalance({ address: resolved.address as `0x${string}` });
        const eth = formatEther(wei);
        return `Wallet: ${resolved.address}\nETH balance on Base: ${eth} ETH`;
      } catch (e: unknown) {
        const msg = e instanceof Error ? e.message : String(e);
        logger.warn('get_wallet_eth_balance failed', { msg });
        return `Could not fetch ETH balance: ${msg}`;
      }
    },
  } as never);

  // ─── Combined wallet + swap limits (one call) ───────────────────────────
  const tradingContext = new DynamicStructuredTool({
    name: 'get_trading_context',
    description:
      'Load the user Base wallet address, ETH balance, and delegated-swap readiness in one step (max buy ETH, sell sizing, quote providers, whether server signing is allowed). Prefer this when the user asks what they can trade, how much they could swap, or whether in-app/server swaps are available.',
    schema: z.object({
      _noop: z.string().optional().describe('Unused'),
    }) as ZodTypeAny,
    func: async () => {
      try {
        const resolved = await resolveWalletForIdentity(identity);
        const client = getPublicClient();
        const [wei, readiness] = await Promise.all([
          client.getBalance({ address: resolved.address as `0x${string}` }),
          getDelegatedSwapReadiness(identity),
        ]);
        return JSON.stringify(
          {
            walletAddress: resolved.address,
            ethBalance: formatEther(wei),
            ethBalanceWei: wei.toString(),
            delegatedSwapReadiness: readiness,
          },
          null,
          2,
        );
      } catch (e: unknown) {
        const msg = e instanceof Error ? e.message : String(e);
        logger.warn('get_trading_context failed', { msg });
        return `Could not load trading context: ${msg}`;
      }
    },
  } as never);

  // ─── Token balance for user's wallet ────────────────────────────────────
  const tokenBalance = new DynamicStructuredTool({
    name: 'get_token_balance',
    description:
      "Get the current user's balance of a specific ERC-20 token on Base. Call resolve_token_on_base first if you only have a symbol.",
    schema: z.object({
      tokenAddress: ethAddressString.describe('Base ERC-20 contract address'),
    }) as ZodTypeAny,
    func: async ({ tokenAddress }: { tokenAddress: string }) => {
      const addr = parseChecksummedAddress(tokenAddress);
      if (!addr) return 'Invalid tokenAddress.';
      try {
        const resolved = await resolveWalletForIdentity(identity);
        const walletAddr = resolved.address as `0x${string}`;
        const client = getPublicClient();
        const [balance, decimals, symbol] = await Promise.all([
          client.readContract({ address: addr, abi: erc20Abi, functionName: 'balanceOf', args: [walletAddr] }) as Promise<bigint>,
          client.readContract({ address: addr, abi: erc20Abi, functionName: 'decimals' }) as Promise<number>,
          client.readContract({ address: addr, abi: erc20Abi, functionName: 'symbol' }) as Promise<string>,
        ]);
        const formatted = formatUnits(balance, decimals);
        return `Wallet: ${walletAddr}\n${symbol} balance on Base: ${formatted} ${symbol}\nToken contract: ${addr}`;
      } catch (e: unknown) {
        const msg = e instanceof Error ? e.message : String(e);
        logger.warn('get_token_balance failed', { msg, tokenAddress });
        return `Could not fetch token balance: ${msg}`;
      }
    },
  } as never);

  // ─── Web search (Tavily) ─────────────────────────────────────────────────
  const webSearch = new DynamicStructuredTool({
    name: 'web_search',
    description:
      'Search the web for current news, alpha, social sentiment, project updates, or any real-time information. Use specific, targeted queries. Include time context like "2024" or "last 24h" when recency matters.',
    schema: z.object({
      query: z.string().describe('Search query — be specific, include token name/ticker and context'),
      maxResults: z.number().int().min(1).max(8).optional().describe('Number of results (default 5)'),
    }) as ZodTypeAny,
    func: async ({ query, maxResults }: { query: string; maxResults?: number }) => {
      const apiKey = config.tavily.apiKey;
      if (!apiKey) {
        return 'Web search is not configured. Add TAVILY_API_KEY to Railway env vars to enable this tool.';
      }
      try {
        const res = await fetch('https://api.tavily.com/search', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            api_key: apiKey,
            query,
            max_results: maxResults ?? 5,
            search_depth: 'basic',
            include_answer: true,
          }),
        });
        if (!res.ok) {
          return `Tavily search failed (HTTP ${res.status}).`;
        }
        const data = (await res.json()) as {
          answer?: string;
          results?: Array<{ title: string; url: string; content: string; score?: number }>;
        };
        const parts: string[] = [];
        if (data.answer) {
          parts.push(`Summary: ${data.answer}`);
        }
        if (data.results?.length) {
          parts.push('Sources:');
          for (const r of data.results.slice(0, maxResults ?? 5)) {
            parts.push(`• [${r.title}](${r.url})\n  ${r.content.slice(0, 200)}`);
          }
        }
        return parts.join('\n\n') || 'No results found.';
      } catch (e: unknown) {
        const msg = e instanceof Error ? e.message : String(e);
        logger.warn('Tavily web search failed', { msg });
        return `Web search error: ${msg}`;
      }
    },
  } as never);

  // ─── Swap readiness ──────────────────────────────────────────────────────
  const readiness = new DynamicStructuredTool({
    name: 'check_swap_readiness',
    description:
      "Check whether this server has Privy + quote providers configured and whether the current user has delegated their embedded wallet for server-side swaps. Also returns the configured buy/sell amounts. Call this before preview/execute if you're unsure.",
    schema: z.object({
      _noop: z.string().optional().describe('Unused; send {} or omit'),
    }) as ZodTypeAny,
    func: async () => {
      const r = await getDelegatedSwapReadiness(identity);
      return JSON.stringify(r, null, 2);
    },
  } as never);

  // ─── Swap preview ────────────────────────────────────────────────────────
  const preview = new DynamicStructuredTool({
    name: 'preview_delegated_swap',
    description:
      'Simulate a delegated swap (0x or Odos quote + eth_call). Does NOT send a transaction. Shows expected output amount, price impact, and route. Always call this before execute to verify the trade.',
    schema: z.object({
      tokenAddress: ethAddressString,
      side: sideSchema,
      quoteProvider: quoteProviderSchema,
    }) as ZodTypeAny,
    func: async ({
      tokenAddress,
      side,
      quoteProvider,
    }: {
      tokenAddress: string;
      side: 'buy' | 'sell';
      quoteProvider?: '0x' | 'odos';
    }) => {
      const addr = parseChecksummedAddress(tokenAddress);
      if (!addr) return 'Invalid tokenAddress: must be a valid Base 0x contract.';
      const intent: ParsedTradeIntent = { side, address: addr };
      const r = await previewDelegatedSwapQuote(identity, intent, {
        quoteProvider: parseQuoteProvider(quoteProvider),
      });
      if (!r.ok) return r.hint ? `${r.error}\nHint: ${r.hint}` : r.error;
      return r.summary;
    },
  } as never);

  // ─── Swap execute ────────────────────────────────────────────────────────
  const execute = new DynamicStructuredTool({
    name: 'execute_delegated_swap',
    description:
      'Broadcast a delegated swap on Base via Privy (user must have granted server access via the Liquid Launcher web app). Only call after the user has clearly confirmed they want to execute and the preview looks acceptable.',
    schema: z.object({
      tokenAddress: ethAddressString,
      side: sideSchema,
      quoteProvider: quoteProviderSchema,
    }) as ZodTypeAny,
    func: async ({
      tokenAddress,
      side,
      quoteProvider,
    }: {
      tokenAddress: string;
      side: 'buy' | 'sell';
      quoteProvider?: '0x' | 'odos';
    }) => {
      const addr = parseChecksummedAddress(tokenAddress);
      if (!addr) return 'Invalid tokenAddress: must be a valid Base 0x contract.';
      const intent: ParsedTradeIntent = { side, address: addr };
      const r = await executeBotSwap(identity, intent, {
        quoteProvider: parseQuoteProvider(quoteProvider),
      });
      if (!r.ok) return r.hint ? `${r.error}\nHint: ${r.hint}` : r.error;
      return `Swap executed. tx=${r.transactionHash} basescan=https://basescan.org/tx/${r.transactionHash} provider=${r.quoteProvider}`;
    },
  } as never);

  return [
    resolveToken,
    tokenMarketData,
    v4PoolLiquidity,
    walletEthBalance,
    tradingContext,
    tokenBalance,
    webSearch,
    readiness,
    preview,
    execute,
  ] as DynamicStructuredTool[];
}
