import { createPublicClient, createWalletClient, http, type Hash, type PublicClient, type WalletClient } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { config } from '../config.js';
import { robinhood } from './robinhoodChain.js';
import { markOrderRefunded, type PetitionOrderRow } from './petitionDb.js';
import { refundPetitionDeposit } from './petitionRobinhoodEscrow.js';

export type PetitionRefundClients = {
  publicClient: PublicClient;
  walletClient: WalletClient;
};

export function createPetitionRefundClients(): PetitionRefundClients {
  const account = privateKeyToAccount(config.deployerPrivateKey);
  const publicClient = createPublicClient({
    chain: robinhood,
    transport: http(config.chainRpcUrl),
  }) as PublicClient;
  const walletClient = createWalletClient({
    account,
    chain: robinhood,
    transport: http(config.chainRpcUrl),
  }) as WalletClient;
  return { publicClient, walletClient };
}

export async function refundPetitionOrder(
  petitionId: number,
  order: PetitionOrderRow,
  clients: PetitionRefundClients,
): Promise<Hash> {
  const refundWei = BigInt(order.deposit_wei || '0');
  const refundTx = await refundPetitionDeposit({
    wallet: order.wallet,
    wei: refundWei,
    walletClient: clients.walletClient,
    publicClient: clients.publicClient,
  });
  await markOrderRefunded(petitionId, order.wallet);
  return refundTx;
}

export async function refundAllActivePetitionOrders(
  petitionId: number,
  orders: PetitionOrderRow[],
): Promise<Array<{ wallet: string; refundTxHash: Hash }>> {
  const active = orders.filter((o) => o.status === 'active');
  if (active.length === 0) return [];

  const clients = createPetitionRefundClients();
  const results: Array<{ wallet: string; refundTxHash: Hash }> = [];
  for (const order of active) {
    const refundTxHash = await refundPetitionOrder(petitionId, order, clients);
    results.push({ wallet: order.wallet, refundTxHash });
  }
  return results;
}
