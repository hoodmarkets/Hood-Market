import { BaseError } from 'viem';

/**
 * Turn RPC / viem / SDK failures into a single string for API responses and Discord.
 * Viem often puts the useful text in `shortMessage` / `details` while `message` is generic.
 */
export function formatDeployError(err: unknown): string {
  if (err == null) return 'Unknown error (null)';
  if (typeof err === 'string') return err;

  if (err instanceof BaseError) {
    const parts: string[] = [];
    const short = err.shortMessage?.trim();
    const long = err.message?.trim();
    if (short && short !== long) parts.push(short);
    else if (long) parts.push(long);
    if (err.details?.trim()) parts.push(err.details.trim());
    if (err.metaMessages?.length) {
      for (const m of err.metaMessages) {
        const t = m.trim();
        if (t) parts.push(t);
      }
    }
    try {
      const leaf = err.walk();
      if (leaf instanceof BaseError && leaf !== err) {
        const w = leaf.shortMessage?.trim() || leaf.message?.trim();
        if (w && !parts.some((p) => p.includes(w))) parts.push(`Cause: ${w}`);
      }
    } catch {
      /* ignore walk failures */
    }
    const joined = parts.filter(Boolean).join(' — ');
    return joined || long || 'Unknown viem error';
  }

  if (err instanceof Error) {
    /** Clanker SDK wraps viem failures in `Error` with `.data` + nested `.error` (message is often "Something went wrong"). */
    const ext = err as Error & {
      error?: unknown;
      data?: { label?: string; rawName?: string; type?: string };
    };
    if (
      ext.data &&
      typeof ext.data === 'object' &&
      (ext.data.label != null || ext.data.rawName != null || ext.error != null)
    ) {
      const bits: string[] = [];
      if (ext.data.label?.trim()) bits.push(ext.data.label.trim());
      if (ext.data.rawName?.trim()) bits.push(`(${ext.data.rawName.trim()})`);
      if (ext.data.type?.trim()) bits.push(`[${ext.data.type.trim()}]`);
      let s = bits.join(' ');
      if (ext.error != null) {
        s += (s ? ' — ' : '') + formatDeployError(ext.error);
      } else if (err.cause != null) {
        s += (s ? ' — ' : '') + formatDeployError(err.cause);
      }
      if (s.trim()) return s.trim();
    }

    let m = err.message?.trim() || 'Error';
    const c = err.cause;
    if (c instanceof Error && c.message?.trim()) {
      m += ` — ${c.message.trim()}`;
    } else if (typeof c === 'string' && c.trim()) {
      m += ` — ${c.trim()}`;
    }
    return m;
  }

  try {
    return JSON.stringify(err);
  } catch {
    return String(err);
  }
}
