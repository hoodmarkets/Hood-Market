/** Telegram Bot API hard limit for `sendMessage` text. */
const TG_HARD_MAX = 4096;

/**
 * Shorten user-facing bot text: RPC errors often embed multi‑KB HTML (e.g. Cloudflare “Just a moment…”),
 * which exceeds Telegram’s limit and yields `400 message is too long`.
 */
export function formatTelegramUserError(detail: string, prefix: string): string {
  let body = (detail ?? '').trim() || 'Unknown error';
  if (
    /__cf_chl|cFPWv|Just a moment|cdn-cgi\/challenge|<!DOCTYPE html>|cf-ray|_cf_chl/i.test(
      body,
    )
  ) {
    body =
      'Ethereum RPC returned a Cloudflare/browser challenge instead of JSON-RPC. ' +
      'Set `ETHEREUM_RPC_URL` (or `ETH_RPC_URL`) on the launcher to Alchemy, Infura, QuickNode, or another server-friendly endpoint.';
  }
  const maxBody = Math.max(200, TG_HARD_MAX - prefix.length);
  if (body.length > maxBody) {
    body = `${body.slice(0, maxBody - 40)}\n…(truncated — see launcher logs for full detail)`;
  }
  return `${prefix}${body}`.slice(0, TG_HARD_MAX);
}
