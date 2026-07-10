/**
 * hood.markets Community Launch API — Robinhood Chain (4663) only.
 * Self-hosted on api.hood.markets. Not affiliated with or proxied through any third-party launchpad.
 */
import type { Express, Request, Response } from 'express';
import { getAddress, isAddress, parseEther } from 'viem';
import {
  createPetition,
  findOpenPetitionBySymbol,
  getPetitionById,
  getPetitionOrder,
  insertPetitionOrder,
  listOpenPetitions,
  listPetitionOrders,
  markPetitionCancelled,
  refreshPetitionExpiryStatus,
  sumActiveRaisedWei,
  updatePetitionSoldUnits,
} from '../lib/petitionDb.js';
import { runCommunityLaunchPreflight } from '../lib/communityLaunchPreflight.js';
import { petitionEscrowConfigured } from '../lib/petitionConfig.js';
import {
  parseContributionWei,
  petitionTargetRaiseWei,
  resolveEthRaiseCreate,
  sumOrderContributions,
  validateEthContribution,
} from '../lib/petitionEthGoal.js';
import { maybeStartFinalization } from '../lib/petitionFinalize.js';
import { parsePetitionIdFromInput } from '../lib/petitionParse.js';
import { createPetitionPublicClient, verifyPetitionDeposit } from '../lib/petitionRobinhoodEscrow.js';
import { refundAllActivePetitionOrders, refundPetitionOrder, createPetitionRefundClients } from '../lib/petitionRefunds.js';
import { enrichPetitionImage, resolvePetitionLogoForCreate } from '../lib/petitionImage.js';
import {
  buildPrepareDepositNextStep,
  petitionConfigPayload,
  summarizePetition,
} from '../lib/petitionSummarize.js';

async function loadPetitionSummary(id: number, req: Request) {
  let petition = await getPetitionById(id);
  if (!petition) return null;
  petition = await refreshPetitionExpiryStatus(petition);
  petition = await enrichPetitionImage(petition);
  const orders = await listPetitionOrders(id);
  return summarizePetition(petition, orders, appOrigin(req));
}

function petitionCors(): Record<string, string> {
  return {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization',
    'Cache-Control': 'no-store',
  };
}

function applyCors(res: Response): void {
  for (const [k, v] of Object.entries(petitionCors())) {
    res.setHeader(k, v);
  }
}

function body(req: Request): Record<string, unknown> {
  return req.body && typeof req.body === 'object' ? (req.body as Record<string, unknown>) : {};
}

function cleanString(value: unknown, max = 500): string {
  return String(value ?? '').trim().slice(0, max);
}

function tokenSymbol(raw: unknown): string {
  return cleanString(raw, 16).replace(/^\$/, '').toUpperCase();
}

function parseContributionFromQuery(raw: unknown): bigint | null {
  const eth = String(raw ?? '').trim();
  if (eth) return parseContributionWei(eth);
  const wei = parseLaunchBuyWei(raw);
  return wei > 0n ? wei : null;
}

function parseLaunchBuyWei(raw: unknown): bigint {
  const trimmed = String(raw ?? '0').trim();
  if (!trimmed || trimmed === '0') return 0n;
  try {
    if (trimmed.includes('.')) return parseEther(trimmed);
    return BigInt(trimmed);
  } catch {
    return 0n;
  }
}

function appOrigin(req: Request): string {
  const fromEnv = process.env.LAUNCHER_APP_URL?.trim();
  if (fromEnv) return fromEnv.replace(/\/$/, '');
  const origin = req.headers.origin;
  if (typeof origin === 'string' && origin.startsWith('http')) return origin.replace(/\/$/, '');
  return 'https://hood.markets';
}

const API_PREFIX = '/api/community-launch';

