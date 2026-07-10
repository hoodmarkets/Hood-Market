import type { Express, Request, Response } from 'express';
import { getAddress } from 'viem';
import { config } from '../config.js';
import {
  countDeploymentsAsFeeRecipient,
  countDeploymentsInitiatedByWallet,
  countDeploymentsByAgentWallet,
  countDeploymentsByXUsername,
  listDeploymentCatalogByFeeRecipient,
  listDeploymentCatalogForUser,
  listDeploymentsInitiatedByWallet,
  listDeploymentsByXUsername,
  type DeploymentCatalogRow,
} from '../lib/deploymentCatalog.js';
import { getBankrWalletForPrivyUser, getXLinkForWallet, getLinkedAccountsForWallet } from '../lib/hoodSocialDb.js';
import { fetchPrivyUserRecordById, extractTwitterUsernameFromPrivyUser } from '../lib/privy.js';
import { verifyWebSessionBearer } from '../lib/webSessionAuth.js';
import { normalizeXUsername } from '../lib/requesterXUsername.js';
import { webDeployCorsHeadersRead } from '../lib/webDeployCors.js';

const WEB_BASE = (process.env.LAUNCHER_WEB_URL || 'https://hood.markets').replace(/\/$/, '');

function publicProfileUrl(xUsername: string): string {
  const handle = normalizeXUsername(xUsername);
  if (!handle) return WEB_BASE;
  return `${WEB_BASE}/?profile=x&user=${encodeURIComponent(handle)}`;
}

function walletProfileUrl(address: string): string {
  try {
    const addr = getAddress(address);
    return `${WEB_BASE}/?profile=wallet&address=${encodeURIComponent(addr)}`;
  } catch {
    return WEB_BASE;
  }
}

function mergeDeploymentsByToken(
  ...groups: DeploymentCatalogRow[][]
): DeploymentCatalogRow[] {
  const seen = new Set<string>();
  const out: DeploymentCatalogRow[] = [];
  for (const group of groups) {
    for (const row of group) {
      const key = row.tokenAddress.toLowerCase();
      if (seen.has(key)) continue;
      seen.add(key);
      out.push(row);
    }
  }
  out.sort((a, b) => (a.createdAt < b.createdAt ? 1 : a.createdAt > b.createdAt ? -1 : 0));
  return out;
}

