import { getAddress } from 'viem';
import type { DeploymentCatalogRow } from './deploymentCatalog.js';
import { fetchDexBrandingProfile, type DexSocialLinksProfile } from './dexscreenerProfile.js';
import {
  getTokenPageProfile,
  markTokenPageVerified,
  upsertTokenPageProfile,
  type TokenPageProfileRow,
} from './hoodSocialDb.js';
import { importDexBrandingForToken } from './importDexBranding.js';
import { resolveTokenImageUrl } from './tokenImageUrl.js';
import {
  isHttpsAssetUrl,
  normalizeSocialLinks,
  parseCustomLinksJson,
  type CustomSocialLink,
} from './socialLinks.js';
import {
  resolveLinkedBankrWallet,
  resolveTokenPageAdmin,
  walletCanBuildTokenWebsite,
  walletCanManageTokenPage,
} from './tokenPageAdmin.js';

export type ResolvedTokenPageProfile = {
  tokenAddress: string;
  description: string;
  websiteUrl: string;
  xUrl: string;
  telegramUrl: string;
  discordUrl: string;
  githubUrl: string;
  customLinks: CustomSocialLink[];
  catalogImageUrl: string | null;
  catalogBannerUrl: string | null;
  profileImageUrl: string | null;
  profileBannerUrl: string | null;
  displayImageUrl: string | null;
  displayBannerUrl: string | null;
  useDexIcon: boolean;
  useDexBanner: boolean;
  useLaunchImage: boolean;
  useDexLinks: boolean;
  stored: {
    description: string;
    websiteUrl: string;
    xUrl: string;
    telegramUrl: string;
    discordUrl: string;
    githubUrl: string;
    customLinks: CustomSocialLink[];
  };
  dexLinks: DexSocialLinksProfile;
  catalog: {
    description: string;
    websiteUrl: string;
    xUrl: string;
  };
  verified: boolean;
  verifiedAt: string | null;
  verifiedBy: string | null;
  canEdit: boolean;
  canVerify: boolean;
  isAdmin: boolean;
  /** Deployer or top Holder NFT share holder — website-builder prompt. */
  canBuildWebsite: boolean;
  adminRole: string | null;
  topShareHolder: string | null;
  deployerWallet: string | null;
  dex: Awaited<ReturnType<typeof fetchDexBrandingProfile>>;
};

function pickUrl(...candidates: (string | null | undefined)[]): string {
  for (const c of candidates) {
    const t = c?.trim();
    if (t) return t;
  }
  return '';
}

function mergeCustomLinks(
  stored: CustomSocialLink[],
  dex: CustomSocialLink[],
  useDex: boolean,
): CustomSocialLink[] {
  const out = [...stored];
  if (!useDex) return out;
  const seen = new Set(out.map((l) => l.url.toLowerCase()));
  for (const link of dex) {
    const key = link.url.toLowerCase();
    if (seen.has(key)) continue;
    out.push(link);
    seen.add(key);
  }
  return out.slice(0, 12);
}

function resolveSocialField(
  profileVal: string | undefined,
  catalogVal: string | undefined,
  dexVal: string,
  useDex: boolean,
): string {
  const manual = pickUrl(profileVal, catalogVal);
  if (manual) return manual;
  if (useDex && dexVal.trim()) return dexVal.trim();
  return '';
}

function resolveDisplayAssets(
  row: DeploymentCatalogRow,
  profile: TokenPageProfileRow | null,
  dex: Awaited<ReturnType<typeof fetchDexBrandingProfile>>,
): { displayImageUrl: string | null; displayBannerUrl: string | null } {
  const useDexIcon = profile?.useDexIcon ?? true;
  const useDexBanner = profile?.useDexBanner ?? true;
  const useLaunchImage = profile?.useLaunchImage ?? true;

  const profileIcon = profile?.imageUrl?.trim() || '';
  const profileBanner = profile?.bannerUrl?.trim() || '';
  const catalogIcon = row.tokenImageUrl?.trim() || '';
  const catalogBanner = row.tokenBannerUrl?.trim() || '';
  const dexIcon = dex.enhancedInfoPaid ? dex.iconUrl : null;
  const dexBanner = dex.enhancedInfoPaid ? dex.bannerUrl : null;

  let displayImageUrl: string | null = null;
  if (profileIcon) displayImageUrl = profileIcon;
  else if (useDexIcon && dexIcon) displayImageUrl = dexIcon;
  else if (useLaunchImage && catalogIcon) displayImageUrl = catalogIcon;

  let displayBannerUrl: string | null = null;
  if (profileBanner) displayBannerUrl = profileBanner;
  else if (useDexBanner && dexBanner) displayBannerUrl = dexBanner;
  else if (catalogBanner) displayBannerUrl = catalogBanner;

  return { displayImageUrl, displayBannerUrl };
}

