import { getAddress } from 'viem';
import {
  getDeploymentByTokenAddress,
  updateDeploymentCatalogBranding,
  type DeploymentCatalogRow,
} from './deploymentCatalog.js';
import { enrichDeploymentForPublicApi } from './deploymentPartyEnrichment.js';
import { fetchDexBrandingProfile } from './dexscreenerProfile.js';
import { resolveTokenPageAdmin, walletCanManageTokenPage } from './tokenPageAdmin.js';

export type ImportDexBrandingResult =
  | {
      ok: true;
      imported: { tokenImageUrl?: string; tokenBannerUrl?: string };
      token: Awaited<ReturnType<typeof enrichDeploymentForPublicApi>>;
      dex: Awaited<ReturnType<typeof fetchDexBrandingProfile>>;
    }
  | {
      ok: false;
      status: number;
      error: string;
      enhancedInfoStatus?: string | null;
      adminWallet?: string;
      adminRole?: string;
      feeRecipientAddress?: string;
    };

export async function importDexBrandingForToken(opts: {
  tokenAddress: string;
  walletAddress: string;
}): Promise<ImportDexBrandingResult> {
  let token: `0x${string}`;
  let wallet: `0x${string}`;
  try {
    token = getAddress(opts.tokenAddress.trim());
    wallet = getAddress(opts.walletAddress.trim());
  } catch {
    return { ok: false, status: 400, error: 'Invalid token or wallet address.' };
  }

  const row = await getDeploymentByTokenAddress(token);
  if (!row) {
    return { ok: false, status: 404, error: 'Token not found in hood.markets catalog.' };
  }

  const admin = await resolveTokenPageAdmin(row);
  if (!walletCanManageTokenPage(wallet, admin)) {
    return {
      ok: false,
      status: 403,
      error: 'Only the fee recipient, top Holder share holder, or deployer can import Dex branding.',
      adminWallet: admin.adminWallet,
      adminRole: admin.adminRole,
      feeRecipientAddress: admin.feeRecipientAddress,
    };
  }

  const dex = await fetchDexBrandingProfile(token);
  if (!dex.enhancedInfoPaid) {
    return {
      ok: false,
      status: 400,
      error: 'DexScreener Enhanced Token Info is not paid for this token yet.',
      enhancedInfoStatus: dex.enhancedInfoStatus,
    };
  }

  const patch: { tokenImageUrl?: string; tokenBannerUrl?: string } = {};
  if (dex.iconUrl) patch.tokenImageUrl = dex.iconUrl;
  if (dex.bannerUrl) patch.tokenBannerUrl = dex.bannerUrl;

  if (!patch.tokenImageUrl && !patch.tokenBannerUrl) {
    return {
      ok: false,
      status: 400,
      error: 'DexScreener has no icon or banner available for this token yet.',
      enhancedInfoStatus: dex.enhancedInfoStatus,
    };
  }

  const saved = await updateDeploymentCatalogBranding(token, patch);
  if (!saved) {
    return { ok: false, status: 500, error: 'Failed to save branding to catalog.' };
  }

  const updated = await enrichDeploymentForPublicApi(await getDeploymentByTokenAddress(token));
  return {
    ok: true,
    imported: patch,
    token: updated,
    dex,
  };
}

export async function loadDexBrandingView(
  row: DeploymentCatalogRow,
  wallet?: string,
): Promise<{
  tokenAddress: string;
  catalogImageUrl: string | null;
  catalogBannerUrl: string | null;
  dex: Awaited<ReturnType<typeof fetchDexBrandingProfile>>;
  displayImageUrl: string | null;
  displayBannerUrl: string | null;
  admin: Awaited<ReturnType<typeof resolveTokenPageAdmin>>;
  isAdmin: boolean;
}> {
  const token = getAddress(row.tokenAddress);
  const [dex, admin] = await Promise.all([
    fetchDexBrandingProfile(token),
    resolveTokenPageAdmin(row),
  ]);

  const isAdmin =
    wallet && /^0x[a-fA-F0-9]{40}$/.test(wallet)
      ? walletCanManageTokenPage(wallet, admin)
      : false;

  return {
    tokenAddress: token,
    catalogImageUrl: row.tokenImageUrl || null,
    catalogBannerUrl: row.tokenBannerUrl || null,
    dex,
    displayImageUrl:
      row.tokenImageUrl?.trim() || (dex.enhancedInfoPaid ? dex.iconUrl : null) || null,
    displayBannerUrl:
      row.tokenBannerUrl?.trim() || (dex.enhancedInfoPaid ? dex.bannerUrl : null) || null,
    admin,
    isAdmin,
  };
}
