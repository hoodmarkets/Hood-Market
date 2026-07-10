import { BASE_DEAD_FEE_RECIPIENT } from './deadFeeWallet.js';

/** Catalog / UI label — matches web `no_dev` deploys. */
export const MEME_FEE_RECIPIENT_LABEL = 'No Dev (meme)';

/** X: user asked for self-wallet fees but hit the Eastern daily cap — we still deploy; fees go to burn. */
export const X_FORCED_DEAD_FEE_LABEL =
  'No Dev (meme) — daily wallet-fee limit; fees routed to burn';

/** Deploy exceeded rolling 24h-style rate limit; fees routed to burn (same address as No Dev). */
export const RATE_LIMIT_FORCED_DEAD_FEE_LABEL =
  'No Dev (meme) — deploy rate limit; fees routed to burn';

/** Shown before deploy when `applyDeployRateLimitBurn` would route fees to burn (all surfaces). */
export const DEPLOY_LIMIT_MEME_PROCEED_USER_NOTICE =
  'You have reached a deploy limit (daily cap or rate limit). If you proceed, this coin will be treated as a No Dev (meme) token — trading fees go to the burn/dead wallet.';

/** Appended to on-chain token `description` for meme / No Dev (burn) fee recipients. */
export const MEME_TOKEN_DESCRIPTION_TAGLINE =
  'real shit meme shit, no dev , no fees.';

export function memeFeeWalletAndLabel(): {
  walletAddress: string;
  feeRecipientLabel: string;
} {
  return {
    walletAddress: BASE_DEAD_FEE_RECIPIENT,
    feeRecipientLabel: MEME_FEE_RECIPIENT_LABEL,
  };
}

/** Burn / No Dev / rate limits — not “fees to your wallet” for catalog `fee_to_self`. */
export function isNoDevOrForcedBurnFeeLabel(label: string | undefined): boolean {
  if (!label) return false;
  if (label === MEME_FEE_RECIPIENT_LABEL) return true;
  if (label === X_FORCED_DEAD_FEE_LABEL) return true;
  if (label === RATE_LIMIT_FORCED_DEAD_FEE_LABEL) return true;
  return false;
}

/**
 * Discord / Telegram explicit fee option: short tokens like `meme`, `meme?`, `no dev`.
 * Avoid matching arbitrary prose — used for slash options and wizard replies.
 */
export function matchesMemeFeeRecipientToken(raw: string): boolean {
  const t = raw.trim().toLowerCase();
  if (!t) return false;
  const squish = t.replace(/[\s?]+/g, '');
  if (squish === 'meme' || squish === 'nodev' || squish === 'nodev?') return true;
  if (t === 'no dev' || t === 'no-dev' || t === 'no dev?' || t === 'meme?' || t === 'meme') return true;
  if (t === 'fees to no one' || t === 'fees to nobody' || t === 'fee to no one') return true;
  if (t === 'burn' || t === 'dead' || t === 'dead wallet') return true;
  return false;
}

/**
 * X / Farcaster public text: user can mention meme / no dev / fees to no one anywhere in the message.
 */
export function textIndicatesMemeNoDevFee(text: string): boolean {
  if (matchesMemeFeeRecipientToken(text)) return true;
  const lower = text.toLowerCase();
  if (/\bno[\s_-]*dev\b/.test(lower)) return true;
  if (/\bmeme\??\b/.test(lower)) return true;
  if (/fees?\s+to\s+no\s+(one|body)\b/.test(lower)) return true;
  if (/fees?\s+to\s+(the\s+)?(burn|dead)\b/.test(lower)) return true;
  if (/\bno\s+one\s+(gets\s+)?(the\s+)?fees?\b/.test(lower)) return true;
  if (/\bunclaimable\s+fees?\b/.test(lower)) return true;
  return false;
}