export function registerCommunityLaunchRoutes(app: Express): void {
  const paths = [
    `${API_PREFIX}/config`,
    `${API_PREFIX}/list`,
    `${API_PREFIX}/preflight`,
    `${API_PREFIX}/create`,
    `${API_PREFIX}/status`,
    `${API_PREFIX}/prepare-deposit`,
    `${API_PREFIX}/confirm`,
    `${API_PREFIX}/refund`,
    `${API_PREFIX}/cancel`,
  ];

  for (const path of paths) {
    app.options(path, (_req, res) => {
      applyCors(res);
      res.status(204).end();
    });
  }

  app.get('/api/community-launch/config', (_req, res) => {
    applyCors(res);
    res.json({ ok: true, config: petitionConfigPayload() });
  });

  app.get('/api/community-launch/list', async (req, res) => {
    applyCors(res);
    const limit = Math.min(100, Math.max(1, Number.parseInt(String(req.query.limit ?? '50'), 10) || 50));
    const offset = Math.max(0, Number.parseInt(String(req.query.offset ?? '0'), 10) || 0);
    const rows = await listOpenPetitions(limit, offset);
    const petitions = await Promise.all(
      rows.map(async (row) => {
        let refreshed = await refreshPetitionExpiryStatus(row);
        refreshed = await enrichPetitionImage(refreshed);
        const orders = await listPetitionOrders(refreshed.id);
        return summarizePetition(refreshed, orders, appOrigin(req));
      }),
    );
    res.json({ ok: true, petitions });
  });

  app.get('/api/community-launch/preflight', async (req, res) => {
    applyCors(res);
    const result = await runCommunityLaunchPreflight({
      tokenName: req.query.tokenName,
      tokenSymbol: req.query.tokenSymbol,
      targetRaiseEth: req.query.targetRaiseEth,
      supporterSlots: req.query.supporterSlots,
      appOrigin: appOrigin(req),
    });
    res.status(result.ok ? 200 : 409).json(result);
  });

  app.get('/api/community-launch/status', async (req, res) => {
    applyCors(res);
    const id =
      parsePetitionIdFromInput(String(req.query.id ?? '')) ??
      parsePetitionIdFromInput(String(req.query.url ?? ''));
    if (!id) {
      res.status(400).json({ ok: false, error: 'Missing petition id or url.' });
      return;
    }
    const summary = await loadPetitionSummary(id, req);
    if (!summary) {
      res.status(404).json({ ok: false, error: 'Petition not found.' });
      return;
    }
    res.json({ ok: true, petition: summary });
  });

  app.post('/api/community-launch/create', async (req, res) => {
    applyCors(res);
    if (!petitionEscrowConfigured()) {
      res.status(503).json({ ok: false, error: 'Petition rail is not configured on Robinhood Chain.' });
      return;
    }

    const b = body(req);
    const tokenName = cleanString(b.tokenName, 64);
    const symbol = tokenSymbol(b.tokenSymbol);
    const starterWallet = cleanString(b.starterWallet ?? b.creatorWallet, 96);
    const hoodClaimOptIn = b.hoodClaimOptIn === true || b.hoodClaimOptIn === 'true';

    if (tokenName.length < 2) {
      res.status(400).json({ ok: false, error: 'tokenName must be at least 2 characters.' });
      return;
    }
    if (!symbol || symbol.length > 10) {
      res.status(400).json({ ok: false, error: 'tokenSymbol is required (max 10 chars).' });
      return;
    }

    const raise = resolveEthRaiseCreate({
      targetRaiseEth: b.targetRaiseEth ?? b.raiseEth ?? b.goalEth,
      supporterSlots: b.supporterSlots ?? b.maxSupporters,
      hoodClaimOptIn,
    });
    if (!raise.ok) {
      res.status(400).json({ ok: false, error: raise.error });
      return;
    }

    const existing = await findOpenPetitionBySymbol(symbol, starterWallet || undefined);
    if (existing) {
      const summary = await loadPetitionSummary(existing.id, req);
      res.json({
        ok: true,
        reused: true,
        petition: summary,
      });
      return;
    }

    const preflight = await runCommunityLaunchPreflight({
      tokenName,
      tokenSymbol: symbol,
      appOrigin: appOrigin(req),
    });
    if (!preflight.ok) {
      res.status(409).json({
        ok: false,
        error: preflight.error,
        communityLaunch: preflight.communityLaunch,
        deployCooldown: preflight.deployCooldown,
      });
      return;
    }

    const tweetUrl = cleanString(b.tweetUrl ?? b.xUrl ?? b.promoTweetUrl ?? b.sourceTweetUrl, 1024);

    let storedImageUrl = '';
    try {
      storedImageUrl = await resolvePetitionLogoForCreate({
        imageUrl: b.imageUrl,
        tweetUrl,
        tokenName,
      });
    } catch (e: unknown) {
      res.status(400).json({
        ok: false,
        error: e instanceof Error ? e.message : 'Invalid image.',
      });
      return;
    }

    const row = await createPetition({
      tokenName,
      tokenSymbol: symbol,
      description: cleanString(b.description, 2000),
      imageUrl: storedImageUrl,
      websiteUrl: cleanString(b.websiteUrl, 1024),
      tweetUrl,
      starterWallet,
      maxUnitsPerWallet: 1,
      supporterSlots: raise.supporterSlots,
      hoodClaimOptIn,
      targetRaiseWei: raise.targetRaiseWei.toString(),
    });

    res.json({
      ok: true,
      petition: await loadPetitionSummary(row.id, req),
    });
  });

  app.get('/api/community-launch/prepare-deposit', async (req, res) => {
    applyCors(res);
    const id =
      parsePetitionIdFromInput(String(req.query.id ?? '')) ??
      parsePetitionIdFromInput(String(req.query.url ?? ''));
    const wallet = cleanString(req.query.wallet, 96);
    const contributionWei =
      parseContributionFromQuery(req.query.contributionEth ?? req.query.contributionWei) ??
      parseContributionFromQuery(req.query.launchBuyEth ?? req.query.launchBuyWei);

    if (!id) {
      res.status(400).json({ ok: false, error: 'Missing petition id or url.' });
      return;
    }
    if (!wallet || !isAddress(wallet)) {
      res.status(400).json({ ok: false, error: 'Valid wallet is required.' });
      return;
    }
    if (!contributionWei) {
      res.status(400).json({ ok: false, error: 'contributionEth is required.' });
      return;
    }

    let petition = await getPetitionById(id);
    if (!petition) {
      res.status(404).json({ ok: false, error: 'Petition not found.' });
      return;
    }
    petition = await refreshPetitionExpiryStatus(petition);
    if (petition.status !== 'open') {
      res.status(400).json({ ok: false, error: `Petition is ${petition.status}; deposits are closed.` });
      return;
    }

    const orders = await listPetitionOrders(id);
    const existing = orders.find((o) => o.wallet.toLowerCase() === getAddress(wallet).toLowerCase());
    if (existing?.status === 'active') {
      res.status(400).json({
        ok: false,
        error: 'Wallet already contributed. Refund first to change amount.',
      });
      return;
    }

    const raisedWei = sumOrderContributions(orders);
    const validationErr = validateEthContribution(petition, orders, contributionWei, raisedWei);
    if (validationErr) {
      res.status(400).json({ ok: false, error: validationErr });
      return;
    }

    const nextStep = buildPrepareDepositNextStep(contributionWei);

    res.json({
      ok: true,
      petitionId: String(id),
      deposit: {
        contributionEth: (Number(contributionWei) / 1e18).toString(),
        contributionWei: contributionWei.toString(),
        totalEth: (Number(contributionWei) / 1e18).toString(),
        totalWei: contributionWei.toString(),
      },
      nextStep,
      afterDeposit: {
        id: String(id),
        wallet: getAddress(wallet),
        contributionWei: contributionWei.toString(),
      },
    });
  });

  app.post('/api/community-launch/confirm', async (req, res) => {
    applyCors(res);
    const b = body(req);
    const id = parsePetitionIdFromInput(String(b.id ?? ''));
    const wallet = cleanString(b.wallet, 96);
    const contributionWei =
      parseContributionWei(b.contributionEth ?? b.contributionWei) ??
      parseContributionWei(b.launchBuyEth ?? b.launchBuyWei);
    const signature = cleanString(b.signature ?? b.txHash, 128);

    if (!id || !wallet || !isAddress(wallet) || !contributionWei || !signature.startsWith('0x')) {
      res.status(400).json({
        ok: false,
        error: 'id, wallet, contributionEth, and signature (tx hash) are required.',
      });
      return;
    }

    let petition = await getPetitionById(id);
    if (!petition) {
      res.status(404).json({ ok: false, error: 'Petition not found.' });
      return;
    }
    petition = await refreshPetitionExpiryStatus(petition);
    if (petition.status !== 'open') {
      res.status(400).json({ ok: false, error: `Petition is ${petition.status}.` });
      return;
    }

    const orders = await listPetitionOrders(id);
    const existing = await getPetitionOrder(id, wallet);
    if (existing?.status === 'active' && existing.deposit_tx_hash !== signature) {
      res.status(400).json({ ok: false, error: 'Wallet already has an active contribution.' });
      return;
    }

    const raisedBefore = sumOrderContributions(
      orders.filter((o) => o.wallet.toLowerCase() !== getAddress(wallet).toLowerCase()),
    );
    const validationErr = validateEthContribution(petition, orders, contributionWei, raisedBefore);
    if (validationErr) {
      res.status(400).json({ ok: false, error: validationErr });
      return;
    }

    const publicClient = createPetitionPublicClient();
    const verified = await verifyPetitionDeposit({
      hash: signature as `0x${string}`,
      buyer: wallet,
      contributionWei,
      publicClient,
    });

    await insertPetitionOrder({
      petitionId: id,
      wallet,
      units: 0,
      launchBuyWei: '0',
      depositWei: verified.wei,
      depositTxHash: signature,
    });

    const raisedWei = await sumActiveRaisedWei(id);
    await updatePetitionSoldUnits(id, 0);

    const targetWei = petitionTargetRaiseWei(petition);
    const locked = raisedWei >= targetWei;
    if (locked) {
      maybeStartFinalization(id, raisedWei, targetWei);
    }

    const summary = await loadPetitionSummary(id, req);
    res.json({
      ok: true,
      locked,
      raisedWei: raisedWei.toString(),
      targetRaiseWei: targetWei.toString(),
      petition: summary,
    });
  });

  app.post('/api/community-launch/refund', async (req, res) => {
    applyCors(res);
    const b = body(req);
    const id = parsePetitionIdFromInput(String(b.id ?? ''));
    const wallet = cleanString(b.wallet, 96);

    if (!id || !wallet || !isAddress(wallet)) {
      res.status(400).json({ ok: false, error: 'id and wallet are required.' });
      return;
    }

    let petition = await getPetitionById(id);
    if (!petition) {
      res.status(404).json({ ok: false, error: 'Petition not found.' });
      return;
    }
    petition = await refreshPetitionExpiryStatus(petition);
    if (
      petition.status !== 'open' &&
      petition.status !== 'expired' &&
      petition.status !== 'failed'
    ) {
      res.status(400).json({
        ok: false,
        error: 'Refunds only while the launch is open, expired, or failed after finalization.',
      });
      return;
    }

    const order = await getPetitionOrder(id, wallet);
    if (!order || order.status !== 'active') {
      res.status(400).json({ ok: false, error: 'No active order for this wallet.' });
      return;
    }

    const clients = createPetitionRefundClients();
    const refundTx = await refundPetitionOrder(id, order, clients);
    await updatePetitionSoldUnits(id, 0);

    res.json({
      ok: true,
      refundTxHash: refundTx,
      petition: await loadPetitionSummary(id, req),
    });
  });

  app.post('/api/community-launch/cancel', async (req, res) => {
    applyCors(res);
    const b = body(req);
    const id = parsePetitionIdFromInput(String(b.id ?? ''));
    const wallet = cleanString(b.wallet, 96);

    if (!id) {
      res.status(400).json({ ok: false, error: 'id is required.' });
      return;
    }
    if (!wallet || !isAddress(wallet)) {
      res.status(400).json({ ok: false, error: 'Creator wallet is required.' });
      return;
    }

    let petition = await getPetitionById(id);
    if (!petition) {
      res.status(404).json({ ok: false, error: 'Petition not found.' });
      return;
    }
    petition = await refreshPetitionExpiryStatus(petition);
    if (petition.status !== 'open' && petition.status !== 'expired') {
      res.status(400).json({
        ok: false,
        error: 'Only open or expired launches can be cancelled.',
      });
      return;
    }

    if (!petition.starter_wallet) {
      res.status(400).json({ ok: false, error: 'This launch has no creator wallet on file.' });
      return;
    }
    try {
      if (getAddress(wallet) !== getAddress(petition.starter_wallet)) {
        res.status(403).json({ ok: false, error: 'Only the creator can cancel this launch.' });
        return;
      }
    } catch {
      res.status(400).json({ ok: false, error: 'Invalid wallet.' });
      return;
    }

    const raised = await sumActiveRaisedWei(id);
    const targetWei = petitionTargetRaiseWei(petition);
    if (targetWei > 0n && raised >= targetWei) {
      res.status(400).json({
        ok: false,
        error: 'Raise goal is met — launch is processing. Cancel is no longer available.',
      });
      return;
    }

    const orders = await listPetitionOrders(id);
    let refunds: Array<{ wallet: string; refundTxHash: string }> = [];
    try {
      const refundResults = await refundAllActivePetitionOrders(id, orders);
      refunds = refundResults.map((r) => ({
        wallet: r.wallet,
        refundTxHash: r.refundTxHash,
      }));
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : String(e);
      res.status(500).json({
        ok: false,
        error: `Refund failed: ${msg}`,
        refunds,
      });
      return;
    }

    const cancelled = await markPetitionCancelled(id);
    if (!cancelled) {
      res.status(409).json({
        ok: false,
        error: 'Launch status changed before cancel could complete. Refresh and try again.',
        refunds,
      });
      return;
    }

    await updatePetitionSoldUnits(id, 0);
    res.json({
      ok: true,
      refunds,
      petition: await loadPetitionSummary(id, req),
    });
  });
}
