import { getAddress } from 'viem';
import {
  getDeploymentByTokenAddress,
  getNewestDeploymentByTickerSymbol,
  type DeploymentCatalogRow,
} from './deploymentCatalog.js';
import { insertTokenSpacePost, listTokenSpacePosts, type TokenSpacePostRow } from './hoodSocialDb.js';
import { resolveAgentTokenLookup } from './agentDeployPreflight.js';
import { readTokenHolderStatus } from './robinhoodHolder.js';

const WEB_BASE = (process.env.LAUNCHER_WEB_URL || 'https://hood.markets').replace(/\/$/, '');

export async function resolveCatalogTokenForAgent(
  tokenOrSymbol: string,
): Promise<DeploymentCatalogRow | null> {
  const lookup = await resolveAgentTokenLookup(tokenOrSymbol);
  if (!lookup) return null;
  if (lookup.kind === 'address') {
    return getDeploymentByTokenAddress(lookup.address);
  }
  return getNewestDeploymentByTickerSymbol(lookup.symbol);
}

export type AgentTokenSpacePostResult =
  | {
      ok: true;
      post: TokenSpacePostRow;
      deployment: DeploymentCatalogRow;
      tokenPageUrl: string;
      replyHint: string;
    }
  | { ok: false; status: number; error: string };

export async function postAgentTokenSpaceComment(input: {
  walletAddress: string;
  tokenOrSymbol: string;
  body: string;
}): Promise<AgentTokenSpacePostResult> {
  const body = typeof input.body === 'string' ? input.body.trim() : '';
  if (!body) {
    return { ok: false, status: 400, error: 'body is required.' };
  }

  let wallet: `0x${string}`;
  try {
    wallet = getAddress(input.walletAddress.trim());
  } catch {
    return { ok: false, status: 400, error: 'wallet must be a valid 0x address.' };
  }

  const deployment = await resolveCatalogTokenForAgent(input.tokenOrSymbol);
  if (!deployment) {
    return { ok: false, status: 404, error: 'Token not found in hood.markets catalog.' };
  }

  const holder = await readTokenHolderStatus(deployment.tokenAddress, wallet);
  if (!holder.holds) {
    return {
      ok: false,
      status: 403,
      error: 'Only token holders can post in this space. Hold the ERC-20 in your Bankr wallet.',
    };
  }

  const id = await insertTokenSpacePost(deployment.tokenAddress, wallet, body);
  const createdAt = new Date().toISOString();
  const tokenPageUrl = `${WEB_BASE}/?token=${deployment.tokenAddress}`;
  const symbol = deployment.tokenSymbol;

  return {
    ok: true,
    deployment,
    tokenPageUrl,
    replyHint: `Posted to $${symbol} discussion on hood.markets.`,
    post: {
      id,
      tokenAddress: deployment.tokenAddress,
      walletAddress: wallet,
      body: body.slice(0, 2000),
      createdAt,
    },
  };
}

export async function listAgentTokenSpacePosts(
  tokenOrSymbol: string,
  limit = 50,
): Promise<
  | { ok: true; deployment: DeploymentCatalogRow; posts: TokenSpacePostRow[]; tokenPageUrl: string }
  | { ok: false; status: number; error: string }
> {
  const deployment = await resolveCatalogTokenForAgent(tokenOrSymbol);
  if (!deployment) {
    return { ok: false, status: 404, error: 'Token not found in hood.markets catalog.' };
  }

  const safeLimit = Number.isFinite(limit) ? Math.min(Math.max(1, limit), 100) : 50;
  const posts = await listTokenSpacePosts(deployment.tokenAddress, safeLimit, 0);

  return {
    ok: true,
    deployment,
    posts,
    tokenPageUrl: `${WEB_BASE}/?token=${deployment.tokenAddress}`,
  };
}
