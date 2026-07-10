import {
  createPublicClient,
  createWalletClient,
  getAddress,
  http,
  type PublicClient,
  type WalletClient,
} from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { config } from './config.js';
import { buildWebDeployArtifacts } from './lib/webDeployArtifacts.js';
import {
  deployTokenOnchain,
  assertValidTokenAdmin,
} from './lib/liquidFactoryDeploy.js';
import {
  assertHoodMarketsV3Factory,
  deployHoodMarketsV3Token,
} from './lib/hoodmarketsV3Deploy.js';
import { recordDeploymentCatalog } from './lib/deploymentCatalog.js';
import { hoodmarketsTokenUrl, launcherAppLaunchesTokenUrl } from './lib/launcherAppUrl.js';
import type { DeployChain } from './lib/deployChain.js';
import { robinhood, robinhoodTokenUrl } from './lib/robinhoodChain.js';

export interface TokenDeploymentParams {
  name: string;
  symbol: string;
  description?: string;
  imageUrl?: string;
  walletAddress: string;
  /**
   * ETH (wei) for the Univ4EthDevBuy extension: launch-time swap into the new pool so explorers
   * show activity. Defaults match `DEPLOY_BOND_ETH` / `config.deployBondWei` (e.g. 0.05 ETH).
   * Set to 0 to skip (not recommended for visibility).
   */
  devBuyAmount: bigint;
  hookType: 'dynamic' | 'static';
  /** Platform username (Telegram, Discord, Farcaster, X handle) */
  username?: string;
  /** Platform source (telegram, discord, farcaster, x, web) */
  platform?: string;
  /**
   * Stable deployer id for indexing (Privy user id, Telegram/Discord id, Farcaster FID, X user id).
   */
  deployerId?: string;
  /** Human-readable label when `username` is not set or is generic (e.g. "Web"). */
  deployerLabel?: string;
  /** Warpcast cast URL, X post URL, etc. — stored in deployment catalog when set. */
  sourceUrl?: string;
  /** Web: short label for fee recipient (e.g. GitHub @user). */
  feeRecipientLabel?: string;
  /**
   * When true, trading fees go to the deployer’s own wallet (not burn, not a third party).
   * Used for Telegram forum “deployer & fee match” topic.
   */
  feeToSelf?: boolean;
  /** Privy DID when known — Eastern-day self-fee cap across linked logins. */
  privyUserId?: string;
  /** Web: automation / API agent deploy — stored in catalog for UI. */
  clientKind?: 'web' | 'agent';
  /** JSON string for agent-wallet deploy hints (provider, runtime, wallet). */
  agentMetadataJson?: string;
  /** `robinhood` (Liquid Protocol on Robinhood Chain). */
  chain?: DeployChain;
  /** Rate-limit excess: LP fees go 100% to platform wallet on-chain. */
  feesToPlatformOnly?: boolean;
  websiteUrl?: string;
  xUrl?: string;
  /** `simple` = HoodMarkets V3 (Uniswap V3). `pro` = HoodMarkets V4. */
  launchMode?: 'simple' | 'pro';
  /** First X unique pool buyers each receive 1 Holder NFT share (0–1000). Self-fee launches only. */
  buyerRewardShareCount?: number;
  /** User description for catalog UI (may differ from on-chain metadata text). */
  tokenDescription?: string;
  /** Catalog-only fee recipient when on-chain admin differs (e.g. petition launcher deploy). */
  catalogFeeRecipientAddress?: string;
}

export interface DeploymentResult {
  tokenAddress: string;
  poolId: string;
  transactionHash: string;
  blockNumber: bigint;
  timestamp: number;
  chain: DeployChain;
  /** Resolved public image URL stored on-chain (empty if none). */
  imageUrl?: string;
}

export interface TokenLinks {
  chain: DeployChain;
  /** Primary block explorer token URL */
  explorer: string;
  /** Alias for Base — on Ethereum duplicates `explorer` for backwards compatibility */
  basescan: string;
  etherscan?: string;
  dexscreener: string;
  uniswap: string;
  uniswapSwap: string;
  /** hoodmarkets token page */
  hoodmarkets: string;
  /** @deprecated use hoodmarkets — kept for older integrations */
  liquid: string;
  launcherApp: string;
  launcherInAppSwap: string;
}

