import {
  createPublicClient,
  encodeFunctionData,
  erc20Abi,
  getAddress,
  http,
  parseEther,
  parseUnits,
  type Address,
  type Hex,
} from 'viem';
import { config } from '../config.js';
import { getDeploymentByTokenAddress } from './deploymentCatalog.js';
import { buildHoodmarketsPoolKey } from './hoodmarketsPoolKey.js';
import { ROBINHOOD_CHAIN_ID, ROBINHOOD_RPC_DEFAULT, ROBINHOOD_WETH } from './robinhoodChain.js';

export const ROBINHOOD_CHAIN_ID_AGENT = ROBINHOOD_CHAIN_ID;

const swapHelperAbi = [
  {
    type: 'function',
    name: 'buy',
    stateMutability: 'payable',
    inputs: [
      { name: 'token', type: 'address' },
      { name: 'amountOutMinimum', type: 'uint128' },
    ],
    outputs: [],
  },
  {
    type: 'function',
    name: 'sell',
    stateMutability: 'nonpayable',
    inputs: [
      { name: 'token', type: 'address' },
      { name: 'amountIn', type: 'uint256' },
      { name: 'amountOutMinimum', type: 'uint128' },
    ],
    outputs: [],
  },
] as const;

export type AgentPreparedTx = {
  step: string;
  to: Address;
  data: Hex;
  value: Hex;
  chainId: number;
  description: string;
};

export type PrepareSwapResult =
  | {
      ok: true;
      chainId: number;
      tokenAddress: Address;
      tokenSymbol: string;
      swapMode: 'hoodmarkets-helper';
      transactions: AgentPreparedTx[];
      tokenPageUrl: string;
      uniswapSwapUrl: string;
    }
  | {
      ok: false;
      error: string;
      hint?: string;
      uniswapSwapUrl?: string;
    };

function publicClient() {
  return createPublicClient({
    transport: http(config.chainRpcUrl || ROBINHOOD_RPC_DEFAULT),
  });
}

function swapHelperAddress(): Address | null {
  const raw = config.liquid.swapHelper?.trim();
  if (!raw) return null;
  try {
    return getAddress(raw);
  } catch {
    return null;
  }
}

function isV3PoolId(poolId: string | undefined): boolean {
  return !!poolId && poolId.toLowerCase().startsWith('v3:');
}

function uniswapSwapUrl(token: Address): string {
  return `https://app.uniswap.org/swap?chain=robinhood&outputCurrency=${token}`;
}

function tokenPageUrl(token: Address): string {
  const base = (process.env.LAUNCHER_WEB_URL || 'https://hood.markets').replace(/\/$/, '');
  return `${base}/?token=${token}`;
}

/** Parse human ETH (`0.01`, `0.01 ETH`) or token amount (`1000`, `1.5M` tokens). */
export function parseHumanAmount(raw: string, decimals: number): bigint {
  const s = raw.trim().replace(/\s*eth\s*$/i, '').replace(/,/g, '');
  if (!s) throw new Error('amount is required');
  const m = /^(\d+(?:\.\d+)?)\s*([kKmMbB])?$/i.exec(s);
  if (m) {
    const n = Number(m[1]);
    if (!Number.isFinite(n) || n <= 0) throw new Error('amount must be positive');
    const suffix = (m[2] || '').toUpperCase();
    const mult = suffix === 'K' ? 1_000 : suffix === 'M' ? 1_000_000 : suffix === 'B' ? 1_000_000_000 : 1;
    const human = n * mult;
    return parseUnits(String(human), decimals);
  }
  return parseUnits(s, decimals);
}

async function loadSwapContext(tokenAddress: Address): Promise<
  | { ok: true; token: Address; symbol: string; poolId: string }
  | { ok: false; error: string }
> {
  const deployment = await getDeploymentByTokenAddress(tokenAddress);
  if (!deployment) {
    return { ok: false, error: 'Token not found in hoodmarkets catalog.' };
  }
  if (isV3PoolId(deployment.poolId)) {
    return {
      ok: false,
      error:
        'This token is a Simple launch (Uniswap V3). Use Uniswap on Robinhood Chain — hood.markets one-click swap is for Pro (V4) tokens only.',
    };
  }
  const helper = swapHelperAddress();
  if (!helper) {
    return { ok: false, error: 'HoodMarkets swap helper is not configured on the API.' };
  }
  if (!config.liquid.hookStatic) {
    return { ok: false, error: 'Pro swap is not configured (missing hook address).' };
  }
  return {
    ok: true,
    token: tokenAddress,
    symbol: deployment.tokenSymbol,
    poolId: deployment.poolId,
  };
}

