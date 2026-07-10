import { getAddress, type Address, type Hash } from 'viem';
import { config } from '../config.js';
import { hoodClaimWallet } from './petitionConfig.js';
import {
  computeProRataShareAllocations,
  petitionTargetRaiseWei,
  sumOrderContributions,
} from './petitionEthGoal.js';
import {
  type PetitionOrderRow,
  type PetitionRow,
  markPetitionFailed,
  markPetitionFinalized,
  markPetitionFinalizing,
} from './petitionDb.js';
import { LiquidDeployer } from '../deployer.js';
import { logger } from '../logger.js';
import {
  createPublicClient,
  createWalletClient,
  http,
  type PublicClient,
  type WalletClient,
} from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { robinhood } from './robinhoodChain.js';
import { HOODMARKETS_V3_FRACTION_ABI } from './hoodmarketsV3FractionAbi.js';
import { refundAllActivePetitionOrders } from './petitionRefunds.js';

async function refundBackersAfterFailedFinalize(petitionId: number): Promise<void> {
  try {
    const { listPetitionOrders } = await import('./petitionDb.js');
    const orders = await listPetitionOrders(petitionId);
    const results = await refundAllActivePetitionOrders(petitionId, orders);
    logger.info('Community launch failure refunds sent', {
      petitionId,
      refundCount: results.length,
    });
  } catch (err: unknown) {
    logger.error('Community launch failure refund error', {
      petitionId,
      error: err instanceof Error ? err.message : String(err),
    });
  }
}

function buildAirdropLists(
  petition: PetitionRow,
  orders: PetitionOrderRow[],
): { recipients: Address[]; amounts: bigint[] } {
  const recipients: Address[] = [];
  const amounts: bigint[] = [];

  for (const alloc of computeProRataShareAllocations(petition, orders)) {
    recipients.push(getAddress(alloc.wallet));
    amounts.push(alloc.shares);
  }

  if (petition.hood_claim_opt_in === 1) {
    const platform = hoodClaimWallet();
    if (platform) {
      recipients.push(getAddress(platform));
      amounts.push(1n);
    }
  }

  return { recipients, amounts };
}

