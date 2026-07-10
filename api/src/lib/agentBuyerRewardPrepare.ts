import {
  createPublicClient,
  encodeFunctionData,
  getAddress,
  http,
  zeroAddress,
  type Address,
  type Hex,
} from 'viem';
import { config } from '../config.js';
import { getDeploymentByTokenAddress, getNewestDeploymentByTickerSymbol } from './deploymentCatalog.js';
import { clampBuyerRewardShareCount } from './hoodmarketsV3Deploy.js';
import { HOODMARKETS_V3_FRACTION_ABI } from './hoodmarketsV3FractionAbi.js';
import { isV3CatalogDeployment } from './hoodmarketsV3Fees.js';
import type { AgentPreparedTx } from './agentSwapPrepare.js';
import { getBuyerRewardStatus } from './fractionBuyerRewards.js';
import { ROBINHOOD_CHAIN_ID, ROBINHOOD_RPC_DEFAULT } from './robinhoodChain.js';

const FRACTION_FACTORY_ABI = [
  {
    type: 'function',
    name: 'fractionCollectionForToken',
    stateMutability: 'view',
    inputs: [{ name: 'token', type: 'address' }],
    outputs: [{ name: '', type: 'address' }],
  },
] as const;

/** v0.9+ factories expose post-launch fundBuyerRewardPool / cancelBuyerRewardPool. */
const POST_LAUNCH_BUYER_REWARD_FACTORIES = new Set(
  [
    '0x9BDdC8ddf28f5629C989A36Eb5bb6C73cBA60Df5', // v0.11
    '0xf65536Eb3354Ad7e77E1b0d0F7bEBFa1C88885C9', // v0.10
    '0x3a94FD3422F50ed6cC08e547c6C697E4bb3e76c8', // v0.9
  ].map((a) => a.toLowerCase()),
);

const FRACTION_COUNT = 1000;

function publicClient() {
  return createPublicClient({
    transport: http(config.chainRpcUrl || ROBINHOOD_RPC_DEFAULT),
  });
}

function tokenPageUrl(token: Address): string {
  const base = (process.env.LAUNCHER_WEB_URL || 'https://hood.markets').replace(/\/$/, '');
  return `${base}/?token=${token}`;
}

function parseShareAmount(raw: unknown): number | null {
  if (raw === undefined || raw === null || raw === '') return null;
  const n =
    typeof raw === 'number'
      ? raw
      : typeof raw === 'string'
        ? Number.parseInt(raw.trim(), 10)
        : NaN;
  if (!Number.isFinite(n) || n <= 0) return null;
  return clampBuyerRewardShareCount(n);
}

async function resolveTokenAddress(raw: string): Promise<Address | null> {
  const trimmed = raw.trim();
  if (/^0x[0-9a-fA-F]{40}$/.test(trimmed)) {
    try {
      return getAddress(trimmed);
    } catch {
      return null;
    }
  }
  const row = await getNewestDeploymentByTickerSymbol(trimmed.toUpperCase());
  return row ? getAddress(row.tokenAddress) : null;
}

function resolveFactoryAddress(factoryAddress?: string | null): Address | null {
  const fromRow = factoryAddress?.trim();
  if (fromRow) {
    try {
      return getAddress(fromRow);
    } catch {
      return null;
    }
  }
  const fromConfig = config.hoodmarketsV3.factory?.trim();
  if (!fromConfig) return null;
  try {
    return getAddress(fromConfig);
  } catch {
    return null;
  }
}

export type PrepareFundBuyerRewardsResult =
  | {
      ok: true;
      chainId: number;
      tokenAddress: Address;
      tokenSymbol: string;
      fractionCollection: Address;
      shareAmount: number;
      sharesKept: number;
      buyerRewardStatus: Awaited<ReturnType<typeof getBuyerRewardStatus>>;
      transactions: AgentPreparedTx[];
      tokenPageUrl: string;
      replyHint: string;
      confirmHint: string;
      afterFundingNote: string;
    }
  | {
      ok: false;
      error: string;
      hint?: string;
      tokenPageUrl?: string;
    };

export type PrepareCancelBuyerRewardsResult =
  | {
      ok: true;
      chainId: number;
      tokenAddress: Address;
      tokenSymbol: string;
      fractionCollection: Address;
      sharesToReturn: number;
      transactions: AgentPreparedTx[];
      tokenPageUrl: string;
      replyHint: string;
      confirmHint: string;
    }
  | {
      ok: false;
      error: string;
      hint?: string;
      tokenPageUrl?: string;
    };

