/**
 * Public URL for the hoodmarkets web app (deploy UI + token catalog).
 * Override for staging via `LAUNCHER_APP_ORIGIN` or `LAUNCHER_WEB_URL`.
 */
export function getLauncherAppOrigin(): string {
  const fromWeb = process.env.LAUNCHER_WEB_URL?.trim();
  if (fromWeb) return fromWeb.replace(/\/$/, '');
  const raw = process.env.LAUNCHER_APP_ORIGIN?.trim();
  if (raw) return raw.replace(/\/$/, '');
  if (process.env.WEB_ONLY_MODE === 'true') return 'https://hood.markets';
  return 'https://llauncher.app';
}

/** Opens the Explore tab with this token highlighted. */
export function launcherAppLaunchesTokenUrl(
  tokenAddress: string,
  opts?: { openSwap?: boolean; side?: 'buy' | 'sell' },
): string {
  const addr = tokenAddress.trim().toLowerCase();
  const url = new URL(`${getLauncherAppOrigin()}/`);
  url.searchParams.set('tab', 'tokens');
  url.searchParams.set('token', addr);
  if (opts?.openSwap) url.searchParams.set('swap', '1');
  if (opts?.side === 'sell') url.searchParams.set('side', 'sell');
  else if (opts?.side === 'buy') url.searchParams.set('side', 'buy');
  return url.toString();
}

/** hoodmarkets token page on the web app. */
export function hoodmarketsTokenUrl(tokenAddress: string): string {
  return launcherAppLaunchesTokenUrl(tokenAddress);
}
