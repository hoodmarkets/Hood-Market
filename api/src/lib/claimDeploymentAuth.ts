import { getAddress } from 'viem';
import type { DeploymentCatalogRow } from './deploymentCatalog.js';
import {
  getDeploymentByFeeRecipientAndTokenAddress,
  getDeploymentByPlatformDeployerFeeRecipientAndTokenAddress,
  getDeploymentByTokenAddress,
  getNewestDeploymentByTickerSymbol,
  listDeploymentsByFeeRecipientAndName,
  listDeploymentsByFeeRecipientAndSymbol,
  listDeploymentsByPlatformDeployerFeeRecipientAndName,
  listDeploymentsByPlatformDeployerFeeRecipientAndSymbol,
  normalizeCatalogTickerSymbol,
} from './deploymentCatalog.js';

export type ResolveClaimDeploymentResult =
  | { ok: true; row: DeploymentCatalogRow; tokenAddress: `0x${string}` }
  | { ok: false; error: string; status: number };

function normalizeSymbol(raw: string): string {
  return raw.trim().replace(/^\$/u, '').toUpperCase();
}

function normalizeName(raw: string): string {
  return raw.trim().replace(/\s+/gu, ' ');
}

/**
 * Ensures an agent claim targets a token this fee wallet is recorded for in our catalog.
 * Caller must pass the contract (0x), or a ticker / name that uniquely identifies one deployment for this wallet.
 */
export async function resolveAgentClaimDeployment(params: {
  feeRecipient: string;
  tokenAddress?: string;
  tokenSymbol?: string;
  tokenName?: string;
}): Promise<ResolveClaimDeploymentResult> {
  const fee = getAddress(params.feeRecipient);
  const ca = params.tokenAddress?.trim();
  const sym = params.tokenSymbol?.trim();
  const name = params.tokenName?.trim();

  if (!ca && !sym && !name) {
    return {
      ok: false,
      status: 400,
      error:
        'Identify the token: send tokenAddress (contract 0x…), and/or tokenSymbol (ticker) and/or tokenName so we can match your deployment. Only the fee recipient for that token may claim.',
    };
  }

  if (ca) {
    if (!/^0x[0-9a-fA-F]{40}$/.test(ca)) {
      return { ok: false, status: 400, error: 'tokenAddress must be a valid 0x contract address.' };
    }
    const token = getAddress(ca);
    const row = await getDeploymentByFeeRecipientAndTokenAddress(fee, token);
    if (!row) {
      return {
        ok: false,
        status: 403,
        error:
          'No hoodmarkets deployment found for this fee wallet and token contract. You can only claim fees for tokens you deployed here as fee recipient.',
      };
    }
    if (sym && normalizeSymbol(sym) !== normalizeSymbol(row.tokenSymbol)) {
      return {
        ok: false,
        status: 400,
        error: `tokenSymbol does not match this deployment (expected ${row.tokenSymbol}).`,
      };
    }
    if (name && normalizeName(name).toLowerCase() !== normalizeName(row.tokenName).toLowerCase()) {
      return {
        ok: false,
        status: 400,
        error: `tokenName does not match this deployment (expected "${row.tokenName}").`,
      };
    }
    return { ok: true, row, tokenAddress: token };
  }

  if (sym) {
    const matches = await listDeploymentsByFeeRecipientAndSymbol(fee, sym);
    if (matches.length === 0) {
      return {
        ok: false,
        status: 403,
        error:
          'No deployment found for this fee wallet with that ticker. Pass the token contract (0x…) if the symbol is wrong or ambiguous.',
      };
    }
    if (matches.length > 1) {
      return {
        ok: false,
        status: 400,
        error: `Multiple tokens use ticker "${normalizeSymbol(sym)}" for your fee wallet — pass tokenAddress (contract 0x…) to choose one.`,
      };
    }
    const row = matches[0];
    if (name && normalizeName(name).toLowerCase() !== normalizeName(row.tokenName).toLowerCase()) {
      return {
        ok: false,
        status: 400,
        error: `tokenName does not match the deployment for that ticker (expected "${row.tokenName}").`,
      };
    }
    return { ok: true, row, tokenAddress: getAddress(row.tokenAddress) };
  }

  const matchesName = await listDeploymentsByFeeRecipientAndName(fee, name!);
  if (matchesName.length === 0) {
    return {
      ok: false,
      status: 403,
      error:
        'No deployment found for this fee wallet with that token name. Pass tokenAddress (0x…) or tokenSymbol (ticker).',
    };
  }
  if (matchesName.length > 1) {
    return {
      ok: false,
      status: 400,
      error:
        'Multiple deployments share that name for your fee wallet — pass tokenAddress (contract 0x…) or tokenSymbol (ticker).',
    };
  }
  const row = matchesName[0];
  return { ok: true, row, tokenAddress: getAddress(row.tokenAddress) };
}

/**
 * Same rules as {@link resolveAgentClaimDeployment}, but the catalog row must also match
 * `platform` + `deployerId` (the social account that initiated the deploy on that surface).
 */
