import { getAddress } from 'viem';
import type { DeploymentCatalogRow } from './deploymentCatalog.js';
import { resolveDeployerWalletAddress } from './deploymentPartyEnrichment.js';
import { getBankrWalletForPrivyUser } from './hoodSocialDb.js';
import { fetchTopShareHolder } from './tokenFractionHolders.js';
import { webWalletDeployerId } from './webWalletMessages.js';

export type TokenPageAdminInfo = {
  adminWallet: string;
  adminRole: 'top_share_holder' | 'deployer' | 'fee_recipient';
  topShareHolder: string | null;
  topShareCount: number | null;
  deployerWallet: string | null;
  feeRecipientAddress: string;
};

export async function resolveTokenPageAdmin(row: DeploymentCatalogRow): Promise<TokenPageAdminInfo> {
  const feeRecipientAddress = getAddress(row.feeRecipientAddress);
  const deployerWallet = await resolveDeployerWalletAddress(row);

  let fromBlock = 0n;
  if (row.blockNumber?.trim()) {
    try {
      fromBlock = BigInt(row.blockNumber.trim());
    } catch {
      fromBlock = 0n;
    }
  }

  const top = await fetchTopShareHolder(row.tokenAddress, {
    fromBlock,
    factoryAddress: row.factoryAddress,
  });

  if (top && top.shares > 0) {
    return {
      adminWallet: top.address,
      adminRole: 'top_share_holder',
      topShareHolder: top.address,
      topShareCount: top.shares,
      deployerWallet,
      feeRecipientAddress,
    };
  }

  if (deployerWallet) {
    return {
      adminWallet: deployerWallet,
      adminRole: 'deployer',
      topShareHolder: null,
      topShareCount: null,
      deployerWallet,
      feeRecipientAddress,
    };
  }

  return {
    adminWallet: feeRecipientAddress,
    adminRole: 'fee_recipient',
    topShareHolder: null,
    topShareCount: null,
    deployerWallet: null,
    feeRecipientAddress,
  };
}

export function walletCanManageTokenPage(wallet: string, admin: TokenPageAdminInfo): boolean {
  try {
    const w = getAddress(wallet).toLowerCase();
    if (w === getAddress(admin.adminWallet).toLowerCase()) return true;
    if (w === getAddress(admin.feeRecipientAddress).toLowerCase()) return true;
    if (admin.deployerWallet && w === getAddress(admin.deployerWallet).toLowerCase()) return true;
    return false;
  } catch {
    return false;
  }
}

/** Deployer or current top Holder NFT share holder — for website-builder prompt access. */
export function walletCanBuildTokenWebsite(wallet: string, admin: TokenPageAdminInfo): boolean {
  try {
    const w = getAddress(wallet).toLowerCase();
    if (admin.deployerWallet && w === getAddress(admin.deployerWallet).toLowerCase()) return true;
    if (admin.topShareHolder && w === getAddress(admin.topShareHolder).toLowerCase()) return true;
    return false;
  } catch {
    return false;
  }
}

/**
 * Resolve the Bankr wallet linked to a hood.markets connected wallet (if any).
 * When a user deploys via Bankr on X and later connects a different wallet on hood.markets,
 * they link the two via the Link Bankr flow. This lookup bridges that gap so the connected
 * wallet inherits the Bankr wallet's admin rights.
 */
export async function resolveLinkedBankrWallet(connectedWallet: string): Promise<string | null> {
  try {
    return await getBankrWalletForPrivyUser(webWalletDeployerId(getAddress(connectedWallet) as `0x${string}`));
  } catch {
    return null;
  }
}

/** @deprecated use walletCanManageTokenPage — kept for callers that only checked top holder */
export function walletIsTokenPageAdmin(wallet: string, admin: TokenPageAdminInfo): boolean {
  return walletCanManageTokenPage(wallet, admin);
}
