/**
 * Best-effort extraction of fee-recipient hints from a pasted string (bios, links, @handles).
 */
export interface ParsedRecipientPaste {
  walletAddress?: string;
  farcasterUsername?: string;
  xUsername?: string;
  githubUsername?: string;
  /** @handle or t.me — resolved via Telegram Bot API + Privy */
  telegramUsername?: string;
  /** Numeric Discord user id (from discord.com/users/… ) */
  discordUserId?: string;
}

export function parseRecipientPaste(raw: string): ParsedRecipientPaste {
  const text = raw.trim();
  const out: ParsedRecipientPaste = {};

  const wallet = text.match(/0x[a-fA-F0-9]{40}/);
  if (wallet) {
    out.walletAddress = wallet[0];
  }

  const warpcast = text.match(/warpcast\.com\/(?:~|@)?([^/\s?#]+)/i);
  if (warpcast?.[1]) {
    out.farcasterUsername = warpcast[1].replace(/^@/, '');
  }

  const xUrl = text.match(/(?:twitter\.com|x\.com)\/(?:#!\/)?@?([a-zA-Z0-9_]{1,15})/i);
  if (xUrl?.[1]) {
    out.xUsername = xUrl[1];
  }

  const gh = text.match(/github\.com\/([a-zA-Z0-9](?:[a-zA-Z0-9-]){0,38})(?:\s|$|\/|\?|#)/i);
  if (gh?.[1]) {
    out.githubUsername = gh[1];
  }

  const disc = text.match(/discord\.com\/users\/(\d{10,20})/i);
  if (disc?.[1]) {
    out.discordUserId = disc[1];
  }

  /** Bare Discord snowflake (same id as in discord.com/users/…).
   *  Range: 15–19 digits. 10-digit strings overlap with Unix timestamps and phone numbers;
   *  20-digit strings exceed the current Discord snowflake space. */
  if (
    !out.discordUserId &&
    !out.walletAddress &&
    /^\d{15,19}$/.test(text)
  ) {
    out.discordUserId = text;
  }

  const tme = text.match(/(?:https?:\/\/)?t\.me\/([a-zA-Z][a-zA-Z0-9_]{3,})/i);
  if (tme?.[1]) {
    out.telegramUsername = tme[1];
  }

  const atHandles = text.match(/@([a-zA-Z0-9_]{1,32})/g);
  if (atHandles?.length && !out.walletAddress) {
    const first = atHandles[0].slice(1);
    if (
      !out.farcasterUsername &&
      !out.xUsername &&
      !out.githubUsername &&
      !out.telegramUsername &&
      !out.discordUserId
    ) {
      out.farcasterUsername = first;
    }
  }

  return out;
}
