/**
 * Pool swap trades from Robinhood Chain Blockscout (fallback when GeckoTerminal has no pool).
 */
import {
  createPublicClient,
  getAddress,
  http,
  zeroAddress,
  type Address,
} from 'viem';
import { config } from '../config.js';
import { ROBINHOOD_EXPLORER, robinhood } from './robinhoodChain.js';
import { getDeploymentByTokenAddress } from './deploymentCatalog.js';
import { HOODMARKETS_V3_ABI } from './hoodmarketsV3Abi.js';
import { HOODMARKETS_V3_FRACTION_ABI } from './hoodmarketsV3FractionAbi.js';

const BLOCKSCOUT_API = `${ROBINHOOD_EXPLORER}/api/v2`;
const TRADES_CACHE_TTL_MS = 15_000;
const MAX_TRADES = 30;

export type BlockscoutTokenTradeRow = {
  id: string;
  txHash: string;
  wallet: string;
  isBuy: boolean;
  ethAmount: number;
  tokenAmount: number;
  timestamp: string;
  usdVolume?: number;
};

type BlockscoutLog = {
  transaction_hash?: string;
  block_timestamp?: string;
  decoded?: {
    method_call?: string;
    parameters?: Array<{
      name?: string;
      type?: string;
      value?: string;
      indexed?: boolean;
    }>;
  };
};

const tradesByToken = new Map<string, { trades: BlockscoutTokenTradeRow[]; at: number }>();
const poolByToken = new Map<string, { pool: Address; launchToken: Address; token0: Address; at: number }>();

function publicClient() {
  return createPublicClient({
    chain: robinhood,
    transport: http(config.chainRpcUrl),
  });
}

async function blockscoutGet<T>(path: string): Promise<T | null> {
  try {
    const res = await fetch(`${BLOCKSCOUT_API}${path}`, {
      headers: { Accept: 'application/json' },
    });
    if (!res.ok) return null;
    return (await res.json()) as T;
  } catch {
    return null;
  }
}

async function resolvePoolContext(tokenAddress: Address): Promise<{
  pool: Address;
  launchToken: Address;
  token0: Address;
} | null> {
  const key = tokenAddress.toLowerCase();
  const cached = poolByToken.get(key);
  if (cached && Date.now() - cached.at < 5 * 60_000) {
    return cached;
  }

  const deployment = await getDeploymentByTokenAddress(tokenAddress);
  const factory = deployment?.factoryAddress?.trim();
  if (!factory) return null;

  const client = publicClient();
  try {
    const collection = await client.readContract({
      address: getAddress(factory),
      abi: HOODMARKETS_V3_ABI,
      functionName: 'fractionCollectionForToken',
      args: [tokenAddress],
    });
    if (!collection || collection === zeroAddress) return null;

    const [poolRaw, launchToken] = await Promise.all([
      client.readContract({
        address: getAddress(collection),
        abi: HOODMARKETS_V3_FRACTION_ABI,
        functionName: 'pool',
      }),
      client.readContract({
        address: getAddress(collection),
        abi: HOODMARKETS_V3_FRACTION_ABI,
        functionName: 'launchToken',
      }),
    ]);
    if (!poolRaw || poolRaw === zeroAddress) return null;

    const pool = getAddress(poolRaw as Address);
    const launch = getAddress(launchToken as Address);
    const token0 = getAddress(
      (await client.readContract({
        address: pool,
        abi: [
          {
            type: 'function',
            name: 'token0',
            stateMutability: 'view',
            inputs: [],
            outputs: [{ name: '', type: 'address' }],
          },
        ],
        functionName: 'token0',
      })) as Address,
    );

    const ctx = { pool, launchToken: launch, token0 };
    poolByToken.set(key, { ...ctx, at: Date.now() });
    return ctx;
  } catch {
    return null;
  }
}

function parseSwapLog(
  log: BlockscoutLog,
  launchToken: Address,
  token0: Address,
): BlockscoutTokenTradeRow | null {
  const method = log.decoded?.method_call ?? '';
  if (!method.startsWith('Swap(')) return null;
  const txHash = log.transaction_hash?.trim();
  const timestamp = log.block_timestamp?.trim();
  if (!txHash || !timestamp) return null;

  const params = log.decoded?.parameters ?? [];
  const byName = new Map(params.map((p) => [p.name ?? '', p.value ?? '']));
  const sender = byName.get('sender')?.trim();
  const amount0 = BigInt(byName.get('amount0') ?? '0');
  const amount1 = BigInt(byName.get('amount1') ?? '0');
  if (!sender) return null;

  const launchIsToken0 = launchToken.toLowerCase() === token0.toLowerCase();
  const isBuy = launchIsToken0 ? amount0 < 0n : amount1 < 0n;
  const tokenRaw = launchIsToken0
    ? isBuy
      ? -amount0
      : amount0
    : isBuy
      ? -amount1
      : amount1;
  const ethRaw = launchIsToken0 ? (isBuy ? amount1 : -amount1) : isBuy ? amount0 : -amount0;

  const tokenAmount = Number(tokenRaw) / 1e18;
  const ethAmount = Number(ethRaw > 0n ? ethRaw : -ethRaw) / 1e18;
  if (tokenAmount <= 0 && ethAmount <= 0) return null;

  return {
    id: `${txHash}-${sender}`,
    txHash,
    wallet: getAddress(sender),
    isBuy,
    ethAmount: Number.isFinite(ethAmount) ? ethAmount : 0,
    tokenAmount: Number.isFinite(tokenAmount) ? tokenAmount : 0,
    timestamp,
  };
}

export async function fetchBlockscoutTokenTrades(
  tokenAddress: string,
): Promise<BlockscoutTokenTradeRow[]> {
  const key = tokenAddress.trim().toLowerCase();
  const cached = tradesByToken.get(key);
  if (cached && Date.now() - cached.at < TRADES_CACHE_TTL_MS) {
    return cached.trades;
  }

  let token: Address;
  try {
    token = getAddress(tokenAddress.trim());
  } catch {
    return cached?.trades ?? [];
  }

  const ctx = await resolvePoolContext(token);
  if (!ctx) return cached?.trades ?? [];

  const data = await blockscoutGet<{ items?: BlockscoutLog[] }>(
    `/addresses/${ctx.pool}/logs`,
  );
  const trades = (data?.items ?? [])
    .map((log) => parseSwapLog(log, ctx.launchToken, ctx.token0))
    .filter((row): row is BlockscoutTokenTradeRow => row != null)
    .sort((a, b) => Date.parse(b.timestamp) - Date.parse(a.timestamp))
    .slice(0, MAX_TRADES);

  if (trades.length > 0) {
    tradesByToken.set(key, { trades, at: Date.now() });
  }
  return trades.length > 0 ? trades : cached?.trades ?? [];
}
