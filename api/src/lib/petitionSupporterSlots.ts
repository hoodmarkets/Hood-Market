import { HOOD_CLAIM_RESERVE_UNITS, PETITION_GOAL_UNITS } from './petitionConfig.js';

const DEFAULT_GOAL = PETITION_GOAL_UNITS;

export function divisorsUpTo(n: number): number[] {
  const cap = Math.floor(Number(n));
  if (!Number.isFinite(cap) || cap < 1) return [];
  const out: number[] = [];
  for (let d = 1; d <= cap; d += 1) {
    if (cap % d === 0) out.push(d);
  }
  return out;
}

export function petitionPublicSaleUnits(petition: {
  goalUnits?: number;
  goal_units?: number;
  hoodClaimOptIn?: boolean | number;
  hood_claim_opt_in?: number;
}): number {
  const goal = petition.goalUnits ?? petition.goal_units ?? DEFAULT_GOAL;
  const hood =
    petition.hoodClaimOptIn === true ||
    petition.hoodClaimOptIn === 1 ||
    petition.hood_claim_opt_in === 1;
  return hood ? goal - HOOD_CLAIM_RESERVE_UNITS : goal;
}

export function parseSupporterSlots(raw: unknown): number | null {
  const trimmed = String(raw ?? '').trim();
  if (!trimmed) return null;
  const n = Number.parseInt(trimmed, 10);
  if (!Number.isFinite(n) || n < 1) return null;
  return Math.min(DEFAULT_GOAL, n);
}

export type PetitionAllocation =
  | {
      ok: true;
      maxUnitsPerWallet: number;
      supporterSlots?: number;
      unitsPerSupporter?: number;
      fixedUnitsPerWallet: boolean;
    }
  | {
      ok: false;
      error: string;
      publicCap: number;
      hoodClaimOptIn: boolean;
      validSupporterSlots: number[];
    };

export function resolvePetitionAllocation(input: {
  hoodClaimOptIn?: boolean;
  supporterSlots?: unknown;
  maxSupporters?: unknown;
  maxUnitsPerWallet?: unknown;
}): PetitionAllocation {
  const goalUnits = DEFAULT_GOAL;
  const hoodClaimOptIn = input.hoodClaimOptIn === true;
  const publicCap = hoodClaimOptIn ? goalUnits - HOOD_CLAIM_RESERVE_UNITS : goalUnits;
  const validSupporterSlots = divisorsUpTo(publicCap);

  const supporterSlots = parseSupporterSlots(input.supporterSlots ?? input.maxSupporters);
  if (supporterSlots != null) {
    if (publicCap % supporterSlots !== 0) {
      return {
        ok: false,
        error: `supporterSlots must divide public cap evenly (${publicCap} units${hoodClaimOptIn ? ' with hood claim opt-in' : ''}).`,
        publicCap,
        hoodClaimOptIn,
        validSupporterSlots,
      };
    }
    const unitsPerSupporter = publicCap / supporterSlots;
    return {
      ok: true,
      maxUnitsPerWallet: unitsPerSupporter,
      supporterSlots,
      unitsPerSupporter,
      fixedUnitsPerWallet: true,
    };
  }

  const maxRaw = input.maxUnitsPerWallet;
  const maxUnitsPerWallet =
    maxRaw != null && String(maxRaw).trim() !== ''
      ? Math.min(1000, Math.max(1, Number.parseInt(String(maxRaw), 10) || 10))
      : 10;
  return { ok: true, maxUnitsPerWallet, fixedUnitsPerWallet: false };
}

export function petitionUsesSupporterSlots(petition: {
  supporterSlots?: number | null;
  unitsPerSupporter?: number | null;
  supporter_slots?: number | null;
  units_per_supporter?: number | null;
}): boolean {
  const slots = petition.supporterSlots ?? petition.supporter_slots;
  const units = petition.unitsPerSupporter ?? petition.units_per_supporter;
  return Number(slots) > 0 && Number(units) > 0;
}

export function countActiveSupporters(
  orders: { status: string; units: number; deposit_wei?: string }[],
): number {
  return orders.filter(
    (o) => o.status === 'active' && (BigInt(o.deposit_wei || '0') > 0n || Number(o.units) > 0),
  ).length;
}

export function supporterSlotsRemaining(
  petition: { supporterSlots?: number | null; supporter_slots?: number | null },
  orders: { status: string; units: number }[],
): number | null {
  const slots = Number(petition.supporterSlots ?? petition.supporter_slots ?? 0);
  if (slots <= 0) return null;
  return Math.max(0, slots - countActiveSupporters(orders));
}

export function validateSupporterSlotDeposit(
  petition: {
    supporterSlots?: number | null;
    unitsPerSupporter?: number | null;
    supporter_slots?: number | null;
    units_per_supporter?: number | null;
  },
  orders: { status: string; units: number }[],
  units: number,
): string | null {
  if (!petitionUsesSupporterSlots(petition)) return null;
  const required = Number(petition.unitsPerSupporter ?? petition.units_per_supporter);
  const slots = petition.supporterSlots ?? petition.supporter_slots;
  if (Number(units) !== required) {
    return `This petition requires exactly ${required} units per supporter (${slots} slots total).`;
  }
  if ((supporterSlotsRemaining(petition, orders) ?? 0) <= 0) {
    return `All ${slots} supporter slots are filled.`;
  }
  return null;
}
