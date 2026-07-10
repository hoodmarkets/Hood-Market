import type { Express, Request, Response, NextFunction } from 'express';
import { config } from '../config.js';

/** Canonical origin for comparisons (handles trailing slashes / spacing in env). */
function normalizeOrigin(origin: string): string {
  try {
    return new URL(origin.trim()).origin;
  } catch {
    return origin.trim();
  }
}

const explicitAllowedOrigins = new Set(
  config.webDeployCorsOrigins.map((o) => normalizeOrigin(o)).filter(Boolean),
);

/**
 * Lovable-hosted origins (https only): *.lovable.app, *.lovable.dev, *.lovableproject.com
 * (matches common Privy “Allowed domains” entries).
 */
export function isLovableHostedOrigin(origin: string): boolean {
  try {
    const u = new URL(origin);
    if (u.protocol !== 'https:') return false;
    const h = u.hostname.toLowerCase();
    if (h === 'lovable.app' || h.endsWith('.lovable.app') || h.endsWith('.lovable.dev')) {
      return true;
    }
    if (h.endsWith('.lovableproject.com')) return true;
    return false;
  } catch {
    return false;
  }
}

/** Vercel preview/production hostnames: https://*.vercel.app */
export function isVercelHostedOrigin(origin: string): boolean {
  try {
    const u = new URL(origin);
    if (u.protocol !== 'https:') return false;
    const h = u.hostname.toLowerCase();
    return h === 'vercel.app' || h.endsWith('.vercel.app');
  } catch {
    return false;
  }
}

export function isWebDeployOriginAllowed(origin: string | undefined): boolean {
  if (!origin) return false;
  if (explicitAllowedOrigins.has(normalizeOrigin(origin))) return true;
  if (config.webDeployCorsAllowLovable && isLovableHostedOrigin(origin)) return true;
  if (config.webDeployCorsAllowVercel && isVercelHostedOrigin(origin)) return true;
  return false;
}

const CORS_ALLOW_HEADERS =
  'Authorization, Content-Type, X-Agent-Captcha-JWT, X-Bankr-Api-Key';

/** CORS for POST /api/deploy, /api/deploy-preview, and /api/resolve-source from allowed browser origins. */
export function webDeployCorsHeaders(origin: string | undefined): Record<string, string> {
  if (!origin || !isWebDeployOriginAllowed(origin)) return {};
  return {
    'Access-Control-Allow-Origin': origin,
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Access-Control-Allow-Headers': CORS_ALLOW_HEADERS,
    Vary: 'Origin',
  };
}

/** CORS for GET /api/deployments (public catalog) and profile read/unlink from allowed browser origins. */
export function webDeployCorsHeadersRead(origin: string | undefined): Record<string, string> {
  if (!origin || !isWebDeployOriginAllowed(origin)) return {};
  return {
    'Access-Control-Allow-Origin': origin,
    'Access-Control-Allow-Methods': 'GET, POST, PATCH, DELETE, OPTIONS',
    'Access-Control-Allow-Headers': CORS_ALLOW_HEADERS,
    Vary: 'Origin',
  };
}

/** CORS for GET /api/swap/0x/* (browser reads quotes through launcher API). */
export function webDeployCorsHeadersSwap0x(origin: string | undefined): Record<string, string> {
  if (!origin || !isWebDeployOriginAllowed(origin)) return {};
  return {
    'Access-Control-Allow-Origin': origin,
    'Access-Control-Allow-Methods': 'GET, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
    Vary: 'Origin',
  };
}

/** Combined CORS headers for any /api/* route (GET + POST + PATCH + DELETE + preflight). */
function webDeployCorsHeadersAll(origin: string | undefined): Record<string, string> {
  if (!origin || !isWebDeployOriginAllowed(origin)) return {};
  return {
    'Access-Control-Allow-Origin': origin,
    'Access-Control-Allow-Methods': 'GET, POST, PATCH, DELETE, OPTIONS',
    'Access-Control-Allow-Headers': CORS_ALLOW_HEADERS,
    Vary: 'Origin',
  };
}

function applyCorsHeaders(res: Response, headers: Record<string, string>): void {
  for (const [key, value] of Object.entries(headers)) {
    res.setHeader(key, value);
  }
}

/** Global middleware: CORS on all /api/* responses and OPTIONS preflight. */
export function registerWebDeployCorsMiddleware(app: Express): void {
  app.use((req: Request, res: Response, next: NextFunction) => {
    if (!req.path.startsWith('/api/')) {
      next();
      return;
    }

    const origin = req.headers.origin;
    const corsHeaders =
      req.path.startsWith('/api/swap/0x/')
        ? webDeployCorsHeadersSwap0x(origin)
        : webDeployCorsHeadersAll(origin);
    applyCorsHeaders(res, corsHeaders);

    if (req.method === 'OPTIONS') {
      res.status(204).end();
      return;
    }

    next();
  });
}
