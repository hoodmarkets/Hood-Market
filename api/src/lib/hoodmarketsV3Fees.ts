import {
  createPublicClient,
  createWalletClient,
  encodeFunctionData,
  http,
  zeroAddress,
} from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { config } from '../config.js';
import type { DeploymentCatalogRow } from './deploymentCatalog.js';
import { HOODMARKETS_V3_FRACTION_ABI } from './hoodmarketsV3FractionAbi.js';
import { robinhood, robinhoodTxUrl } from './robinhoodChain.js';

export const HOODMARKETS_V3_CLAIM_ABI = [
  {
    type: 'function',
    name: 'claimRewards',
    inputs: [{ name: 'token', type: 'address', internalType: 'address' }],
    outputs: [],
    stateMutability: 'nonpayable',
  },
  {
    type: 'function',
    name: 'fractionCollectionForToken',
    inputs: [{ name: 'token', type: 'address', internalType: 'address' }],
    outputs: [{ name: '', type: 'address', internalType: 'address' }],
    stateMutability: 'view',
  },
] as const;

/** Simple (Uniswap V3) launches — catalog poolId `v3:*` or V3 factory address. */
export function isV3CatalogDeployment(
  row: Pick<DeploymentCatalogRow, 'poolId' | 'factoryAddress'>,
): boolean {
  const poolId = row.poolId?.trim().toLowerCase() ?? '';
  if (poolId.startsWith('v3:')) return true;
  const v3Factory = config.hoodmarketsV3.factory?.trim().toLowerCase();
  const rowFactory = row.factoryAddress?.trim().toLowerCase() ?? '';
  if (v3Factory && rowFactory && rowFactory === v3Factory) return true;
  // No V4 pool id shape and empty factory — treat as simple (legacy rows).
  if (!poolId && !rowFactory && config.defaultLaunchMode === 'simple') return true;
  return false;
}

/** Resolve V3 claim target: Holder NFT `claimTradingFees()` when present, else legacy factory `claimRewards`. */
export async function resolveV3ClaimTarget(
  tokenAddress: `0x${string}`,
  publicClient: ReturnType<typeof createPublicClient>,
): Promise<{
  to: `0x${string}`;
  data: `0x${string}`;
  usesFraction: boolean;
}> {
  const factory = config.hoodmarketsV3.factory;
  if (!factory) {
    throw new Error('HoodMarkets V3 factory is not configured on the API.');
  }

  const fractionCollection = await publicClient.readContract({
    address: factory as `0x${string}`,
    abi: HOODMARKETS_V3_CLAIM_ABI,
    functionName: 'fractionCollectionForToken',
    args: [tokenAddress],
  });

  if (fractionCollection && fractionCollection !== zeroAddress) {
    return {
      to: fractionCollection as `0x${string}`,
      data: encodeFunctionData({
        abi: HOODMARKETS_V3_FRACTION_ABI,
        functionName: 'claimTradingFees',
        args: [],
      }),
      usesFraction: true,
    };
  }

  return {
    to: factory as `0x${string}`,
    data: encodeFunctionData({
      abi: HOODMARKETS_V3_CLAIM_ABI,
      functionName: 'claimRewards',
      args: [tokenAddress],
    }),
    usesFraction: false,
  };
}

/**
 * V3 simple launches: permissionless `claimTradingFees()` on the Holder NFT contract
 * pulls swap fees from the LP and pays every share holder pro-rata in one transaction.
 */
export async function claimV3RewardsForToken(
  tokenAddress: `0x${string}`,
): Promise<{ txHash: string; basescanUrl: string; message: string }> {
  const account = privateKeyToAccount(config.deployerPrivateKey);
  const publicClient = createPublicClient({
    chain: robinhood,
    transport: http(config.chainRpcUrl),
  });
  const walletClient = createWalletClient({
    chain: robinhood,
    transport: http(config.chainRpcUrl),
    account,
  });

  const target = await resolveV3ClaimTarget(tokenAddress, publicClient);

  if (target.usesFraction) {
    await publicClient.simulateContract({
      address: target.to,
      abi: HOODMARKETS_V3_FRACTION_ABI,
      functionName: 'claimTradingFees',
      args: [],
      account: account.address,
    });
  } else {
    await publicClient.simulateContract({
      address: target.to,
      abi: HOODMARKETS_V3_CLAIM_ABI,
      functionName: 'claimRewards',
      args: [tokenAddress],
      account: account.address,
    });
  }

  const txHash = await walletClient.sendTransaction({
    to: target.to,
    data: target.data,
    value: 0n,
  });

  return {
    txHash,
    basescanUrl: robinhoodTxUrl(txHash),
    message: target.usesFraction
      ? 'Trading fees collected from the pool and sent pro-rata to all Holder NFT share wallets in one transaction.'
      : 'V3 swap fees collected from the pool into the fee recipient wallet (legacy launch without Holder NFTs).',
  };
}

export function friendlyV3ClaimError(msg: string): string {
  const lower = msg.toLowerCase();
  if (
    lower.includes('nothingtoclaim') ||
    lower.includes('nothing to claim') ||
    lower.includes('0x969bf728')
  ) {
    return (
      'Waiting on new swap fees. The last claim already paid out what was available — ' +
      'holders get paid again after more trading adds fees to the locked LP. ' +
      'You can claim anytime; it is not locked or on a timer.'
    );
  }
  if (lower.includes('execution reverted') || lower.includes('revert')) {
    return (
      'Waiting on new swap fees since the last payout. ' +
      'Claim anytime after more trading — not a cooldown or lockout.'
    );
  }
  if (lower.includes('insufficient funds')) {
    return 'Launcher wallet is low on Robinhood Chain ETH for gas. Contact hood.markets support.';
  }
  return msg;
}