export class LiquidDeployer {
  private publicClient: PublicClient;
  private walletClient: WalletClient;

  constructor() {
    this.publicClient = createPublicClient({
      chain: robinhood,
      transport: http(config.chainRpcUrl),
    }) as PublicClient;

    const account = privateKeyToAccount(config.deployerPrivateKey);

    this.walletClient = createWalletClient({
      account,
      chain: robinhood,
      transport: http(config.chainRpcUrl),
    }) as WalletClient;
  }

  async deployToken(params: TokenDeploymentParams): Promise<DeploymentResult> {
    const chain: DeployChain = params.chain ?? config.deployDefaultChain;

    const mock = process.env.MOCK_DEPLOY === 'true';
    if (mock) {
      await new Promise((resolve) => setTimeout(resolve, 2000));
      const mockResult: DeploymentResult = {
        tokenAddress: `0x${Array(40)
          .fill(0)
          .map(() => Math.floor(Math.random() * 16).toString(16))
          .join('')}`,
        poolId: `0x${Array(64)
          .fill(0)
          .map(() => Math.floor(Math.random() * 16).toString(16))
          .join('')}`,
        transactionHash: `0x${Array(64)
          .fill(0)
          .map(() => Math.floor(Math.random() * 16).toString(16))
          .join('')}`,
        blockNumber: BigInt(12345678),
        timestamp: Date.now(),
        chain,
      };
      console.warn(
        'MOCK_DEPLOY=true: returning fake addresses (no on-chain deployment).',
      );
      await recordDeploymentCatalog({
        platform: params.platform ?? 'unknown',
        deployerId: params.deployerId ?? '',
        deployerLabel: params.deployerLabel ?? params.username ?? '',
        feeRecipientAddress: params.walletAddress,
        feeRecipientLabel: params.feeRecipientLabel,
        tokenName: params.name,
        tokenSymbol: params.symbol,
        tokenAddress: mockResult.tokenAddress,
        poolId: mockResult.poolId,
        transactionHash: mockResult.transactionHash,
        blockNumber: mockResult.blockNumber,
        sourceUrl: params.sourceUrl,
        feeToSelf: params.feeToSelf,
        privyUserId: params.privyUserId,
        clientKind: params.clientKind,
        agentMetadataJson: params.agentMetadataJson,
        tokenDescription: params.tokenDescription?.trim() || undefined,
        chain,
      });
      return mockResult;
    }

    if (chain === 'ethereum') {
      throw new Error(
        'Ethereum deployments are disabled — this launcher deploys on Robinhood Chain (4663) only.',
      );
    }

    const tokenAdmin = assertValidTokenAdmin(params.walletAddress);

    const launchMode = params.launchMode ?? config.defaultLaunchMode;

    const { image, metadata, context } = await buildWebDeployArtifacts({
      name: params.name,
      symbol: params.symbol,
      description: params.description,
      imageUrl: params.imageUrl,
      websiteUrl: params.websiteUrl,
      xUrl: params.xUrl,
      platform: params.platform,
      clientKind: params.clientKind,
    });

    const onchain =
      launchMode === 'simple'
        ? await deployHoodMarketsV3Token(this.publicClient, this.walletClient, {
            factory: assertHoodMarketsV3Factory(config.hoodmarketsV3.factory),
            name: params.name,
            symbol: params.symbol,
            tokenAdmin,
            image,
            metadata,
            context,
            devBuyAmount: params.devBuyAmount,
            ...(params.feesToPlatformOnly && config.platformFeeRecipient
              ? {
                  feesToPlatformOnly: true,
                  platformFeeRecipient: config.platformFeeRecipient,
                }
              : {}),
            buyerRewardShareCount: params.buyerRewardShareCount,
          })
        : await deployTokenOnchain(
            this.publicClient,
            this.walletClient,
            {
              factory: config.liquid.factory,
              hookStatic: config.liquid.hookStatic,
              hookDynamic: config.liquid.hookDynamic,
              lpLocker: config.liquid.lpLocker,
              name: params.name,
              symbol: params.symbol,
              tokenAdmin,
              hookType: params.hookType,
              image,
              metadata,
              context,
              ...(params.devBuyAmount > 0n
                ? {
                    devBuy: {
                      ethAmount: params.devBuyAmount,
                      recipient: tokenAdmin,
                    },
                  }
                : {}),
              ...(params.feesToPlatformOnly ? { feesToPlatformOnly: true } : {}),
            },
            config.platformFeeRecipient || undefined,
            config.platformFeeBps,
          );

    console.log('Deployed:', onchain.tokenAddress, chain, launchMode);

    const result: DeploymentResult = {
      tokenAddress: onchain.tokenAddress,
      poolId: onchain.poolId,
      transactionHash: onchain.transactionHash,
      blockNumber: onchain.blockNumber,
      timestamp: Date.now(),
      chain,
      ...(image ? { imageUrl: image } : {}),
    };

    await recordDeploymentCatalog({
      platform: params.platform ?? 'unknown',
      deployerId: params.deployerId ?? '',
      deployerLabel: params.deployerLabel ?? params.username ?? '',
      feeRecipientAddress:
        params.feesToPlatformOnly && config.platformFeeRecipient
          ? config.platformFeeRecipient
          : params.catalogFeeRecipientAddress?.trim() || params.walletAddress,
      feeRecipientLabel: params.feeRecipientLabel,
      tokenName: params.name,
      tokenSymbol: params.symbol,
      tokenAddress: result.tokenAddress,
      poolId: result.poolId,
      transactionHash: result.transactionHash,
      blockNumber: result.blockNumber,
      sourceUrl: params.sourceUrl,
      feeToSelf: params.feeToSelf,
      privyUserId: params.privyUserId,
      clientKind: params.clientKind,
      agentMetadataJson: params.agentMetadataJson,
      tokenImageUrl: image || undefined,
      tokenWebsiteUrl: params.websiteUrl?.trim() || undefined,
      tokenXUrl: params.xUrl?.trim() || undefined,
      tokenDescription: params.tokenDescription?.trim() || undefined,
      chain,
      factoryAddress:
        launchMode === 'simple'
          ? config.hoodmarketsV3.factory
          : config.liquid.factory,
    });

    return result;
  }

