/** US Eastern — daily reset for X self-wallet fee limit (handles EST/EDT). */
const TZ = 'America/New_York';

export function easternCalendarYmd(now: Date = new Date()): string {
  return now.toLocaleDateString('en-CA', { timeZone: TZ });
}

/**
 * First UTC instant on Eastern calendar day `ymd` (YYYY-MM-DD in America/New_York).
 */
export function startOfEasternDayUtc(ymd: string): Date {
  const [y, m, d] = ymd.split('-').map(Number);
  let lo = Date.UTC(y, m - 1, d - 2, 0, 0, 0);
  let hi = Date.UTC(y, m - 1, d + 2, 12, 0, 0);
  while (hi - lo > 1) {
    const mid = Math.floor((lo + hi) / 2);
    const midYmd = new Date(mid).toLocaleDateString('en-CA', { timeZone: TZ });
    if (midYmd < ymd) lo = mid;
    else hi = mid;
  }
  return new Date(hi);
}

/** [start, end) UTC range for the current Eastern calendar day. */
export function getEasternDayRangeUtc(now: Date = new Date()): { start: Date; end: Date } {
  const ymd = easternCalendarYmd(now);
  const start = startOfEasternDayUtc(ymd);
  const probe = new Date(start.getTime() + 25 * 3600 * 1000);
  const nextYmd = probe.toLocaleDateString('en-CA', { timeZone: TZ });
  const end = startOfEasternDayUtc(nextYmd);
  return { start, end };
}

/** SQLite-friendly UTC timestamp `YYYY-MM-DD HH:MM:SS` for comparisons with `created_at`. */
export function toSqliteUtc(d: Date): string {
  return d.toISOString().slice(0, 19).replace('T', ' ');
}
