import { createPublicClient, createWalletClient, encodeFunctionData, http } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { config } from '../config.js';
import { claimWethTradingFeesForFeeOwner, FEE_LOCKER_CLAIM_ABI } from './feeLockerClaim.js';
import { BASE_WETH } from './liquidFactoryDeploy.js';
import { LIQUID_LP_LOCKER_COLLECT_ABI } from './liquidLpLockerCollectAbi.js';
import { robinhood, robinhoodTxUrl } from './robinhoodChain.js';

export function friendlyCollectPoolError(msg: string): string {
  const lower = msg.toLowerCase();
  if (lower.includes('execution reverted')) {
    return (
      'Could not collect pool fees yet. The pool may still be in its anti-sniper window, ' +
      'or no LP fees have accrued. Try again after more trading activity.'
    );
  }
  if (lower.includes('insufficient funds')) {
    return 'Launcher wallet is low on gas. Contact hood.markets support.';
  }
  return msg;
}

/** WETH balance waiting in the fee locker for `feeOwner` (after pool collect). */
export async function readPendingWethFeesForFeeOwner(
  feeOwner: `0x${string}`,
): Promise<bigint> {
  const publicClient = createPublicClient({
    chain: robinhood,
    transport: http(config.chainRpcUrl),
  });
  return publicClient.readContract({
    address: config.liquid.feeLocker,
    abi: FEE_LOCKER_CLAIM_ABI,
    functionName: 'feesToClaim',
    args: [feeOwner, BASE_WETH],
  });
}

/**
 * Permissionless on-chain: pull accrued LP fees into the fee locker.
 * Launcher wallet pays gas so visitors do not need a wallet.
 */
export async function collectPoolFeesForLaunchedToken(
  tokenAddress: `0x${string}`,
): Promise<{ txHash: string; basescanUrl: string; message: string }> {
  const lpLocker = config.liquid.lpLocker;
  if (!lpLocker) {
    throw new Error('LP locker address is not configured on the API.');
  }

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

  await publicClient.simulateContract({
    address: lpLocker,
    abi: LIQUID_LP_LOCKER_COLLECT_ABI,
    functionName: 'collectRewards',
    args: [tokenAddress],
    account: account.address,
  });

  const data = encodeFunctionData({
    abi: LIQUID_LP_LOCKER_COLLECT_ABI,
    functionName: 'collectRewards',
    args: [tokenAddress],
  });

  const txHash = await walletClient.sendTransaction({
    to: lpLocker,
    data,
    value: 0n,
  });

  return {
    txHash,
    basescanUrl: robinhoodTxUrl(txHash),
    message:
      'Pool fees collected into the fee locker (if any were available). Use Claim fees after trading generates fees.',
  };
}

/**
 * Permissionless on-chain: claim accumulated WETH from the locker to `feeOwner`.
 * Launcher wallet pays gas; funds always go to the recorded fee recipient.
 */
export async function claimWethFeesForLaunchedToken(feeOwner: `0x${string}`) {
  return claimWethTradingFeesForFeeOwner(feeOwner);
}
