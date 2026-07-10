import {
  createPublicClient,
  getAddress,
  http,
  isAddress,
  type Hash,
  type PublicClient,
} from 'viem';
import { config } from '../config.js';
import { robinhood } from './robinhoodChain.js';
import { petitionEscrowAddress, requiredDepositWei } from './petitionConfig.js';

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

export function parseEvmWallet(raw: string): `0x${string}` | null {
  const trimmed = String(raw || '').trim();
  if (!trimmed || !isAddress(trimmed, { strict: false })) return null;
  try {
    return getAddress(trimmed);
  } catch {
    return null;
  }
}

export function createPetitionPublicClient(): PublicClient | null {
  if (!config.chainRpcUrl) return null;
  return createPublicClient({
    chain: robinhood,
    transport: http(config.chainRpcUrl, { timeout: 120_000 }),
  }) as PublicClient;
}

export async function verifyPetitionDeposit(args: {
  hash: Hash;
  buyer: string;
  contributionWei: bigint;
  publicClient?: PublicClient | null;
}): Promise<{ wei: string }> {
  const escrow = petitionEscrowAddress();
  if (!escrow) throw new Error('Petition escrow is not configured.');

  const needed = requiredDepositWei(args.contributionWei);
  const buyerAddr = parseEvmWallet(args.buyer);
  if (!buyerAddr) throw new Error('Invalid buyer wallet.');

  const publicClient = args.publicClient ?? createPetitionPublicClient();
  if (!publicClient) throw new Error('Robinhood RPC is not configured.');

  let receipt = null;
  for (let attempt = 0; attempt < 12; attempt++) {
    try {
      receipt = await publicClient.getTransactionReceipt({ hash: args.hash });
      if (receipt) break;
    } catch {
      /* retry */
    }
    await sleep(attempt < 3 ? 1500 : 2500);
  }
  if (!receipt) {
    throw new Error('Deposit transaction not found yet. Wait a few seconds and retry.');
  }
  if (receipt.status !== 'success') {
    throw new Error('Deposit transaction failed on-chain.');
  }

  const tx = await publicClient.getTransaction({ hash: args.hash });
  if (!tx) throw new Error('Deposit transaction not found.');
  if (getAddress(tx.from) !== buyerAddr) {
    throw new Error('Deposit must come from the buyer wallet.');
  }
  if (!tx.to || getAddress(tx.to) !== escrow) {
    throw new Error('Deposit must go to the community launch escrow wallet.');
  }
  if (tx.value < needed) {
    throw new Error(
      `Deposit too small. Required ${(Number(needed) / 1e18).toFixed(6)} ETH.`,
    );
  }
  return { wei: tx.value.toString() };
}

export async function refundPetitionDeposit(args: {
  wallet: string;
  wei: bigint;
  walletClient: import('viem').WalletClient;
  publicClient: PublicClient;
}): Promise<Hash> {
  const destination = parseEvmWallet(args.wallet);
  if (!destination) throw new Error('Invalid refund wallet.');
  if (args.wei <= 0n) throw new Error('Nothing to refund.');

  const hash = await args.walletClient.sendTransaction({
    chain: robinhood,
    account: args.walletClient.account!,
    to: destination,
    value: args.wei,
  });
  await args.publicClient.waitForTransactionReceipt({ hash });
  return hash;
}
