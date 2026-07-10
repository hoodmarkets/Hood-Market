import { createPublicClient, createWalletClient, encodeFunctionData, http } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { config } from '../config.js';
import { BASE_WETH } from './liquidFactoryDeploy.js';
import { robinhood, robinhoodTxUrl } from './robinhoodChain.js';

export const FEE_LOCKER_CLAIM_ABI = [
  {
    type: 'function',
    name: 'feesToClaim',
    inputs: [
      { name: 'feeOwner', type: 'address' },
      { name: 'token', type: 'address' },
    ],
    outputs: [{ name: 'balance', type: 'uint256' }],
    stateMutability: 'view',
  },
  {
    type: 'function',
    name: 'claim',
    inputs: [
      { name: 'feeOwner', type: 'address' },
      { name: 'token', type: 'address' },
    ],
    outputs: [],
    stateMutability: 'nonpayable',
  },
] as const;

/** Trading/LP fees in Liquid’s locker are denominated as WETH on Base, not the liquid token. */
const CLAIM_ASSET = BASE_WETH;

export type ClaimWethFeesResult =
  | {
      ok: true;
      txHash: string;
      basescanUrl: string;
      feeAmountWei: bigint;
      feeOwner: `0x${string}`;
      claimAsset: typeof CLAIM_ASSET;
    }
  | { ok: false; error: string; code: 'zero_balance' };

/**
 * Server-wallet broadcast: claim accumulated WETH trading fees for `feeOwner`.
 */
export async function claimWethTradingFeesForFeeOwner(
  feeOwner: `0x${string}`,
): Promise<ClaimWethFeesResult> {
  const publicClient = createPublicClient({
    chain: robinhood,
    transport: http(config.chainRpcUrl),
  });

  const feesClaim = await publicClient.readContract({
    address: config.liquid.feeLocker,
    abi: FEE_LOCKER_CLAIM_ABI,
    functionName: 'feesToClaim',
    args: [feeOwner, CLAIM_ASSET],
  });

  if (feesClaim === 0n) {
    return {
      ok: false,
      code: 'zero_balance',
      error: 'No WETH trading fees to claim for this fee wallet yet.',
    };
  }

  const account = privateKeyToAccount(config.deployerPrivateKey);
  const walletClient = createWalletClient({
    chain: robinhood,
    transport: http(config.chainRpcUrl),
    account,
  });

  const callData = encodeFunctionData({
    abi: FEE_LOCKER_CLAIM_ABI,
    functionName: 'claim',
    args: [feeOwner, CLAIM_ASSET],
  });

  const txHash = await walletClient.sendTransaction({
    to: config.liquid.feeLocker,
    data: callData,
    value: 0n,
  });

  const receipt = await publicClient.waitForTransactionReceipt({ hash: txHash });
  if (receipt.status !== 'success') {
    return {
      ok: false,
      code: 'zero_balance',
      error: `Claim transaction reverted (tx: ${txHash})`,
    };
  }

  const feeAmountWei = BigInt(feesClaim.toString());
  return {
    ok: true,
    txHash,
    basescanUrl: robinhoodTxUrl(txHash),
    feeAmountWei,
    feeOwner,
    claimAsset: CLAIM_ASSET,
  };
}
