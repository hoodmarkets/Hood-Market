import {
  createPublicClient,
  createWalletClient,
  decodeEventLog,
  encodeFunctionData,
  getAddress,
  http,
  type Address,
  type Hex,
  type PublicClient,
} from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { HOODMARKETS_V3_FRACTION_ABI } from './hoodmarketsV3FractionAbi.js';
import { HOODMARKETS_V3_ABI } from './hoodmarketsV3Abi.js';
import { config } from '../config.js';
import { robinhood } from './robinhoodChain.js';

const FRACTION_ABI = HOODMARKETS_V3_FRACTION_ABI;

const SWAP_EVENT = {
  type: 'event',
  name: 'Swap',
  inputs: [
    { name: 'sender', type: 'address', indexed: true },
    { name: 'recipient', type: 'address', indexed: true },
    { name: 'amount0', type: 'int256', indexed: false },
    { name: 'amount1', type: 'int256', indexed: false },
    { name: 'sqrtPriceX96', type: 'uint160', indexed: false },
    { name: 'liquidity', type: 'uint128', indexed: false },
    { name: 'tick', type: 'int24', indexed: false },
  ],
} as const;

export type BuyerRewardStatus = {
  enabled: boolean;
  cap: number;
  remaining: number;
  issued: number;
  pool: Address | null;
};

export type ProcessBuyerRewardsResult = {
  ok: boolean;
  issued: number;
  buyers: Address[];
  remaining: number;
  message: string;
  txHashes: Hex[];
};

const POOL_TOKEN0_ABI = [
  {
    type: 'function',
    name: 'token0',
    stateMutability: 'view',
    inputs: [],
    outputs: [{ name: '', type: 'address' }],
  },
] as const;

function publicClient(): PublicClient {
  return createPublicClient({
    chain: robinhood,
    transport: http(config.chainRpcUrl),
  });
}

async function readFractionBuyerState(collection: Address) {
  const client = publicClient();
  const [cap, remaining, launchToken, pool, admin] = await Promise.all([
    client.readContract({
      address: collection,
      abi: FRACTION_ABI,
      functionName: 'buyerRewardShareCap',
    }),
    client.readContract({
      address: collection,
      abi: FRACTION_ABI,
      functionName: 'buyerRewardSharesRemaining',
    }),
    client.readContract({
      address: collection,
      abi: FRACTION_ABI,
      functionName: 'launchToken',
    }),
    client.readContract({
      address: collection,
      abi: FRACTION_ABI,
      functionName: 'pool',
    }),
    client.readContract({
      address: collection,
      abi: FRACTION_ABI,
      functionName: 'buyerRewardAdmin',
    }),
  ]);
  return {
    cap: Number(cap),
    remaining: Number(remaining),
    launchToken: getAddress(launchToken as Address),
    pool: getAddress(pool as Address),
    admin: getAddress(admin as Address),
  };
}

function isBuyOfLaunchToken(
  launchToken: Address,
  poolToken0: Address,
  amount0: bigint,
  amount1: bigint,
): boolean {
  const launchIsToken0 = launchToken.toLowerCase() === poolToken0.toLowerCase();
  if (launchIsToken0) {
    return amount0 < 0n;
  }
  return amount1 < 0n;
}

/** Read buyer-reward escrow state for a launched token. */
export async function getBuyerRewardStatus(tokenAddress: Address): Promise<BuyerRewardStatus> {
  const factory = config.hoodmarketsV3.factory;
  if (!factory) {
    throw new Error('HoodMarkets V3 factory is not configured.');
  }

  const client = publicClient();
  const token = getAddress(tokenAddress);

  const collection = getAddress(
    (await client.readContract({
      address: factory,
      abi: HOODMARKETS_V3_ABI,
      functionName: 'fractionCollectionForToken',
      args: [token],
    })) as Address,
  );

  const state = await readFractionBuyerState(collection);
  const enabled =
    state.cap > 0 &&
    !!state.pool &&
    state.pool !== '0x0000000000000000000000000000000000000000';

  return {
    enabled,
    cap: state.cap,
    remaining: state.remaining,
    issued: Math.max(0, state.cap - state.remaining),
    pool: enabled ? state.pool : null,
  };
}