  generateTokenLinks(tokenAddress: string, chain: DeployChain = 'robinhood'): TokenLinks {
    const addr = getAddress(tokenAddress as `0x${string}`);
    const hoodmarkets = hoodmarketsTokenUrl(addr);
    const launcherApp = launcherAppLaunchesTokenUrl(addr);
    const launcherInAppSwap = launcherAppLaunchesTokenUrl(addr, { openSwap: true });
    if (chain === 'ethereum') {
      const explorer = `https://etherscan.io/token/${addr}`;
      return {
        chain,
        explorer,
        basescan: explorer,
        etherscan: explorer,
        dexscreener: `https://dexscreener.com/ethereum/${addr}`,
        uniswap: `https://app.uniswap.org/explore/tokens/ethereum/${addr}`,
        uniswapSwap: `https://app.uniswap.org/swap?chain=ethereum&outputCurrency=${addr}`,
        hoodmarkets,
        liquid: hoodmarkets,
        launcherApp,
        launcherInAppSwap,
      };
    }
    if (chain === 'base') {
      return {
        chain,
        explorer: `https://basescan.org/token/${addr}`,
        basescan: `https://basescan.org/token/${addr}`,
        dexscreener: `https://dexscreener.com/base/${addr}`,
        uniswap: `https://app.uniswap.org/explore/tokens/base/${addr}`,
        uniswapSwap: `https://app.uniswap.org/swap?chain=base&outputCurrency=${addr}`,
        hoodmarkets,
        liquid: hoodmarkets,
        launcherApp,
        launcherInAppSwap,
      };
    }
    const explorer = robinhoodTokenUrl(addr);
    return {
      chain,
      explorer,
      basescan: explorer,
      dexscreener: `https://dexscreener.com/robinhood/${addr}`,
      uniswap: `https://app.uniswap.org/explore/tokens/robinhood/${addr}`,
      uniswapSwap: `https://app.uniswap.org/swap?chain=robinhood&outputCurrency=${addr}`,
      hoodmarkets,
      liquid: hoodmarkets,
      launcherApp,
      launcherInAppSwap,
    };
  }
}
