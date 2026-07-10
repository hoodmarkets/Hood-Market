import { getAddress } from 'viem';
import type { DeploymentCatalogRow } from './deploymentCatalog.js';
import { countDeploymentsByXUsername } from './deploymentCatalog.js';
import { getEmbeddedEthAddressForPrivyUserId } from './privy.js';
import {
  resolveRequesterXUsername,
  type DeploymentPublicExtras,
} from './requesterXUsername.js';

/** Wallet that initiated the deploy (agent wallet or Privy embedded wallet when known). */
export async function resolveDeployerWalletAddress(
  row: Pick<DeploymentCatalogRow, 'deployerId' | 'feeToSelf' | 'feeRecipientAddress'>,
): Promise<string | null> {
  const id = row.deployerId?.trim() ?? '';
  const agentMatch = id.match(/^agent:(0x[a-fA-F0-9]{40})$/i);
  if (agentMatch) {
    try {
      return getAddress(agentMatch[1]);
    } catch {
      return agentMatch[1];
    }
  }
  if (id.startsWith('did:privy:')) {
    try {
      const addr = await getEmbeddedEthAddressForPrivyUserId(id);
      return addr ?? null;
    } catch {
      return null;
    }
  }
  if (row.feeToSelf && row.feeRecipientAddress) {
    try {
      return getAddress(row.feeRecipientAddress);
    } catch {
      return null;
    }
  }
  return null;
}

export type EnrichedDeploymentPublic = DeploymentCatalogRow & DeploymentPublicExtras & {
  deployerWalletAddress?: string;
};

export async function enrichDeploymentForPublicApi(
  row: DeploymentCatalogRow | null,
): Promise<EnrichedDeploymentPublic | null> {
  if (!row) return null;

  const requesterXUsername = resolveRequesterXUsername(row);
  const [requesterXLaunchCount, deployerWalletAddress] = await Promise.all([
    requesterXUsername ? countDeploymentsByXUsername(requesterXUsername) : Promise.resolve(undefined),
    resolveDeployerWalletAddress(row),
  ]);

  return {
    ...row,
    ...(requesterXUsername ? { requesterXUsername, requesterXLaunchCount } : {}),
    ...(deployerWalletAddress ? { deployerWalletAddress } : {}),
  };
}