async function loadBuyerRewardContext(
  tokenRaw: string,
  wallet: Address,
): Promise<
  | {
      token: Address;
      symbol: string;
      fractionCollection: Address;
      factory: Address;
      feeRecipient: Address;
      buyerRewardAdmin: Address;
      walletShareBalance: number;
    }
  | { ok: false; error: string; hint?: string; tokenPageUrl?: string }
> {
  const token = await resolveTokenAddress(tokenRaw);
  if (!token) {
    return { ok: false, error: 'tokenAddress or symbol must resolve to a hood.markets token.' };
  }

  const deployment = await getDeploymentByTokenAddress(token);
  if (!deployment) {
    return {
      ok: false,
      error: 'Token not found in hood.markets catalog.',
      tokenPageUrl: tokenPageUrl(token),
    };
  }

  if (!isV3CatalogDeployment(deployment)) {
    return {
      ok: false,
      error: 'Buyer reward pools are only available on Simple (V3) launches with Holder NFT shares.',
      tokenPageUrl: tokenPageUrl(token),
    };
  }

  const factory = resolveFactoryAddress(deployment.factoryAddress);
  if (!factory) {
    return { ok: false, error: 'HoodMarkets V3 factory is not configured on the API.' };
  }

  if (!POST_LAUNCH_BUYER_REWARD_FACTORIES.has(factory.toLowerCase())) {
    return {
      ok: false,
      error: 'This token was launched on a factory before v0.9 — post-launch buyer reward funding is not supported.',
      hint: 'Use buyerRewardShareCount at deploy time for v0.8 tokens, or relaunch on the current factory.',
      tokenPageUrl: tokenPageUrl(token),
    };
  }

  const feeRecipient = getAddress(deployment.feeRecipientAddress);
  if (feeRecipient.toLowerCase() !== wallet.toLowerCase()) {
    return {
      ok: false,
      error: 'Only the catalog fee recipient can fund or cancel the buyer reward pool.',
      hint: `Connect wallet ${feeRecipient} (fee recipient for ${deployment.tokenSymbol}).`,
      tokenPageUrl: tokenPageUrl(token),
    };
  }

  const client = publicClient();
  const fractionCollection = getAddress(
    (await client.readContract({
      address: factory,
      abi: FRACTION_FACTORY_ABI,
      functionName: 'fractionCollectionForToken',
      args: [token],
    })) as Address,
  );

  if (!fractionCollection || fractionCollection === zeroAddress) {
    return {
      ok: false,
      error: 'No Holder NFT fraction contract found for this token.',
      tokenPageUrl: tokenPageUrl(token),
    };
  }

  const [buyerRewardAdmin, walletBalance] = await Promise.all([
    client.readContract({
      address: fractionCollection,
      abi: HOODMARKETS_V3_FRACTION_ABI,
      functionName: 'buyerRewardAdmin',
    }),
    client.readContract({
      address: fractionCollection,
      abi: HOODMARKETS_V3_FRACTION_ABI,
      functionName: 'balanceOf',
      args: [wallet, 0n],
    }),
  ]);

  const admin = getAddress(buyerRewardAdmin as Address);
  if (admin.toLowerCase() !== wallet.toLowerCase()) {
    return {
      ok: false,
      error: 'Wallet is not the on-chain buyer reward admin for this token.',
      hint: `On-chain admin is ${admin}.`,
      tokenPageUrl: tokenPageUrl(token),
    };
  }

  const shareBalance = Number(walletBalance);

  return {
    token,
    symbol: deployment.tokenSymbol,
    fractionCollection,
    factory,
    feeRecipient,
    buyerRewardAdmin: admin,
    walletShareBalance: shareBalance,
  };
}

