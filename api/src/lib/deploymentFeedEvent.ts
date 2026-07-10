import type { DeploymentCatalogRow } from './deploymentCatalog.js';
import { resolveDeploymentFactoryInfo, type DeploymentFactoryInfo } from './deploymentFactoryInfo.js';
import { hoodmarketsTokenUrl } from './launcherAppUrl.js';
import { resolveRequesterXUsername, type DeploymentPublicExtras } from './requesterXUsername.js';

export type DeploymentFeedMetadata = {
  description?: string;
  imageUrl?: string;
  bannerUrl?: string;
  websiteUrl?: string;
  /** Full X/Twitter profile or post URL when set at launch. */
  xUrl?: string;
  /** Resolved @handle when known (from catalog, source tweet, or deployer label). */
  xUsername?: string;
};

export type DeploymentFeedDeployer = {
  label: string;
  xUsername?: string;
  xLaunchCount?: number;
  walletAddress?: string;
};

export type DeploymentFeedFeeRecipient = {
  address: string;
  label?: string;
};

export type DeploymentFeedEvent = {
  id: number;
  createdAt: string;
  platform: string;
  chain: string;
  tokenName: string;
  tokenSymbol: string;
  tokenAddress: string;
  poolId?: string;
  factory: DeploymentFactoryInfo;
  /** @deprecated use `factory.address` */
  factoryAddress?: string;
  transactionHash: string;
  blockNumber: string;
  sourceUrl?: string;
  clientKind?: string;
  feeToSelf?: boolean;
  metadata: DeploymentFeedMetadata;
  deployer: DeploymentFeedDeployer;
  feeRecipient: DeploymentFeedFeeRecipient;
  links: {
    tokenPage: string;
    dexscreener: string;
    explorerToken: string;
    explorerTx: string;
    uniswap: string;
    website?: string;
    x?: string;
  };
};

type FeedRow = DeploymentCatalogRow &
  DeploymentPublicExtras & {
    deployerWalletAddress?: string;
  };

function tokenLowerHex(address: string): string {
  return address.trim().toLowerCase();
}

function optionalUrl(raw: string | undefined): string | undefined {
  const v = raw?.trim();
  if (!v) return undefined;
  if (/^https?:\/\//i.test(v)) return v;
  return undefined;
}

function resolveXUrl(row: FeedRow, xUsername?: string): string | undefined {
  const fromCatalog = optionalUrl(row.tokenXUrl);
  if (fromCatalog) return fromCatalog;
  if (xUsername) return `https://x.com/${xUsername}`;
  return undefined;
}

export function buildDeploymentFeedEvent(row: FeedRow): DeploymentFeedEvent {
  const addr = tokenLowerHex(row.tokenAddress);
  const chain = (row.chain || 'robinhood').trim().toLowerCase();
  const dexNetwork = chain === 'robinhood' ? 'robinhood' : chain;
  const xUsername = row.requesterXUsername ?? resolveRequesterXUsername(row);
  const websiteUrl = optionalUrl(row.tokenWebsiteUrl);
  const xUrl = resolveXUrl(row, xUsername);
  const factory = resolveDeploymentFactoryInfo(row);

  return {
    id: row.id,
    createdAt: row.createdAt,
    platform: row.platform,
    chain,
    tokenName: row.tokenName,
    tokenSymbol: row.tokenSymbol.replace(/^\$/, ''),
    tokenAddress: row.tokenAddress,
    poolId: row.poolId?.trim() || undefined,
    factory,
    factoryAddress: factory.address,
    transactionHash: row.transactionHash,
    blockNumber: row.blockNumber,
    sourceUrl: optionalUrl(row.sourceUrl),
    clientKind: row.clientKind?.trim() || undefined,
    feeToSelf: row.feeToSelf,
    metadata: {
      description: row.tokenDescription?.trim() || undefined,
      imageUrl: row.tokenImageUrl?.trim() || undefined,
      bannerUrl: row.tokenBannerUrl?.trim() || undefined,
      websiteUrl,
      xUrl,
      xUsername,
    },
    deployer: {
      label: row.deployerLabel?.trim() || '—',
      xUsername,
      xLaunchCount: row.requesterXLaunchCount,
      walletAddress: row.deployerWalletAddress,
    },
    feeRecipient: {
      address: row.feeRecipientAddress,
      label: row.feeRecipientLabel?.trim() || undefined,
    },
    links: {
      tokenPage: hoodmarketsTokenUrl(row.tokenAddress),
      dexscreener: `https://dexscreener.com/${dexNetwork}/${addr}`,
      explorerToken: `https://robinhoodchain.blockscout.com/token/${addr}`,
      explorerTx: `https://robinhoodchain.blockscout.com/tx/${row.transactionHash}`,
      uniswap: `https://app.uniswap.org/swap?chain=robinhood&outputCurrency=${row.tokenAddress}`,
      ...(websiteUrl ? { website: websiteUrl } : {}),
      ...(xUrl ? { x: xUrl } : {}),
    },
  };
}
