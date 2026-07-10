/** Normalize token display name for blocklist lookup (lowercase, collapsed spaces). */
export function normalizeTokenNameForBlocklist(name: string): string {
  return name.trim().toLowerCase().replace(/\s+/g, ' ');
}

/** Letters+digits only — catches "hood.markets" vs "hoodmarkets". */
export function compactTokenNameForBlocklist(name: string): string {
  return normalizeTokenNameForBlocklist(name).replace(/[^a-z0-9]/g, '');
}

export function addNameBlocklistEntries(set: Set<string>, raw: string): void {
  const n = normalizeTokenNameForBlocklist(raw);
  if (n.length >= 2) set.add(n);
  const c = compactTokenNameForBlocklist(raw);
  if (c.length >= 2) set.add(c);
}