export async function resolveSocialClaimDeployment(params: {
  platform: string;
  deployerId: string;
  feeRecipient: string;
  tokenAddress?: string;
  tokenSymbol?: string;
  tokenName?: string;
}): Promise<ResolveClaimDeploymentResult> {
  const fee = getAddress(params.feeRecipient);
  const plat = params.platform.trim();
  const dep = params.deployerId.trim();
  const ca = params.tokenAddress?.trim();
  const sym = params.tokenSymbol?.trim();
  const name = params.tokenName?.trim();

  if (!ca && !sym && !name) {
    return {
      ok: false,
      status: 400,
      error:
        'Identify the token: send the contract (0x…), or a ticker (e.g. $PEPE), or the token name — for a deployment you made on this platform.',
    };
  }

  if (ca) {
    if (!/^0x[0-9a-fA-F]{40}$/.test(ca)) {
      return { ok: false, status: 400, error: 'tokenAddress must be a valid 0x contract address.' };
    }
    const token = getAddress(ca);
    const row = await getDeploymentByPlatformDeployerFeeRecipientAndTokenAddress(
      plat,
      dep,
      fee,
      token,
    );
    if (!row) {
      return {
        ok: false,
        status: 403,
        error:
          'No matching deployment on this platform for your account and fee wallet. You can only claim for tokens you deployed here with fees to your linked wallet.',
      };
    }
    if (sym && normalizeSymbol(sym) !== normalizeSymbol(row.tokenSymbol)) {
      return {
        ok: false,
        status: 400,
        error: `tokenSymbol does not match this deployment (expected ${row.tokenSymbol}).`,
      };
    }
    if (name && normalizeName(name).toLowerCase() !== normalizeName(row.tokenName).toLowerCase()) {
      return {
        ok: false,
        status: 400,
        error: `tokenName does not match this deployment (expected "${row.tokenName}").`,
      };
    }
    return { ok: true, row, tokenAddress: token };
  }

  if (sym) {
    const matches = await listDeploymentsByPlatformDeployerFeeRecipientAndSymbol(
      plat,
      dep,
      fee,
      sym,
    );
    if (matches.length === 0) {
      return {
        ok: false,
        status: 403,
        error:
          'No deployment on this platform under your account with that ticker. Pass the token contract (0x…) if the symbol is wrong or ambiguous.',
      };
    }
    if (matches.length > 1) {
      return {
        ok: false,
        status: 400,
        error: `Multiple tokens use ticker "${normalizeSymbol(sym)}" for your deployments here — pass tokenAddress (contract 0x…).`,
      };
    }
    const row = matches[0];
    if (name && normalizeName(name).toLowerCase() !== normalizeName(row.tokenName).toLowerCase()) {
      return {
        ok: false,
        status: 400,
        error: `tokenName does not match the deployment for that ticker (expected "${row.tokenName}").`,
      };
    }
    return { ok: true, row, tokenAddress: getAddress(row.tokenAddress) };
  }

  const matchesName = await listDeploymentsByPlatformDeployerFeeRecipientAndName(
    plat,
    dep,
    fee,
    name!,
  );
  if (matchesName.length === 0) {
    return {
      ok: false,
      status: 403,
      error:
        'No deployment on this platform under your account with that token name. Pass tokenAddress (0x…) or a ticker.',
    };
  }
  if (matchesName.length > 1) {
    return {
      ok: false,
      status: 400,
      error:
        'Multiple deployments share that name for your account here — pass tokenAddress (0x…) or a ticker.',
    };
  }
  const row = matchesName[0];
  return { ok: true, row, tokenAddress: getAddress(row.tokenAddress) };
}

/**
 * Permissionless claim lookup — any hood.markets catalog token by contract or ticker.
 * Caller does not need to be fee recipient, deployer, or share holder.
 */
export async function resolvePermissionlessClaimDeployment(params: {
  tokenAddress?: string;
  tokenSymbol?: string;
}): Promise<ResolveClaimDeploymentResult> {
  const ca = params.tokenAddress?.trim();
  const sym = params.tokenSymbol?.trim();

  if (!ca && !sym) {
    return {
      ok: false,
      status: 400,
      error:
        'Identify the token: send tokenAddress (contract 0x…) or tokenSymbol (ticker, e.g. $TEST).',
    };
  }

  if (ca) {
    if (!/^0x[0-9a-fA-F]{40}$/.test(ca)) {
      return { ok: false, status: 400, error: 'tokenAddress must be a valid 0x contract address.' };
    }
    const token = getAddress(ca);
    const row = await getDeploymentByTokenAddress(token);
    if (!row) {
      return {
        ok: false,
        status: 404,
        error: 'Token not found in hoodmarkets catalog.',
      };
    }
    if (sym && normalizeSymbol(sym) !== normalizeSymbol(row.tokenSymbol)) {
      return {
        ok: false,
        status: 400,
        error: `tokenSymbol does not match this deployment (expected ${row.tokenSymbol}).`,
      };
    }
    return { ok: true, row, tokenAddress: token };
  }

  const row = await getNewestDeploymentByTickerSymbol(sym!);
  if (!row) {
    return {
      ok: false,
      status: 404,
      error: `No hood.markets token found for ticker ${normalizeCatalogTickerSymbol(sym!)}. Pass tokenAddress (0x…) if the symbol is wrong.`,
    };
  }
  return { ok: true, row, tokenAddress: getAddress(row.tokenAddress) };
}
