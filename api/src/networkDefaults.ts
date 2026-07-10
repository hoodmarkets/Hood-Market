/**
 * Prefer IPv4 when resolving hostnames. On some cloud hosts (e.g. Railway) IPv6 routes
 * can be broken while AAAA records exist — `fetch()` then fails with a generic "fetch failed"
 * to APIs like Supabase. Safe for this service (HTTPS out to RPCs and SaaS APIs).
 */
import { setDefaultResultOrder } from 'node:dns';

try {
  setDefaultResultOrder('ipv4first');
} catch (e: unknown) {
  const m = e instanceof Error ? e.message : String(e);
  // Logger may not be initialized yet; stderr is picked up by Railway.
  console.warn('[networkDefaults] setDefaultResultOrder skipped:', m);
}
