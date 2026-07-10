import type { Express, Request, Response } from 'express';
import { listDeploymentFeedSince } from '../lib/deploymentCatalog.js';
import { enrichDeploymentForPublicApi } from '../lib/deploymentPartyEnrichment.js';
import { buildDeploymentFeedEvent } from '../lib/deploymentFeedEvent.js';
import { webDeployCorsHeadersRead } from '../lib/webDeployCors.js';

const DEFAULT_POLL_MS = 15_000;

function corsRead(req: Request, res: Response): void {
  const h = webDeployCorsHeadersRead(req.headers.origin);
  for (const [k, v] of Object.entries(h)) res.setHeader(k, v);
}

function parsePositiveInt(raw: unknown, fallback: number, max: number): number {
  const n = typeof raw === 'string' ? Number.parseInt(raw, 10) : Number.NaN;
  if (!Number.isFinite(n) || n < 0) return fallback;
  return Math.min(Math.max(0, Math.floor(n)), max);
}

/**
 * Public incremental feed for Telegram bots, Discord monitors, and other automations.
 *
 * Poll `GET /api/feed/deployments?sinceId=<lastId>` every ~15s.
 * Store `cursor.nextSinceId` from each response and pass it as `sinceId` on the next poll.
 */
export function registerDeploymentFeedRoutes(app: Express): void {
  app.options('/api/feed/deployments', (req, res) => {
    corsRead(req, res);
    res.status(204).end();
  });

  app.get('/api/feed/deployments', async (req: Request, res: Response) => {
    corsRead(req, res);

    const sinceId = parsePositiveInt(req.query.sinceId, 0, Number.MAX_SAFE_INTEGER);
    const limit = parsePositiveInt(req.query.limit, 50, 100);

    try {
      const rows = await listDeploymentFeedSince(sinceId, limit);
      const enriched = await Promise.all(rows.map((row) => enrichDeploymentForPublicApi(row)));
      const events = enriched
        .filter((row): row is NonNullable<typeof row> => row != null)
        .map(buildDeploymentFeedEvent);
      const nextSinceId = events.length > 0 ? events[events.length - 1]!.id : sinceId;

      res.json({
        events,
        cursor: { nextSinceId },
        pollAfterMs: DEFAULT_POLL_MS,
      });
    } catch {
      res.status(500).json({ error: 'Failed to load deployment feed.', events: [] });
    }
  });
}
