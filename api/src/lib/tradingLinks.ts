/**
 * Telegram bot deep links + DexScreener for Robinhood Chain tokens.
 */

function tokenLowerHex(address: string): string {
  const t = address.trim();
  if (/^0x[a-fA-F0-9]{40}$/.test(t)) return t.toLowerCase();
  return t;
}

export function telegramTradeLinks(tokenAddress: string): {
  dexscreener: string;
  uniswap: string;
  hoodmarkets: string;
  /** @deprecated Base-era bots — prefer hoodmarkets / uniswap */
  gmgn: string;
  sigma: string;
  basebot: string;
} {
  const a = tokenLowerHex(tokenAddress);
  return {
    dexscreener: `https://dexscreener.com/robinhood/${a}`,
    uniswap: `https://app.uniswap.org/swap?chain=robinhood&outputCurrency=${tokenAddress.trim()}`,
    hoodmarkets: `https://hood.markets/?token=${a}`,
    gmgn: `https://t.me/GMGN_swap_bot?start=i_infobot_c_${a}`,
    sigma: `https://t.me/Sigma_buyBot?start=xinfo-${a}`,
    basebot: `https://t.me/based_eth_bot?start=r_infobot_b_${a}`,
  };
}