export async function loadTokenPageProfileView(
  row: DeploymentCatalogRow,
  wallet?: string,
): Promise<ResolvedTokenPageProfile> {
  const token = getAddress(row.tokenAddress);
  const [profile, dex, admin] = await Promise.all([
    getTokenPageProfile(token),
    fetchDexBrandingProfile(token),
    resolveTokenPageAdmin(row),
  ]);

  const isWalletAddress = (w?: string): w is string => !!w && /^0x[a-fA-F0-9]{40}$/.test(w);

  // Resolve the Bankr wallet that the connected wallet may have linked on hood.markets.
  // This lets a user whose Bankr wallet deployed a token manage it via their connected
  // hood.markets wallet (the two are bridged by the explicit Link flow).
  const linkedBankrWallet = isWalletAddress(wallet)
    ? await resolveLinkedBankrWallet(wallet)
    : null;

  const walletMatches = (w: string | undefined, check: (w: string, a: typeof admin) => boolean) =>
    isWalletAddress(w) && (check(w, admin) || (!!linkedBankrWallet && check(linkedBankrWallet, admin)));

  const isAdmin = walletMatches(wallet, walletCanManageTokenPage);
  const canBuildWebsite = walletMatches(wallet, walletCanBuildTokenWebsite);

  const canVerify =
    wallet && /^0x[a-fA-F0-9]{40}$/.test(wallet)
      ? getAddress(wallet).toLowerCase() === getAddress(admin.feeRecipientAddress).toLowerCase() &&
        !(profile?.verified ?? false)
      : false;

  const { displayImageUrl, displayBannerUrl } = resolveDisplayAssets(row, profile, dex);
  const useDexLinks = profile?.useDexLinks ?? true;
  const storedCustomLinks = parseCustomLinksJson(profile?.customLinksJson);
  const stored = {
    description: profile?.description?.trim() ?? '',
    websiteUrl: profile?.websiteUrl?.trim() ?? '',
    xUrl: profile?.xUrl?.trim() ?? '',
    telegramUrl: profile?.telegramUrl?.trim() ?? '',
    discordUrl: profile?.discordUrl?.trim() ?? '',
    githubUrl: profile?.githubUrl?.trim() ?? '',
    customLinks: storedCustomLinks,
  };

  return {
    tokenAddress: token,
    description: pickUrl(profile?.description, row.tokenDescription),
    websiteUrl: resolveSocialField(profile?.websiteUrl, row.tokenWebsiteUrl, dex.links.websiteUrl, useDexLinks),
    xUrl: resolveSocialField(profile?.xUrl, row.tokenXUrl, dex.links.xUrl, useDexLinks),
    telegramUrl: resolveSocialField(profile?.telegramUrl, '', dex.links.telegramUrl, useDexLinks),
    discordUrl: resolveSocialField(profile?.discordUrl, '', dex.links.discordUrl, useDexLinks),
    githubUrl: resolveSocialField(profile?.githubUrl, '', dex.links.githubUrl, useDexLinks),
    customLinks: mergeCustomLinks(storedCustomLinks, dex.links.customLinks, useDexLinks),
    stored,
    dexLinks: dex.links,
    catalog: {
      description: row.tokenDescription?.trim() ?? '',
      websiteUrl: row.tokenWebsiteUrl?.trim() ?? '',
      xUrl: row.tokenXUrl?.trim() ?? '',
    },
    catalogImageUrl: row.tokenImageUrl?.trim() || null,
    catalogBannerUrl: row.tokenBannerUrl?.trim() || null,
    profileImageUrl: profile?.imageUrl?.trim() || null,
    profileBannerUrl: profile?.bannerUrl?.trim() || null,
    displayImageUrl,
    displayBannerUrl,
    useDexIcon: profile?.useDexIcon ?? true,
    useDexBanner: profile?.useDexBanner ?? true,
    useLaunchImage: profile?.useLaunchImage ?? true,
    useDexLinks,
    verified: profile?.verified ?? false,
    verifiedAt: profile?.verifiedAt ?? null,
    verifiedBy: profile?.verifiedBy ?? null,
    canEdit: isAdmin,
    canVerify,
    isAdmin,
    canBuildWebsite,
    adminRole: isAdmin
      ? admin.adminRole
      : canBuildWebsite
        ? (() => {
            const effectiveWallet = wallet && admin.deployerWallet &&
              (getAddress(wallet).toLowerCase() === getAddress(admin.deployerWallet).toLowerCase() ||
               (linkedBankrWallet && getAddress(linkedBankrWallet).toLowerCase() === getAddress(admin.deployerWallet).toLowerCase()))
              ? wallet
              : null;
            return effectiveWallet ? 'deployer' : 'top_share_holder';
          })()
        : null,
    topShareHolder: admin.topShareHolder,
    deployerWallet: admin.deployerWallet,
    dex,
  };
}

export type UpdateTokenPageProfileInput = {
  walletAddress: string;
  description?: string;
  websiteUrl?: string;
  xUrl?: string;
  telegramUrl?: string;
  discordUrl?: string;
  githubUrl?: string;
  customLinks?: CustomSocialLink[];
  imageUrl?: string;
  bannerUrl?: string;
  useDexIcon?: boolean;
  useDexBanner?: boolean;
  useLaunchImage?: boolean;
  useDexLinks?: boolean;
  importDexBranding?: boolean;
};

