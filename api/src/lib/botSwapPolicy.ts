import { type Address } from 'viem';
import { config } from '../config.js';

/** Canonical lowercase allowlist merge: defaults ⊎ env `BOT_SWAP_ROUTER_ALLOWLIST`. */
export function getBotSwapRouterAllowlist(): Set<string> {
  return config.botSwap.routerAllowlist;
}

/**
 * Reject plain ETH transfers (no calldata) and any `to` not in the router allowlist.
 * Swap txs must target known 0x / Odos / Paraswap (Velora) routers on Base.
 */
export function assertBotSwapTransactionAllowed(input: {
  to: Address;
  data: `0x${string}`;
  value: bigint;
}): { ok: true } | { ok: false; reason: string } {
  const allowed = getBotSwapRouterAllowlist();
  const toLc = input.to.toLowerCase();

  if (!allowed.has(toLc)) {
    return {
      ok: false,
      reason: `Transaction target ${input.to} is not in the approved router allowlist (0x / Odos / Paraswap on Base).`,
    };
  }

  const data = input.data;
  const bare =
    !data ||
    data === '0x' ||
    (typeof data === 'string' && data.length <= 2);
  if (bare && input.value > 0n) {
    return {
      ok: false,
      reason: 'Rejected plain ETH transfer (no contract calldata). Only approved aggregator swaps are allowed.',
    };
  }

  if (bare) {
    return {
      ok: false,
      reason: 'Missing swap calldata.',
    };
  }

  return { ok: true };
}

/** Max ETH notional for a *buy* (sell ETH → token), compared to configured cap. */
export function assertBuyEthWithinCap(sellEthWei: bigint): { ok: true } | { ok: false; reason: string } {
  if (sellEthWei > config.botSwap.maxSellEthWei) {
    return {
      ok: false,
      reason: `Sell amount exceeds server cap (${config.botSwap.maxSellEthHuman} ETH).`,
    };
  }
  return { ok: true };
}
