/**
 * Shared launch economics — starting FDV (tick) and pool seed (dev buy).
 *
 * Legacy tick -230400 implied ~$19–35k FDV at typical ETH prices with only
 * 0.005 ETH (~$15) of WETH liquidity. These defaults target ~$9–12k FDV and
 * healthier liquidity depth (aim for ~10–20% of mcap when users pick presets).
 */

/** ~$9–12k FDV at $2–3k ETH (~50% lower than legacy -230400). */
export const DEFAULT_LAUNCH_TICK = -238400;

/** Platform-paid pool seed when no user/agent ETH is attached (bots, agents). */
export const DEFAULT_DEPLOY_BOND_ETH = '0.05';

/** Web deploy default initial buy (user wallet pays). */
export const WEB_INITIAL_BUY_DEFAULT_ETH = '0.005';

/** Suggested pool seed for healthier starting liquidity (not required). */
export const WEB_INITIAL_BUY_RECOMMENDED_ETH = '0.1';

/** Hard floor for wallet-paid pool seed (lower = thinner starting liquidity). */
export const WEB_INITIAL_BUY_MIN_ETH = '0.005';
export const WEB_INITIAL_BUY_MAX_ETH = '0.5';
export const WEB_INITIAL_BUY_PRESETS_ETH = ['0.1', '0.25', '0.5'] as const;

/** Dynamic (default pro) tick minus static preset tick — preserved from legacy presets. */
export const STATIC_LAUNCH_TICK_OFFSET = 2200;

export const DEFAULT_STATIC_LAUNCH_TICK = DEFAULT_LAUNCH_TICK - STATIC_LAUNCH_TICK_OFFSET;
