export function parsePetitionIdFromInput(raw: string | undefined): number | null {
  const trimmed = String(raw ?? '').trim();
  if (!trimmed) return null;

  if (/^\d+$/.test(trimmed)) {
    const n = Number.parseInt(trimmed, 10);
    return Number.isFinite(n) && n > 0 ? n : null;
  }

  try {
    const url = trimmed.startsWith('http') ? new URL(trimmed) : new URL(trimmed, 'https://hood.markets');
    const idParam = url.searchParams.get('id');
    if (idParam && /^\d+$/.test(idParam)) return Number.parseInt(idParam, 10);
    const match = url.pathname.match(/\/community-launch\/(\d+)/i);
    if (match) return Number.parseInt(match[1], 10);
  } catch {
    /* ignore */
  }

  const hashMatch = trimmed.match(/#(\d+)/);
  if (hashMatch) return Number.parseInt(hashMatch[1], 10);

  return null;
}