export async function updateTokenPageProfileForWallet(
  row: DeploymentCatalogRow,
  input: UpdateTokenPageProfileInput,
): Promise<
  | { ok: true; profile: ResolvedTokenPageProfile }
  | { ok: false; status: number; error: string }
> {
  let wallet: `0x${string}`;
  try {
    wallet = getAddress(input.walletAddress.trim());
  } catch {
    return { ok: false, status: 400, error: 'Invalid wallet address.' };
  }

  const admin = await resolveTokenPageAdmin(row);
  const linkedBankr = await resolveLinkedBankrWallet(wallet);
  if (!walletCanManageTokenPage(wallet, admin) && !(linkedBankr && walletCanManageTokenPage(linkedBankr, admin))) {
    return {
      ok: false,
      status: 403,
      error: 'Only the fee recipient, top Holder share holder, or deployer can edit this token page.',
    };
  }

  if (input.importDexBranding) {
    const imported = await importDexBrandingForToken({
      tokenAddress: row.tokenAddress,
      walletAddress: wallet,
    });
    if (!imported.ok) {
      return { ok: false, status: imported.status, error: imported.error };
    }
  }

  const social = normalizeSocialLinks({
    website: input.websiteUrl,
    x: input.xUrl,
    telegram: input.telegramUrl,
    discord: input.discordUrl,
    github: input.githubUrl,
    custom: input.customLinks,
  });

  const patch: Parameters<typeof upsertTokenPageProfile>[1] = {};

  if (input.description !== undefined) {
    patch.description = input.description.trim().slice(0, 2000);
  }
  if (
    input.websiteUrl !== undefined ||
    input.xUrl !== undefined ||
    input.telegramUrl !== undefined ||
    input.discordUrl !== undefined ||
    input.githubUrl !== undefined
  ) {
    patch.websiteUrl = social.websiteUrl;
    patch.xUrl = social.xUrl;
    patch.telegramUrl = social.telegramUrl;
    patch.discordUrl = social.discordUrl;
    patch.githubUrl = social.githubUrl;
  }
  if (input.customLinks !== undefined) {
    patch.customLinksJson = JSON.stringify(social.customLinks);
  }
  if (input.imageUrl !== undefined) {
    const raw = input.imageUrl.trim();
    if (raw && !isHttpsAssetUrl(raw)) {
      return { ok: false, status: 400, error: 'imageUrl must be a valid https:// URL.' };
    }
    patch.imageUrl = raw ? resolveTokenImageUrl(raw) ?? raw : '';
  }
  if (input.bannerUrl !== undefined) {
    const raw = input.bannerUrl.trim();
    if (raw && !isHttpsAssetUrl(raw)) {
      return { ok: false, status: 400, error: 'bannerUrl must be a valid https:// URL.' };
    }
    patch.bannerUrl = raw.slice(0, 1024);
  }
  if (input.useDexIcon !== undefined) patch.useDexIcon = Boolean(input.useDexIcon);
  if (input.useDexBanner !== undefined) patch.useDexBanner = Boolean(input.useDexBanner);
  if (input.useLaunchImage !== undefined) patch.useLaunchImage = Boolean(input.useLaunchImage);
  if (input.useDexLinks !== undefined) patch.useDexLinks = Boolean(input.useDexLinks);

  const hasPatch = Object.keys(patch).length > 0 || input.importDexBranding;
  if (!hasPatch) {
    return { ok: false, status: 400, error: 'No profile fields to update.' };
  }

  if (Object.keys(patch).length > 0) {
    await upsertTokenPageProfile(row.tokenAddress, patch);
  }

  const profile = await loadTokenPageProfileView(row, wallet);
  return { ok: true, profile };
}

export async function verifyTokenPageForWallet(
  row: DeploymentCatalogRow,
  walletAddress: string,
): Promise<
  | { ok: true; profile: ResolvedTokenPageProfile; replyHint: string }
  | { ok: false; status: number; error: string }
> {
  let wallet: `0x${string}`;
  try {
    wallet = getAddress(walletAddress.trim());
  } catch {
    return { ok: false, status: 400, error: 'Invalid wallet address.' };
  }

  const admin = await resolveTokenPageAdmin(row);
  if (getAddress(wallet).toLowerCase() !== getAddress(admin.feeRecipientAddress).toLowerCase()) {
    return {
      ok: false,
      status: 403,
      error: 'Only the fee recipient wallet can verify this token page.',
    };
  }

  const existing = await getTokenPageProfile(row.tokenAddress);
  if (existing?.verified) {
    return { ok: false, status: 409, error: 'Token page is already verified.' };
  }

  await markTokenPageVerified(row.tokenAddress, wallet);
  const profile = await loadTokenPageProfileView(row, wallet);
  const sym = row.tokenSymbol.replace(/^\$/, '');
  return {
    ok: true,
    profile,
    replyHint: `$${sym} on hood.markets is now verified by the fee recipient.`,
  };
}
