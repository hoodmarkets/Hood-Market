import {
  getAddress,
  isAddress,
  type Address,
  type Hash,
  type PublicClient,
} from 'viem';
import { config } from '../config.js';
import { robinhood } from './robinhoodChain.js';
import {
  assertValidTokenAdmin,
  buildDeploymentConfig,
  deployTokenGasLimitWithValue,
  parseTokenCreatedFromReceipt,
} from './liquidFactoryDeploy.js';
import {
  deploymentConfigMsgValueWei,
  deserializeDeploymentConfig,
  serializeDeploymentConfig,
  type SerializedDeploymentConfig,
} from './deploymentConfigJson.js';
import { buildWebDeployArtifacts } from './webDeployArtifacts.js';

export type WebWalletDeployPrepareInput = {
  name: string;
  symbol: string;
  tokenAdmin: string;
  devBuyAmount: bigint;
  description?: string;
  imageUrl?: string;
  websiteUrl?: string;
  xUrl?: string;
  feesToPlatformOnly?: boolean;
  platform?: string;
  clientKind?: 'web' | 'agent';
};

export type WebWalletDeployPrepareResult = {
  mode: 'wallet';
  factoryKind: 'liquid-v4';
  factory: `0x${string}`;
  deploymentConfig: SerializedDeploymentConfig;
  msgValueWei: string;
  gas: string;
  chainId: number;
  imageUrl: string;
};

export async function buildWebWalletDeployPrepare(
  input: WebWalletDeployPrepareInput,
): Promise<WebWalletDeployPrepareResult> {
  if (input.devBuyAmount <= 0n) {
    throw new Error('Initial buy amount must be greater than 0 for wallet deploy.');
  }

  const tokenAdmin = assertValidTokenAdmin(input.tokenAdmin);
  const { image, metadata, context } = await buildWebDeployArtifacts({
    name: input.name,
    symbol: input.symbol,
    description: input.description,
    imageUrl: input.imageUrl,
    websiteUrl: input.websiteUrl,
    xUrl: input.xUrl,
    platform: input.platform,
    clientKind: input.clientKind,
  });

  const platformFeeRecipient = config.platformFeeRecipient || undefined;
  const platformFeeBps = input.feesToPlatformOnly ? 10000 : config.platformFeeBps;

  const deploymentConfig = buildDeploymentConfig(
    {
      factory: config.liquid.factory,
      hookStatic: config.liquid.hookStatic,
      hookDynamic: config.liquid.hookDynamic,
      lpLocker: config.liquid.lpLocker,
      name: input.name,
      symbol: input.symbol,
      tokenAdmin,
      hookType: 'static',
      image,
      metadata,
      context,
      devBuy: {
        ethAmount: input.devBuyAmount,
        recipient: tokenAdmin,
      },
      ...(input.feesToPlatformOnly ? { feesToPlatformOnly: true } : {}),
    },
    config.platformFeeRecipient || undefined,
    config.platformFeeBps,
  );

  const msgValue = deploymentConfigMsgValueWei(deploymentConfig);
  if (msgValue !== input.devBuyAmount) {
    throw new Error('Wallet deploy msg.value does not match initial buy amount.');
  }

  return {
    mode: 'wallet',
    factoryKind: 'liquid-v4',
    factory: config.liquid.factory,
    deploymentConfig: serializeDeploymentConfig(deploymentConfig),
    msgValueWei: msgValue.toString(),
    gas: deployTokenGasLimitWithValue().toString(),
    chainId: robinhood.id,
    imageUrl: image,
  };
}

export type WebWalletDeployCompleteInput = {
  transactionHash: string;
  expectedTokenAdmin: string;
  deploymentConfig: SerializedDeploymentConfig;
};

export type WebWalletDeployCompleteResult = {
  tokenAddress: `0x${string}`;
  poolId: `0x${string}`;
  transactionHash: `0x${string}`;
  blockNumber: bigint;
};

export async function completeWebWalletDeploy(
  publicClient: PublicClient,
  input: WebWalletDeployCompleteInput,
): Promise<WebWalletDeployCompleteResult> {
  const txHash = input.transactionHash.trim() as Hash;
  if (!/^0x[a-fA-F0-9]{64}$/.test(txHash)) {
    throw new Error('Invalid transaction hash.');
  }

  const expectedAdmin = getAddress(input.expectedTokenAdmin);
  const deploymentConfig = deserializeDeploymentConfig(input.deploymentConfig);
  if (getAddress(deploymentConfig.tokenConfig.tokenAdmin) !== expectedAdmin) {
    throw new Error('Deployment config token admin does not match fee wallet.');
  }

  const receipt = await publicClient.waitForTransactionReceipt({
    hash: txHash,
    timeout: 180_000,
  });

  if (receipt.status !== 'success') {
    throw new Error(
      `deployToken transaction reverted: ${txHash} (see https://robinhoodchain.blockscout.com/tx/${txHash})`,
    );
  }

  const created = parseTokenCreatedFromReceipt(receipt, config.liquid.factory);
  return {
    tokenAddress: created.tokenAddress,
    poolId: created.poolId,
    transactionHash: txHash,
    blockNumber: receipt.blockNumber,
  };
}

export function assertWalletDeploySenderMatches(
  transactionFrom: Address | undefined,
  expectedWallet: string,
): void {
  if (!transactionFrom || !isAddress(expectedWallet)) {
    throw new Error('Could not verify deploy transaction sender.');
  }
  if (getAddress(transactionFrom) !== getAddress(expectedWallet)) {
    throw new Error('Deploy transaction must be sent from your connected wallet.');
  }
}
