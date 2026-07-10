import { RATE_LIMIT_FORCED_PLATFORM_FEE_LABEL } from './webDeployRateLimit.js';

const PLATFORM_FEE_LABEL_MARKERS = [
  'hoodmarkets platform',
  RATE_LIMIT_FORCED_PLATFORM_FEE_LABEL.toLowerCase(),
  'rate limit',
] as const;

export function isHoodmarketsPlatformFeeRecipientLabel(feeRecipientLabel?: string): boolean {
  const label = (feeRecipientLabel ?? '').trim().toLowerCase();
  if (!label) return false;
  return PLATFORM_FEE_LABEL_MARKERS.some((m) => label.includes(m));
}