export async function prepareAgentBuy(params: {
  tokenAddress: string;
  amountEth: string;
  taker: Address;
  slippageBps?: number;
}): Promise<PrepareSwapResult> {
  let token: Address;
  try {
    token = getAddress(params.tokenAddress);
  } catch {
    return { ok: false, error: 'tokenAddress must be a valid 0x address.' };
  }

  const ctx = await loadSwapContext(token);
  if (!ctx.ok) {
    return {
      ok: false,
      error: ctx.error,
      uniswapSwapUrl: uniswapSwapUrl(token),
      hint: 'Simple (V3) tokens trade on Uniswap / DexScreener.',
    };
  }

  let amountWei: bigint;
  try {
    amountWei = parseEther(params.amountEth.trim().replace(/\s*eth\s*$/i, ''));
  } catch {
    return { ok: false, error: 'amountEth must be a positive ETH value (e.g. 0.01).' };
  }
  if (amountWei <= 0n) {
    return { ok: false, error: 'amountEth must be greater than zero.' };
  }

  const helper = swapHelperAddress()!;
  const minOut = 1n;

  const data = encodeFunctionData({
    abi: swapHelperAbi,
    functionName: 'buy',
    args: [token, minOut],
  });

  return {
    ok: true,
    chainId: ROBINHOOD_CHAIN_ID,
    tokenAddress: token,
    tokenSymbol: ctx.symbol,
    swapMode: 'hoodmarkets-helper',
    transactions: [
      {
        step: 'buy',
        to: helper,
        data,
        value: `0x${amountWei.toString(16)}` as Hex,
        chainId: ROBINHOOD_CHAIN_ID,
        description: `Buy ${ctx.symbol} with ${params.amountEth} ETH on hood.markets (Robinhood)`,
      },
    ],
    tokenPageUrl: tokenPageUrl(token),
    uniswapSwapUrl: uniswapSwapUrl(token),
  };
}

export async function prepareAgentSell(params: {
  tokenAddress: string;
  amount: string;
  taker: Address;
}): Promise<PrepareSwapResult> {
  let token: Address;
  try {
    token = getAddress(params.tokenAddress);
  } catch {
    return { ok: false, error: 'tokenAddress must be a valid 0x address.' };
  }

  const ctx = await loadSwapContext(token);
  if (!ctx.ok) {
    return {
      ok: false,
      error: ctx.error,
      uniswapSwapUrl: uniswapSwapUrl(token),
    };
  }

  let amountIn: bigint;
  try {
    amountIn = parseHumanAmount(params.amount, 18);
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : 'Invalid token amount';
    return { ok: false, error: msg };
  }
  if (amountIn <= 0n) {
    return { ok: false, error: 'amount must be greater than zero.' };
  }

  const helper = swapHelperAddress()!;
  const client = publicClient();
  const allowance = await client.readContract({
    address: token,
    abi: erc20Abi,
    functionName: 'allowance',
    args: [params.taker, helper],
  });

  const txs: AgentPreparedTx[] = [];
  if (allowance < amountIn) {
    txs.push({
      step: 'approve',
      to: token,
      data: encodeFunctionData({
        abi: erc20Abi,
        functionName: 'approve',
        args: [helper, amountIn],
      }),
      value: '0x0',
      chainId: ROBINHOOD_CHAIN_ID,
      description: `Approve ${ctx.symbol} for hood.markets swap helper`,
    });
  }

  txs.push({
    step: 'sell',
    to: helper,
    data: encodeFunctionData({
      abi: swapHelperAbi,
      functionName: 'sell',
      args: [token, amountIn, 1n],
    }),
    value: '0x0',
    chainId: ROBINHOOD_CHAIN_ID,
    description: `Sell ${params.amount} ${ctx.symbol} for ETH on hood.markets`,
  });

  return {
    ok: true,
    chainId: ROBINHOOD_CHAIN_ID,
    tokenAddress: token,
    tokenSymbol: ctx.symbol,
    swapMode: 'hoodmarkets-helper',
    transactions: txs,
    tokenPageUrl: tokenPageUrl(token),
    uniswapSwapUrl: uniswapSwapUrl(token),
  };
}

/** Sanity-check pool key exists for pro tokens (optional diagnostic). */
export function buildPoolKeyForToken(token: Address): void {
  const hook = config.liquid.hookStatic;
  if (!hook) return;
  buildHoodmarketsPoolKey(token, hook, ROBINHOOD_WETH);
}