export async function prepareAgentFundBuyerRewards(params: {
  wallet: Address;
  tokenAddress: string;
  shareAmount?: unknown;
}): Promise<PrepareFundBuyerRewardsResult> {
  const ctx = await loadBuyerRewardContext(params.tokenAddress, params.wallet);
  if ('ok' in ctx) return ctx;

  const shareAmount = parseShareAmount(params.shareAmount);
  if (!shareAmount) {
    return {
      ok: false,
      error: 'shareAmount is required (positive integer, max 1000).',
      hint: 'Example: 999 to escrow 999 Holder shares for first buyers.',
      tokenPageUrl: tokenPageUrl(ctx.token),
    };
  }

  if (shareAmount > ctx.walletShareBalance) {
    return {
      ok: false,
      error: `Insufficient Holder shares. Wallet holds ${ctx.walletShareBalance}; requested ${shareAmount}.`,
      tokenPageUrl: tokenPageUrl(ctx.token),
    };
  }

  const data = encodeFunctionData({
    abi: HOODMARKETS_V3_FRACTION_ABI,
    functionName: 'fundBuyerRewardPool',
    args: [BigInt(shareAmount)],
  });

  let buyerRewardStatus: Awaited<ReturnType<typeof getBuyerRewardStatus>>;
  try {
    buyerRewardStatus = await getBuyerRewardStatus(ctx.token);
  } catch {
    buyerRewardStatus = {
      enabled: false,
      cap: 0,
      remaining: 0,
      issued: 0,
      pool: null,
    };
  }

  const sharesKept = ctx.walletShareBalance - shareAmount;

  return {
    ok: true,
    chainId: ROBINHOOD_CHAIN_ID,
    tokenAddress: ctx.token,
    tokenSymbol: ctx.symbol,
    fractionCollection: ctx.fractionCollection,
    shareAmount,
    sharesKept,
    buyerRewardStatus,
    transactions: [
      {
        step: 'fundBuyerRewardPool',
        to: ctx.fractionCollection,
        data,
        value: '0x0',
        chainId: ROBINHOOD_CHAIN_ID,
        description: `Escrow ${shareAmount} Holder share(s) for ${ctx.symbol} buyer rewards (${sharesKept} kept in wallet).`,
      },
    ],
    tokenPageUrl: tokenPageUrl(ctx.token),
    replyHint: `Prepared to escrow ${shareAmount} of ${FRACTION_COUNT} Holder shares for $${ctx.symbol} buyer rewards. Submit via Bankr wallet on Robinhood (4663).`,
    confirmHint:
      'Submit via Bankr /wallet/submit with waitForConfirmation: true. Only the fee recipient wallet may sign.',
    afterFundingNote:
      'After the tx confirms, hood.markets scans pool buys and issues one share per unique buyer until the pool is empty (background poller + POST /api/deployments/:token/process-buyer-rewards).',
  };
}

export async function prepareAgentCancelBuyerRewards(params: {
  wallet: Address;
  tokenAddress: string;
}): Promise<PrepareCancelBuyerRewardsResult> {
  const ctx = await loadBuyerRewardContext(params.tokenAddress, params.wallet);
  if ('ok' in ctx) return ctx;

  const client = publicClient();
  const remaining = Number(
    await client.readContract({
      address: ctx.fractionCollection,
      abi: HOODMARKETS_V3_FRACTION_ABI,
      functionName: 'buyerRewardSharesRemaining',
    }),
  );

  if (remaining <= 0) {
    return {
      ok: false,
      error: 'No shares remain in the buyer reward pool to cancel.',
      tokenPageUrl: tokenPageUrl(ctx.token),
    };
  }

  const data = encodeFunctionData({
    abi: HOODMARKETS_V3_FRACTION_ABI,
    functionName: 'cancelBuyerRewardPool',
    args: [],
  });

  return {
    ok: true,
    chainId: ROBINHOOD_CHAIN_ID,
    tokenAddress: ctx.token,
    tokenSymbol: ctx.symbol,
    fractionCollection: ctx.fractionCollection,
    sharesToReturn: remaining,
    transactions: [
      {
        step: 'cancelBuyerRewardPool',
        to: ctx.fractionCollection,
        data,
        value: '0x0',
        chainId: ROBINHOOD_CHAIN_ID,
        description: `Return ${remaining} unissued buyer-reward share(s) to your wallet.`,
      },
    ],
    tokenPageUrl: tokenPageUrl(ctx.token),
    replyHint: `Prepared to cancel ${ctx.symbol} buyer rewards and return ${remaining} unissued share(s).`,
    confirmHint:
      'Submit via Bankr /wallet/submit with waitForConfirmation: true. Only the fee recipient wallet may sign.',
  };
}