export function registerDeployerProfileRoutes(app: Express): void {
  app.options('/api/deployer-profile/x/:username', (req, res) => {
    const h = webDeployCorsHeadersRead(req.headers.origin);
    for (const [k, v] of Object.entries(h)) res.setHeader(k, v);
    res.status(204).end();
  });

  app.get('/api/deployer-profile/x/:username', async (req: Request, res: Response) => {
    const h = webDeployCorsHeadersRead(req.headers.origin);
    for (const [k, v] of Object.entries(h)) res.setHeader(k, v);

    const handle = normalizeXUsername(
      typeof req.params.username === 'string' ? req.params.username : '',
    );
    if (!handle) {
      res.status(400).json({ error: 'username must be a valid X handle.' });
      return;
    }

    try {
      const rawLimit = req.query.limit;
      const rawOffset = req.query.offset;
      const limit = typeof rawLimit === 'string' ? Number.parseInt(rawLimit, 10) : 50;
      const offset = typeof rawOffset === 'string' ? Number.parseInt(rawOffset, 10) : 0;
      const [launchCount, deployments] = await Promise.all([
        countDeploymentsByXUsername(handle),
        listDeploymentsByXUsername(
          handle,
          Number.isFinite(limit) ? limit : 50,
          Number.isFinite(offset) ? offset : 0,
        ),
      ]);

      res.json({
        platform: 'x',
        xUsername: handle,
        launchCount,
        profileUrl: publicProfileUrl(handle),
        deployments,
      });
    } catch {
      res.status(500).json({ error: 'Failed to load deployer profile.' });
    }
  });

  app.options('/api/deployer-profile/wallet/:address', (req, res) => {
    const h = webDeployCorsHeadersRead(req.headers.origin);
    for (const [k, v] of Object.entries(h)) res.setHeader(k, v);
    res.status(204).end();
  });

  app.get('/api/deployer-profile/wallet/:address', async (req: Request, res: Response) => {
    const h = webDeployCorsHeadersRead(req.headers.origin);
    for (const [k, v] of Object.entries(h)) res.setHeader(k, v);

    const raw = typeof req.params.address === 'string' ? req.params.address.trim() : '';
    if (!/^0x[a-fA-F0-9]{40}$/.test(raw)) {
      res.status(400).json({ error: 'address must be a valid 0x wallet.' });
      return;
    }
    let wallet: string;
    try {
      wallet = getAddress(raw);
    } catch {
      res.status(400).json({ error: 'Invalid wallet address checksum.' });
      return;
    }

    try {
      const rawLimit = req.query.limit;
      const limit = typeof rawLimit === 'string' ? Number.parseInt(rawLimit, 10) : 50;
      const [feeRecipientTokenCount, initiatedLaunchCount, feeRecipientDeployments, initiatedDeployments, linkedAccounts] =
        await Promise.all([
          countDeploymentsAsFeeRecipient(wallet),
          countDeploymentsInitiatedByWallet(wallet),
          listDeploymentCatalogByFeeRecipient(
            wallet,
            Number.isFinite(limit) ? limit : 50,
            0,
          ),
          listDeploymentsInitiatedByWallet(
            wallet,
            Number.isFinite(limit) ? limit : 50,
            0,
          ),
          getLinkedAccountsForWallet(wallet),
        ]);

      res.json({
        platform: 'wallet',
        walletAddress: wallet,
        feeRecipientTokenCount,
        initiatedLaunchCount,
        profileUrl: walletProfileUrl(wallet),
        deployments: feeRecipientDeployments,
        initiatedDeployments,
        linkedAccounts: {
          ...linkedAccounts,
          bankrVerified: linkedAccounts.bankrLinked,
          telegramLinked: false,
          telegramStatus: 'coming_soon' as const,
        },
        xHandle: linkedAccounts.xHandle,
        xLinked: linkedAccounts.xLinked,
        bankrWallet: linkedAccounts.bankrWallet,
        bankrLinked: linkedAccounts.bankrLinked,
      });
    } catch {
      res.status(500).json({ error: 'Failed to load wallet profile.' });
    }
  });

  app.options('/api/my-deployer-profile', (req, res) => {
    const h = webDeployCorsHeadersRead(req.headers.origin);
    for (const [k, v] of Object.entries(h)) res.setHeader(k, v);
    res.status(204).end();
  });

  app.get('/api/my-deployer-profile', async (req: Request, res: Response) => {
    const h = webDeployCorsHeadersRead(req.headers.origin);
    for (const [k, v] of Object.entries(h)) res.setHeader(k, v);

    if (!config.webWallet.enabled && !config.privy.enabled) {
      res.status(503).json({ error: 'Web login is not configured on the server.' });
      return;
    }

    try {
      const session = await verifyWebSessionBearer(req.headers.authorization);
      const userId = session.userId;
      const rawWallet =
        typeof req.query.walletAddress === 'string'
          ? req.query.walletAddress.trim()
          : session.kind === 'wallet'
            ? session.walletAddress
            : '';
      let resolvedWallet = '';
      if (/^0x[0-9a-fA-F]{40}$/.test(rawWallet)) {
        try {
          resolvedWallet = rawWallet.toLowerCase();
        } catch {
          /* ignore */
        }
      }

      const userRecord =
        session.kind === 'privy' ? await fetchPrivyUserRecordById(userId) : null;
      const xUsernameFromPrivy = userRecord ? extractTwitterUsernameFromPrivyUser(userRecord) : null;
      const walletXLink =
        session.kind === 'wallet' ? await getXLinkForWallet(session.walletAddress) : null;
      const xUsernameFromWallet = walletXLink?.xHandle ?? null;
      const xUsername = xUsernameFromPrivy ?? xUsernameFromWallet;
      const bankrWallet =
        session.kind === 'wallet' && session.walletKind === 'bankr-evm'
          ? session.walletAddress
          : await getBankrWalletForPrivyUser(userId);

      const [accountDeployments, xDeployments, bankrDeployments, linkedAccounts] = await Promise.all([
        listDeploymentCatalogForUser(userId, resolvedWallet, 100, 0),
        xUsername ? listDeploymentsByXUsername(xUsername, 100, 0) : Promise.resolve([]),
        bankrWallet ? listDeploymentsInitiatedByWallet(bankrWallet, 100, 0) : Promise.resolve([]),
        session.kind === 'wallet'
          ? getLinkedAccountsForWallet(session.walletAddress)
          : Promise.resolve({
              xHandle: xUsernameFromWallet,
              xLinked: !!xUsernameFromWallet,
              bankrWallet,
              bankrLinked: !!bankrWallet,
            }),
      ]);

      const launchedByAccount = accountDeployments.filter((d) => d.deployedByViewer);
      const mergedLaunches = mergeDeploymentsByToken(launchedByAccount, xDeployments, bankrDeployments);
      const xLaunchCount = xUsername ? await countDeploymentsByXUsername(xUsername) : 0;
      const bankrLaunchCount = bankrWallet ? await countDeploymentsByAgentWallet(bankrWallet) : 0;

      res.json({
        xUsername,
        xHandle: xUsername,
        xLinked: !!xUsername || linkedAccounts.xLinked,
        xVerified: false,
        xLaunchCount,
        bankrWallet,
        bankrLinked: !!bankrWallet || linkedAccounts.bankrLinked,
        bankrVerified: !!bankrWallet,
        linkedAccounts: {
          ...linkedAccounts,
          xHandle: xUsername ?? linkedAccounts.xHandle,
          xLinked: !!(xUsername ?? linkedAccounts.xHandle),
          bankrWallet: bankrWallet ?? linkedAccounts.bankrWallet,
          bankrLinked: !!(bankrWallet ?? linkedAccounts.bankrWallet),
          bankrVerified: !!(bankrWallet ?? linkedAccounts.bankrWallet),
          telegramLinked: false,
          telegramStatus: 'coming_soon',
        },
        bankrLaunchCount,
        walletLaunchCount: launchedByAccount.length,
        totalLaunchCount: mergedLaunches.length,
        publicProfileUrl: xUsername ? publicProfileUrl(xUsername) : null,
        deployments: mergedLaunches,
        accountDeployments,
      });
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : 'Unauthorized';
      const status = /authorization|bearer|access token|privy is not configured/i.test(msg)
        ? 401
        : 500;
      res.status(status).json({ error: msg });
    }
  });
}
