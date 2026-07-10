import { formatEther } from 'viem';
import type { PetitionOrderRow, PetitionRow } from './petitionDb.js';
import {
  computeProRataShareAllocations,
  estimateOwnershipPercent,
  PETITION_MAX_CONTRIBUTION_ETH,
  PETITION_MAX_TARGET_RAISE_ETH,
  PETITION_MIN_CONTRIBUTION_ETH,
  PETITION_MIN_TARGET_RAISE_ETH,
  petitionTargetRaiseWei,
  petitionUsesSupporterSlots,
  slotContributionWei,
  sumOrderContributions,
} from './petitionEthGoal.js';
import {
  PETITION_GOAL_UNITS,
  petitionEscrowAddress,
  petitionOpenDurationMs,
  requiredDepositWei,
} from './petitionConfig.js';
import { countActiveSupporters, supporterSlotsRemaining } from './petitionSupporterSlots.js';

export function summarizePetition(
  petition: PetitionRow,
  orders: PetitionOrderRow[],
  appOrigin = 'https://hood.markets',
) {
  const raisedWei = sumOrderContributions(orders);
  const targetWei = petitionTargetRaiseWei(petition);
  const remainingWei = targetWei > raisedWei ? targetWei - raisedWei : 0n;
  const slotMode = petitionUsesSupporterSlots(petition);
  const perSlotWei = slotContributionWei(petition);

  return {
    id: String(petition.id),
    status: petition.status,
    chain: 'robinhood',
    chainId: 4663,
    tokenName: petition.token_name,
    tokenSymbol: petition.token_symbol,
    description: petition.description,
    imageUrl: petition.image_url,
    websiteUrl: petition.website_url,
    tweetUrl: petition.tweet_url,
    starterWallet: petition.starter_wallet,
    goalUnits: petition.goal_units,
    shareSupply: PETITION_GOAL_UNITS,
    targetRaiseEth: formatEther(targetWei),
    targetRaiseWei: targetWei.toString(),
    raisedEth: formatEther(raisedWei),
    raisedWei: raisedWei.toString(),
    remainingEth: formatEther(remainingWei),
    remainingWei: remainingWei.toString(),
    raiseProgressPct:
      targetWei > 0n ? Math.min(100, Number((raisedWei * 10000n) / targetWei) / 100) : 0,
    soldUnits: 0,
    publicCap: 0,
    remainingUnits: 0,
    maxUnitsPerWallet: petition.max_units_per_wallet,
    supporterSlots: petition.supporter_slots,
    unitsPerSupporter: petition.units_per_supporter,
    contributionPerSlotEth: perSlotWei ? formatEther(perSlotWei) : null,
    contributionPerSlotWei: perSlotWei?.toString() ?? null,
    hoodClaimOptIn: petition.hood_claim_opt_in === 1,
    createdAt: petition.created_at,
    expiresAt: petition.expires_at,
    openDurationMs: petitionOpenDurationMs(),
    escrowWallet: petitionEscrowAddress(),
    shareUrl: `${appOrigin.replace(/\/$/, '')}/community-launch?id=${petition.id}`,
    tokenAddress: petition.token_address || null,
    deployTxHash: petition.deploy_tx_hash || null,
    airdropTxHash: petition.airdrop_tx_hash || null,
    finalError: petition.final_error || null,
    agentParticipation: {
      maxUnitsPerWallet: petition.max_units_per_wallet,
      remainingWei: remainingWei.toString(),
      fixedUnitsPerWallet: slotMode,
      supportersJoined: slotMode ? countActiveSupporters(orders) : null,
      supportersRemaining: slotMode ? supporterSlotsRemaining(petition, orders) : null,
    },
    orders: orders.map((o) => {
      const contributionWei = BigInt(o.deposit_wei || '0');
      const alloc = computeProRataShareAllocations(petition, [o])[0];
      return {
        wallet: o.wallet,
        contributionEth: formatEther(contributionWei),
        contributionWei: o.deposit_wei,
        estimatedShares: alloc ? Number(alloc.shares) : 0,
        ownershipPct: estimateOwnershipPercent(
          contributionWei,
          raisedWei > 0n ? raisedWei : targetWei,
        ),
        units: o.units,
        launchBuyWei: o.launch_buy_wei,
        depositWei: o.deposit_wei,
        depositTxHash: o.deposit_tx_hash,
        status: o.status,
        createdAt: o.created_at,
      };
    }),
    finalResult:
      petition.status === 'finalized' && petition.token_address
        ? {
            tokenAddress: petition.token_address,
            deployTxHash: petition.deploy_tx_hash,
            airdropTxHash: petition.airdrop_tx_hash,
            initialBuyEth: formatEther(raisedWei),
          }
        : null,
  };
}

export function petitionConfigPayload() {
  return {
    enabled: Boolean(petitionEscrowAddress()),
    chain: 'robinhood',
    chainId: 4663,
    openDurationHours: petitionOpenDurationMs() / (60 * 60 * 1000),
    shareSupply: PETITION_GOAL_UNITS,
    minTargetRaiseEth: formatEther(PETITION_MIN_TARGET_RAISE_ETH),
    maxTargetRaiseEth: formatEther(PETITION_MAX_TARGET_RAISE_ETH),
    minContributionEth: formatEther(PETITION_MIN_CONTRIBUTION_ETH),
    maxContributionEth: formatEther(PETITION_MAX_CONTRIBUTION_ETH),
    robinhood: {
      enabled: Boolean(petitionEscrowAddress()),
      escrowWallet: petitionEscrowAddress(),
      minTargetRaiseEth: formatEther(PETITION_MIN_TARGET_RAISE_ETH),
      maxTargetRaiseEth: formatEther(PETITION_MAX_TARGET_RAISE_ETH),
      minContributionEth: formatEther(PETITION_MIN_CONTRIBUTION_ETH),
      maxContributionEth: formatEther(PETITION_MAX_CONTRIBUTION_ETH),
    },
    supporterSlots: {
      description:
        'Optional: split the raise into N equal ETH slots (e.g. 5 ETH / 20 slots = 0.25 ETH each).',
      examples: [
        { targetRaiseEth: '5', supporterSlots: 20, contributionPerSlotEth: '0.25' },
        { targetRaiseEth: '1', supporterSlots: 10, contributionPerSlotEth: '0.1' },
      ],
    },
  };
}

export function buildPrepareDepositNextStep(contributionWei: bigint) {
  const escrow = petitionEscrowAddress();
  if (!escrow) throw new Error('Petition escrow is not configured.');
  const totalWei = requiredDepositWei(contributionWei);
  return {
    chainId: 4663,
    to: escrow,
    value: totalWei.toString(),
    data: '0x',
  };
}
