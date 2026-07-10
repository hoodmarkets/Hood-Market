import { parseEther } from 'viem';
import { HOOD_CLAIM_RESERVE_UNITS, PETITION_GOAL_UNITS } from './petitionConfig.js';
import type { PetitionOrderRow, PetitionRow } from './petitionDb.js';

export const PETITION_MIN_TARGET_RAISE_ETH = parseEther('0.1');
export const PETITION_MAX_TARGET_RAISE_ETH = parseEther('50');
export const PETITION_MIN_CONTRIBUTION_ETH = parseEther('0.001');
export const PETITION_MAX_CONTRIBUTION_ETH = parseEther('10');

export function parseTargetRaiseWei(raw: unknown): bigint | null {
  const trimmed = String(raw ?? '').trim();
  if (!trimmed) return null;
  try {
    const wei = parseEther(trimmed);
    if (wei < PETITION_MIN_TARGET_RAISE_ETH || wei > PETITION_MAX_TARGET_RAISE_ETH) return null;
    return wei;
  } catch {
    return null;
  }
}

export function parseContributionWei(raw: unknown): bigint | null {
  const trimmed = String(raw ?? '').trim();
  if (!trimmed) return null;
  try {
    const wei = parseEther(trimmed);
    if (wei < PETITION_MIN_CONTRIBUTION_ETH || wei > PETITION_MAX_CONTRIBUTION_ETH) return null;
    return wei;
  } catch {
    return null;
  }
}

export function petitionTargetRaiseWei(petition: PetitionRow): bigint {
  const raw = String(petition.target_raise_wei ?? '0').trim();
  if (!raw || raw === '0') return 0n;
  try {
    return BigInt(raw);
  } catch {
    return 0n;
  }
}

export function sumOrderContributions(orders: PetitionOrderRow[]): bigint {
  return orders
    .filter((o) => o.status === 'active')
    .reduce((sum, o) => sum + BigInt(o.deposit_wei || '0'), 0n);
}

export function slotContributionWei(petition: PetitionRow): bigint | null {
  const slots = Number(petition.supporter_slots ?? 0);
  const target = petitionTargetRaiseWei(petition);
  if (slots < 1 || target <= 0n) return null;
  if (target % BigInt(slots) !== 0n) return null;
  return target / BigInt(slots);
}

export function petitionUsesSupporterSlots(petition: PetitionRow): boolean {
  return Number(petition.supporter_slots ?? 0) > 0;
}

export function totalAirdropShares(petition: PetitionRow): bigint {
  const hood = petition.hood_claim_opt_in === 1;
  return BigInt(hood ? PETITION_GOAL_UNITS - HOOD_CLAIM_RESERVE_UNITS : PETITION_GOAL_UNITS);
}

/** Pro-rata Holder NFT shares from ETH contributed (sums to totalAirdropShares). */
export function computeProRataShareAllocations(
  petition: PetitionRow,
  orders: PetitionOrderRow[],
): { wallet: string; shares: bigint; contributionWei: bigint }[] {
  const active = orders.filter((o) => o.status === 'active' && BigInt(o.deposit_wei || '0') > 0n);
  const totalRaised = sumOrderContributions(active);
  if (totalRaised <= 0n) return [];

  const totalShares = totalAirdropShares(petition);
  const allocations = active.map((o) => {
    const contributionWei = BigInt(o.deposit_wei);
    const shares = (totalShares * contributionWei) / totalRaised;
    return { wallet: o.wallet, shares, contributionWei };
  });

  let assigned = allocations.reduce((s, a) => s + a.shares, 0n);
  let remainder = totalShares - assigned;
  if (remainder > 0n && allocations.length > 0) {
    const sorted = [...allocations].sort((a, b) => {
      const diff = b.contributionWei - a.contributionWei;
      return diff > 0n ? 1 : diff < 0n ? -1 : 0;
    });
    sorted[0].shares += remainder;
    remainder = 0n;
    for (const alloc of allocations) {
      const match = sorted.find((s) => s.wallet === alloc.wallet);
      if (match) alloc.shares = match.shares;
    }
  }

  return allocations.filter((a) => a.shares > 0n);
}

export function estimateOwnershipPercent(contributionWei: bigint, basisWei: bigint): number {
  if (basisWei <= 0n || contributionWei <= 0n) return 0;
  return Number((contributionWei * 10000n) / basisWei) / 100;
}

export function validateEthContribution(
  petition: PetitionRow,
  orders: PetitionOrderRow[],
  contributionWei: bigint,
  raisedWei: bigint,
): string | null {
  const target = petitionTargetRaiseWei(petition);
  if (target <= 0n) return 'Community launch has no raise target.';

  const remaining = target > raisedWei ? target - raisedWei : 0n;
  if (remaining <= 0n) return 'Raise goal is already met.';

  const perSlot = slotContributionWei(petition);
  if (perSlot != null) {
    if (contributionWei !== perSlot) {
      return `This launch uses fixed slots — contribute exactly ${Number(perSlot) / 1e18} ETH.`;
    }
    const slots = Number(petition.supporter_slots ?? 0);
    const backers = orders.filter((o) => o.status === 'active' && BigInt(o.deposit_wei || '0') > 0n).length;
    if (backers >= slots) return `All ${slots} supporter slots are filled.`;
    return null;
  }

  if (contributionWei > remaining) {
    return `Only ${Number(remaining) / 1e18} ETH remaining toward the ${Number(target) / 1e18} ETH goal.`;
  }
  return null;
}

export type EthRaiseCreateInput = {
  targetRaiseEth: unknown;
  supporterSlots?: unknown;
  hoodClaimOptIn?: boolean;
};

export function resolveEthRaiseCreate(input: EthRaiseCreateInput):
  | { ok: true; targetRaiseWei: bigint; supporterSlots?: number }
  | { ok: false; error: string } {
  const targetRaiseWei = parseTargetRaiseWei(input.targetRaiseEth);
  if (!targetRaiseWei) {
    return {
      ok: false,
      error: `targetRaiseEth must be between ${Number(PETITION_MIN_TARGET_RAISE_ETH) / 1e18} and ${Number(PETITION_MAX_TARGET_RAISE_ETH) / 1e18} ETH.`,
    };
  }

  const slotsRaw = String(input.supporterSlots ?? '').trim();
  if (slotsRaw) {
    const slots = Number.parseInt(slotsRaw, 10);
    if (!Number.isFinite(slots) || slots < 2 || slots > 500) {
      return { ok: false, error: 'supporterSlots must be between 2 and 500.' };
    }
    if (targetRaiseWei % BigInt(slots) !== 0n) {
      return {
        ok: false,
        error: `Raise target must divide evenly across ${slots} slots (e.g. 5 ETH / 20 = 0.25 ETH each).`,
      };
    }
    const perSlot = targetRaiseWei / BigInt(slots);
    if (perSlot < PETITION_MIN_CONTRIBUTION_ETH) {
      return { ok: false, error: 'Each slot would be below the minimum contribution.' };
    }
    return { ok: true, targetRaiseWei, supporterSlots: slots };
  }

  return { ok: true, targetRaiseWei };
}