export async function finalizePetition(petitionId: number): Promise<{
  ok: boolean;
  tokenAddress?: string;
  deployTxHash?: string;
  airdropTxHash?: string;
  error?: string;
}> {
  const { getPetitionById, listPetitionOrders } = await import('./petitionDb.js');
  const petition = await getPetitionById(petitionId);
  if (!petition) return { ok: false, error: 'Petition not found.' };
  if (petition.status === 'finalized') {
    return {
      ok: true,
      tokenAddress: petition.token_address || undefined,
      deployTxHash: petition.deploy_tx_hash || undefined,
      airdropTxHash: petition.airdrop_tx_hash || undefined,
    };
  }
  if (petition.status !== 'locked' && petition.status !== 'failed') {
    return { ok: false, error: 'Petition is not sold out yet.' };
  }

  const orders = await listPetitionOrders(petitionId);
  const raised = sumOrderContributions(orders);
  const target = petitionTargetRaiseWei(petition);
  if (target <= 0n) {
    return { ok: false, error: 'Community launch has no raise target configured.' };
  }
  if (raised < target) {
    return {
      ok: false,
      error: `Raise incomplete: ${raised} wei of ${target} wei target.`,
    };
  }

  await markPetitionFinalizing(petitionId);

  const {
    isTickerGloballyReserved,
    isNameGloballyReserved,
    getGlobalTickerCooldownConflict,
    getGlobalNameCooldownConflict,
    formatDeployCooldownConflictMessage,
  } = await import('./globalTickerCooldown.js');

  if (await isTickerGloballyReserved(petition.token_symbol)) {
    const conflict = await getGlobalTickerCooldownConflict(petition.token_symbol);
    const msg = conflict
      ? formatDeployCooldownConflictMessage(conflict)
      : `Ticker $${petition.token_symbol} was deployed while this Community Launch was open.`;
    await markPetitionFailed(petitionId, msg);
    await refundBackersAfterFailedFinalize(petitionId);
    return { ok: false, error: msg };
  }

  if (await isNameGloballyReserved(petition.token_name)) {
    const conflict = await getGlobalNameCooldownConflict(petition.token_name);
    const msg = conflict
      ? formatDeployCooldownConflictMessage(conflict)
      : `Token name "${petition.token_name}" was deployed while this Community Launch was open.`;
    await markPetitionFailed(petitionId, msg);
    await refundBackersAfterFailedFinalize(petitionId);
    return { ok: false, error: msg };
  }

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

  const devBuyAmount = raised;

  try {
    const deployer = new LiquidDeployer();
    const result = await deployer.deployToken({
      name: petition.token_name,
      symbol: petition.token_symbol,
      description: petition.description || undefined,
      imageUrl: petition.image_url || undefined,
      websiteUrl: petition.website_url || undefined,
      xUrl: petition.tweet_url || undefined,
      walletAddress: account.address,
      devBuyAmount,
      hookType: 'static',
      platform: 'petition',
      deployerId: `petition-${petitionId}`,
      deployerLabel: `Community Launch #${petitionId}`,
      sourceUrl: petition.tweet_url || petition.source_url || undefined,
      feeRecipientLabel: petition.starter_wallet || undefined,
      feeToSelf: false,
      clientKind: 'web',
      chain: 'robinhood',
      launchMode: 'simple',
      buyerRewardShareCount: 0,
      tokenDescription:
        petition.description ||
        `Community launch #${petitionId} on hood.markets — deployed after ${(Number(raised) / 1e18).toFixed(4)} ETH raised.`,
      catalogFeeRecipientAddress: petition.starter_wallet || undefined,
    });

    const fractionAddress = await publicClient.readContract({
      address: config.hoodmarketsV3.factory,
      abi: [
        {
          type: 'function',
          name: 'fractionCollectionForToken',
          stateMutability: 'view',
          inputs: [{ name: '', type: 'address' }],
          outputs: [{ name: '', type: 'address' }],
        },
      ] as const,
      functionName: 'fractionCollectionForToken',
      args: [getAddress(result.tokenAddress)],
    });

    if (!fractionAddress || fractionAddress === '0x0000000000000000000000000000000000000000') {
      throw new Error('Fraction collection not found after deploy.');
    }

    const { recipients, amounts } = buildAirdropLists(petition, orders);
    let airdropTxHash: Hash | undefined;

    if (recipients.length > 0) {
      const totalShares = amounts.reduce((a, b) => a + b, 0n);
      airdropTxHash = await walletClient.writeContract({
        chain: robinhood,
        account,
        address: fractionAddress,
        abi: [
          ...HOODMARKETS_V3_FRACTION_ABI,
          {
            type: 'function',
            name: 'airdropShares',
            stateMutability: 'nonpayable',
            inputs: [
              { name: 'recipients', type: 'address[]' },
              { name: 'amounts', type: 'uint256[]' },
            ],
            outputs: [],
          },
        ] as const,
        functionName: 'airdropShares',
        args: [recipients, amounts],
        gas: 2_000_000n + BigInt(recipients.length) * 80_000n,
      });
      await publicClient.waitForTransactionReceipt({ hash: airdropTxHash });
      logger.info('Community launch airdrop complete', {
        petitionId,
        recipients: recipients.length,
        totalShares: totalShares.toString(),
        raisedWei: raised.toString(),
        devBuyAmount: devBuyAmount.toString(),
        airdropTxHash,
      });
    }

    await markPetitionFinalized(petitionId, {
      tokenAddress: result.tokenAddress,
      deployTxHash: result.transactionHash,
      airdropTxHash,
    });

    return {
      ok: true,
      tokenAddress: result.tokenAddress,
      deployTxHash: result.transactionHash,
      airdropTxHash,
    };
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    logger.error('Community launch finalize failed', { petitionId, error: msg });
    await markPetitionFailed(petitionId, msg);
    await refundBackersAfterFailedFinalize(petitionId);
    return { ok: false, error: msg };
  }
}

export function maybeStartFinalization(
  petitionId: number,
  raisedWei: bigint,
  targetWei: bigint,
): void {
  if (raisedWei < targetWei) return;
  void (async () => {
    const { markPetitionLocked } = await import('./petitionDb.js');
    await markPetitionLocked(petitionId);
    await finalizePetition(petitionId);
  })().catch((e: unknown) => {
    logger.error('Community launch auto-finalize error', {
      petitionId,
      error: e instanceof Error ? e.message : e,
    });
  });
}
