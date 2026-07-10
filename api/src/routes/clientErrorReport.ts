import type { Express, Request, Response } from 'express';
import { debugError } from '../lib/discordDebug.js';
import { logger } from '../logger.js';
import { webDeployCorsHeaders } from '../lib/webDeployCors.js';

function clip(raw: unknown, max: number): string {
  if (typeof raw !== 'string') return '';
  return raw.trim().slice(0, max);
}

/**
 * Best-effort client error reporting for troubleshooting (Discord debug channel when configured).
 * Does not expose secrets; rate-limited lightly by rejecting oversized payloads.
 */
export function registerClientErrorReportRoutes(app: Express): void {
  app.options('/api/report-client-error', (req, res) => {
    const h = webDeployCorsHeaders(req.headers.origin);
    for (const [k, v] of Object.entries(h)) res.setHeader(k, v);
    res.status(204).end();
  });

  app.post('/api/report-client-error', async (req: Request, res: Response) => {
    const h = webDeployCorsHeaders(req.headers.origin);
    for (const [k, v] of Object.entries(h)) res.setHeader(k, v);

    const surface = clip(req.body?.surface, 80) || 'web';
    const message = clip(req.body?.message, 4000);
    const stack = clip(req.body?.stack, 8000);
    const contextRaw = req.body?.context;

    if (!message) {
      res.status(400).json({ error: 'message is required' });
      return;
    }

    const context: Record<string, string> = {};
    if (contextRaw && typeof contextRaw === 'object' && !Array.isArray(contextRaw)) {
      for (const [k, v] of Object.entries(contextRaw as Record<string, unknown>)) {
        if (typeof v === 'string' && Object.keys(context).length < 12) {
          context[k.slice(0, 40)] = v.slice(0, 500);
        }
      }
    }
    if (stack) context.stack = stack;

    logger.warn('Client error report', { surface, message: message.slice(0, 300) });

    try {
      await debugError(`Web: ${surface}`, message, context);
    } catch {
      /* discord optional */
    }

    res.json({ ok: true });
  });
}
