import type { Express, Request, Response } from 'express';
import {
  countExploreTokens,
  listExploreTokens,
  getExplorePlatformStats,
  getTokenMarketStatsByAddress,
  type ExploreFilter,
  type ExploreSort,
} from '../lib/tokenMarketStats.js';
import { hydrateDeploymentCatalogRows } from '../lib/deploymentCatalog.js';
import { enrichDeploymentForPublicApi } from '../lib/deploymentPartyEnrichment.js';
import { webDeployCorsHeadersRead } from '../lib/webDeployCors.js';

function setCors(req: Request, res: Response): void {
  const h = webDeployCorsHeadersRead(req.headers.origin);
  for (const [k, v] of Object.entries(h)) res.setHeader(k, v);
  res.setHeader('Cache-Control', 'public, max-age=15');
}

function parseSort(raw: unknown): ExploreSort {
  const s = String(raw ?? 'mcap').toLowerCase();
  if (s === 'volume') return 'volume';
  if (s === 'launch' || s === 'new') return 'launch';
  if (s === 'lasttrade' || s === 'last_trade') return 'lastTrade';
  return 'mcap';
}

function parseFilter(raw: unknown): ExploreFilter {
  const f = String(raw ?? 'all').toLowerCase();
  if (f === 'live' || f === 'new') return f;
  return 'all';
}

export function registerExploreRoutes(app: Express): void {
  app.options('/api/explore', (req, res) => {
    setCors(req, res);
    res.status(204).end();
  });

  app.options('/api/explore/stats', (req, res) => {
    setCors(req, res);
    res.status(204).end();
  });

  app.options('/api/tokens/:token/market-stats', (req, res) => {
    setCors(req, res);
    res.status(204).end();
  });

  app.get('/api/tokens/:token/market-stats', async (req, res) => {
    setCors(req, res);
    const token = typeof req.params.token === 'string' ? req.params.token.trim() : '';
    if (!/^0x[a-fA-F0-9]{40}$/.test(token)) {
      res.status(400).json({ ok: false, error: 'Invalid token address.' });
      return;
    }
    try {
      const stats = await getTokenMarketStatsByAddress(token);
      if (!stats) {
        res.status(404).json({ ok: false, error: 'No cached market stats for this token yet.' });
        return;
      }
      res.json({ ok: true, stats });
    } catch (e: unknown) {
      res.status(500).json({
        ok: false,
        error: e instanceof Error ? e.message : 'Failed to load market stats.',
      });
    }
  });

  app.get('/api/explore/stats', async (req, res) => {
    setCors(req, res);
    try {
      const stats = await getExplorePlatformStats();
      res.json({ ok: true, stats });
    } catch (e: unknown) {
      res.status(500).json({
        ok: false,
        error: e instanceof Error ? e.message : 'Failed to load explore stats.',
      });
    }
  });

  app.get('/api/explore', async (req, res) => {
    setCors(req, res);
    try {
      const limit = Math.min(100, Math.max(1, Number.parseInt(String(req.query.limit ?? '20'), 10) || 20));
      const offset = Math.max(0, Number.parseInt(String(req.query.offset ?? '0'), 10) || 0);
      const sort = parseSort(req.query.sort);
      const filter = parseFilter(req.query.filter);
      const q = typeof req.query.q === 'string' ? req.query.q : undefined;
      const minLiquidityUsd = Number.parseFloat(String(req.query.minLiquidity ?? '0')) || 0;

      const query = {
        sort,
        filter,
        q,
        limit,
        offset,
        minLiquidityUsd: minLiquidityUsd > 0 ? minLiquidityUsd : undefined,
      };

      const [rows, total] = await Promise.all([
        listExploreTokens(query),
        countExploreTokens(query),
      ]);

      const hydrated = hydrateDeploymentCatalogRows(rows);
      const tokens = await Promise.all(
        hydrated.map(async (row) => {
          const deployment = await enrichDeploymentForPublicApi(row);
          if (!deployment) return null;
          const exploreRow = row as typeof row & {
            volume24hUsd: number;
            mcapUsd: number;
            liquidityUsd: number;
            change24hPct: number | null;
            txnsH24: number;
            priceUsd: number | null;
            dexscreenerUrl: string | null;
            lastTradeAt: string | null;
            statsUpdatedAt: string | null;
          };
          return {
            deployment,
            stats: {
              volume24hUsd: exploreRow.volume24hUsd ?? 0,
              mcapUsd: exploreRow.mcapUsd ?? 0,
              liquidityUsd: exploreRow.liquidityUsd ?? 0,
              change24hPct: exploreRow.change24hPct ?? null,
              txnsH24: exploreRow.txnsH24 ?? 0,
              priceUsd: exploreRow.priceUsd ?? null,
              dexscreenerUrl: exploreRow.dexscreenerUrl ?? null,
              lastTradeAt: exploreRow.lastTradeAt ?? null,
              statsUpdatedAt: exploreRow.statsUpdatedAt ?? null,
            },
          };
        }),
      );

      res.json({
        ok: true,
        total,
        limit,
        offset,
        sort,
        filter,
        tokens: tokens.filter(Boolean),
      });
    } catch (e: unknown) {
      res.status(500).json({
        ok: false,
        error: e instanceof Error ? e.message : 'Failed to load explore feed.',
      });
    }
  });
}
