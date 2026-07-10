import { getAddress, isHash } from 'viem';
import { robinhood } from './robinhoodChain.js';

/** Narrow client shape to avoid duplicate `viem` `PublicClient` types across the bundle. */
type TxLookupClient = {
  getTransactionReceipt: (args: { hash: `0x${string}` }) => Promise<{
    status: 'success' | 'reverted';
  } | null>;
  getTransaction: (args: { hash: `0x${string}` }) => Promise<{
    from?: `0x${string}`;
    to?: `0x${string}` | null;
    value?: bigint;
    chainId?: bigint | number;
  } | null>;
};

/**
 * Verify a plain ETH transfer on Robinhood Chain from `expectedFrom` to `treasury` with value >= `minValueWei`.
 * Used instead of EIP-191 when agents can pay from the fee wallet but cannot sign messages.
 */
export async function verifyAgentPaymentTransaction(params: {
  publicClient: TxLookupClient;
  txHash: string;
  expectedFrom: `0x${string}`;
  treasury: `0x${string}`;
  minValueWei: bigint;
}): Promise<void> {
  const { publicClient, minValueWei, treasury } = params;
  if (!isHash(params.txHash)) {
    throw new Error('paymentTxHash must be a 32-byte hex transaction hash');
  }
  const txHash = params.txHash as `0x${string}`;
  const from = getAddress(params.expectedFrom);
  const to = getAddress(treasury);

  const receipt = await publicClient.getTransactionReceipt({ hash: txHash });
  if (!receipt) {
    throw new Error('Payment transaction not found');
  }
  if (receipt.status !== 'success') {
    throw new Error('Payment transaction failed on-chain');
  }

  const tx = await publicClient.getTransaction({ hash: txHash });
  if (!tx) {
    throw new Error('Payment transaction not found');
  }
  if (tx.chainId != null && BigInt(tx.chainId) !== BigInt(robinhood.id)) {
    throw new Error(`Payment transaction must be on Robinhood Chain (chain ID ${robinhood.id})`);
  }

  const txFrom = tx.from ? getAddress(tx.from) : null;
  if (!txFrom || txFrom !== from) {
    throw new Error(
      'Payment transaction must be sent from agentFeeRecipient (the fee wallet address)',
    );
  }
  const txTo = tx.to ? getAddress(tx.to) : null;
  if (!txTo || txTo !== to) {
    throw new Error(
      'Payment transaction must send ETH to the treasury address from the payment_required response',
    );
  }
  const v = tx.value ?? 0n;
  if (v < minValueWei) {
    throw new Error(
      `Payment amount too low: need at least ${minValueWei.toString()} wei (got ${v.toString()})`,
    );
  }
}
