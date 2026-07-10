import type { Express, Request, Response } from 'express';
import { getAddress } from 'viem';
import { webDeployCorsHeadersRead } from '../lib/webDeployCors.js';
import {
  enrichGrant,
  fetchVestingByRecipient,
  fetchVestingByToken,
  getProofOfDevSiteUrl,
  mergeGrantLists,
} from '../lib/proofofdevApi.js';

function corsRead(req: Request, res: Response): void {
  const h = webDeployCorsHeadersRead(req.headers.origin);
  for (const [k, v] of Object.entries(h)) res.setHeader(k, v);
}

function parseAddress(raw: string): `0x${string}` | null {
  if (!/^0x[a-fA-F0-9]{40}$/.test(raw.trim())) return null;
  try {
    return getAddress(raw.trim());
  } catch {
    return null;
  }
}

export function registerVestingProxyRoutes(app: Express): void {
  app.options('/api/tokens/:tokenAddress/vesting', (req, res) => {
    corsRead(req, res);
    res.status(204).end();
  });

  app.get('/api/tokens/:tokenAddress/vesting', async (req: Request, res: Response) => {
    corsRead(req, res);

    const tokenAddress = parseAddress(
      typeof req.params.tokenAddress === 'string' ? req.params.tokenAddress : '',
    );
    if (!tokenAddress) {
      res.status(400).json({ error: 'tokenAddress must be a valid 0x contract address.' });
      return;
    }

    const recipientRaw = typeof req.query.recipient === 'string' ? req.query.recipient : '';
    const recipient = recipientRaw ? parseAddress(recipientRaw) : null;

    try {
      const [byToken, byRecipient] = await Promise.all([
        fetchVestingByToken(tokenAddress.toLowerCase()),
        recipient ? fetchVestingByRecipient(recipient) : Promise.resolve([]),
      ]);

      const merged = mergeGrantLists(byToken.grants ?? [], byRecipient);
      const activeCount = merged.filter((g) => g.status === 'active').length;
      const devs = new Set(merged.map((g) => g.githubOwner));

      res.json({
        ok: true,
        tokenAddress,
        count: merged.length,
        activeCount,
        uniqueDevs: devs.size,
        createLockUrl: `${getProofOfDevSiteUrl()}/create?token=${tokenAddress}`,
        exploreUrl: getProofOfDevSiteUrl(),
        grants: merged.map(enrichGrant),
        sources: {
          byToken: byToken.count ?? 0,
          byRecipient: byRecipient.length,
        },
      });
    } catch (err: unknown) {
      res.status(502).json({
        ok: false,
        error: err instanceof Error ? err.message : 'Failed to load vesting',
        grants: [],
        count: 0,
      });
    }
  });
}