/** Scan pool swaps and issue buyer-reward shares to first unique buyers. */
export async function processBuyerRewardShares(
  tokenAddress: Address,
  opts?: { fromBlock?: bigint },
): Promise<ProcessBuyerRewardsResult> {
  const factory = config.hoodmarketsV3.factory;
  if (!factory) {
    throw new Error('HoodMarkets V3 factory is not configured.');
  }

  const client = publicClient();
  const token = getAddress(tokenAddress);

  const collection = getAddress(
    (await client.readContract({
      address: factory,
      abi: HOODMARKETS_V3_ABI,
      functionName: 'fractionCollectionForToken',
      args: [token],
    })) as Address,
  );

  const state = await readFractionBuyerState(collection);
  if (state.cap === 0 || state.remaining === 0) {
    return {
      ok: true,
      issued: 0,
      buyers: [],
      remaining: state.remaining,
      message: 'No buyer reward pool configured or pool is exhausted.',
      txHashes: [],
    };
  }

  if (!state.pool || state.pool === '0x0000000000000000000000000000000000000000') {
    return {
      ok: true,
      issued: 0,
      buyers: [],
      remaining: state.remaining,
      message: 'Buyer rewards are not enabled for this token (pre-v0.6 launch).',
      txHashes: [],
    };
  }

  const fromBlock = opts?.fromBlock ?? 0n;
  const logs = await client.getLogs({
    address: state.pool,
    event: SWAP_EVENT,
    fromBlock,
    toBlock: 'latest',
  });

  const poolToken0 = getAddress(
    (await client.readContract({
      address: state.pool,
      abi: POOL_TOKEN0_ABI,
      functionName: 'token0',
    })) as Address,
  );
  const candidates: Address[] = [];
  const seen = new Set<string>();

  for (const log of logs) {
    if (state.remaining - candidates.length <= 0) break;
    try {
      const decoded = decodeEventLog({
        abi: [SWAP_EVENT],
        data: log.data,
        topics: log.topics as [Hex, ...Hex[]],
      });
      const recipient = getAddress(decoded.args.recipient as Address);
      const amount0 = decoded.args.amount0 as bigint;
      const amount1 = decoded.args.amount1 as bigint;
      if (!isBuyOfLaunchToken(state.launchToken, poolToken0, amount0, amount1)) continue;
      const key = recipient.toLowerCase();
      if (key === state.admin.toLowerCase()) continue;
      if (seen.has(key)) continue;

      const already = (await client.readContract({
        address: collection,
        abi: FRACTION_ABI,
        functionName: 'buyerShareIssued',
        args: [recipient],
      })) as boolean;
      if (already) {
        seen.add(key);
        continue;
      }

      seen.add(key);
      candidates.push(recipient);
    } catch {
      // skip malformed logs
    }
  }

  if (candidates.length === 0) {
    return {
      ok: true,
      issued: 0,
      buyers: [],
      remaining: state.remaining,
      message: 'No new qualifying buyers found yet.',
      txHashes: [],
    };
  }

  const account = privateKeyToAccount(config.deployerPrivateKey);
  const walletClient = createWalletClient({
    chain: robinhood,
    transport: http(config.chainRpcUrl),
    account,
  });

  const issued: Address[] = [];
  const txHashes: Hex[] = [];
  let remaining = state.remaining;

  for (const buyer of candidates) {
    if (remaining <= 0) break;
    try {
      await client.simulateContract({
        address: factory,
        abi: HOODMARKETS_V3_ABI,
        functionName: 'issueBuyerShare',
        args: [token, buyer],
        account: account.address,
      });
      const data = encodeFunctionData({
        abi: HOODMARKETS_V3_ABI,
        functionName: 'issueBuyerShare',
        args: [token, buyer],
      });
      const hash = await walletClient.sendTransaction({
        to: factory,
        data,
        value: 0n,
      });
      await client.waitForTransactionReceipt({ hash });
      txHashes.push(hash);
      issued.push(buyer);
      remaining -= 1;
    } catch {
      // skip failed issuance (race or exhausted pool)
    }
  }

  return {
    ok: true,
    issued: issued.length,
    buyers: issued,
    remaining,
    message:
      issued.length > 0
        ? `Issued ${issued.length} buyer reward share${issued.length === 1 ? '' : 's'}.`
        : 'Could not issue shares (pool may be exhausted or factory not v0.6).',
    txHashes,
  };
}
