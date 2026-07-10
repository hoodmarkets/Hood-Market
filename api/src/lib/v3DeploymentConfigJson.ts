import type { HoodMarketsV3DeploymentConfig } from './hoodmarketsV3Deploy.js';
import { getAddress, type Address } from 'viem';

export type SerializedV3DeploymentConfig = {
  tokenConfig: {
    name: string;
    symbol: string;
    salt: `0x${string}`;
    image: string;
    metadata: string;
    context: string;
    originatingChainId: string;
  };
  vaultConfig: {
    vaultPercentage: number;
    vaultDuration: string;
  };
  poolConfig: {
    pairedToken: `0x${string}`;
    tickIfToken0IsNewToken: number;
  };
  initialBuyConfig: {
    pairedTokenPoolFee: number;
    pairedTokenSwapAmountOutMinimum: string;
  };
  rewardsConfig: {
    creatorReward: string;
    creatorAdmin: `0x${string}`;
    creatorRewardRecipient: `0x${string}`;
    interfaceAdmin: `0x${string}`;
    interfaceRewardRecipient: `0x${string}`;
  };
  fractionConfig: {
    buyerRewardShareCount: number;
  };
};

export function serializeV3DeploymentConfig(
  config: HoodMarketsV3DeploymentConfig,
): SerializedV3DeploymentConfig {
  return {
    tokenConfig: {
      name: config.tokenConfig.name,
      symbol: config.tokenConfig.symbol,
      salt: config.tokenConfig.salt,
      image: config.tokenConfig.image,
      metadata: config.tokenConfig.metadata,
      context: config.tokenConfig.context,
      originatingChainId: config.tokenConfig.originatingChainId.toString(),
    },
    vaultConfig: {
      vaultPercentage: config.vaultConfig.vaultPercentage,
      vaultDuration: config.vaultConfig.vaultDuration.toString(),
    },
    poolConfig: {
      pairedToken: config.poolConfig.pairedToken,
      tickIfToken0IsNewToken: config.poolConfig.tickIfToken0IsNewToken,
    },
    initialBuyConfig: {
      pairedTokenPoolFee: config.initialBuyConfig.pairedTokenPoolFee,
      pairedTokenSwapAmountOutMinimum:
        config.initialBuyConfig.pairedTokenSwapAmountOutMinimum.toString(),
    },
    rewardsConfig: {
      creatorReward: config.rewardsConfig.creatorReward.toString(),
      creatorAdmin: config.rewardsConfig.creatorAdmin,
      creatorRewardRecipient: config.rewardsConfig.creatorRewardRecipient,
      interfaceAdmin: config.rewardsConfig.interfaceAdmin,
      interfaceRewardRecipient: config.rewardsConfig.interfaceRewardRecipient,
    },
    fractionConfig: {
      buyerRewardShareCount: config.fractionConfig.buyerRewardShareCount,
    },
  };
}

export function deserializeV3DeploymentConfig(
  raw: SerializedV3DeploymentConfig,
): HoodMarketsV3DeploymentConfig {
  return {
    tokenConfig: {
      name: raw.tokenConfig.name,
      symbol: raw.tokenConfig.symbol,
      salt: raw.tokenConfig.salt,
      image: raw.tokenConfig.image,
      metadata: raw.tokenConfig.metadata,
      context: raw.tokenConfig.context,
      originatingChainId: BigInt(raw.tokenConfig.originatingChainId),
    },
    vaultConfig: {
      vaultPercentage: raw.vaultConfig.vaultPercentage,
      vaultDuration: BigInt(raw.vaultConfig.vaultDuration),
    },
    poolConfig: {
      pairedToken: getAddress(raw.poolConfig.pairedToken),
      tickIfToken0IsNewToken: raw.poolConfig.tickIfToken0IsNewToken,
    },
    initialBuyConfig: {
      pairedTokenPoolFee: raw.initialBuyConfig.pairedTokenPoolFee,
      pairedTokenSwapAmountOutMinimum: BigInt(raw.initialBuyConfig.pairedTokenSwapAmountOutMinimum),
    },
    rewardsConfig: {
      creatorReward: BigInt(raw.rewardsConfig.creatorReward),
      creatorAdmin: getAddress(raw.rewardsConfig.creatorAdmin),
      creatorRewardRecipient: getAddress(raw.rewardsConfig.creatorRewardRecipient),
      interfaceAdmin: getAddress(raw.rewardsConfig.interfaceAdmin),
      interfaceRewardRecipient: getAddress(raw.rewardsConfig.interfaceRewardRecipient),
    },
    fractionConfig: {
      buyerRewardShareCount: raw.fractionConfig?.buyerRewardShareCount ?? 0,
    },
  };
}

export function v3DeploymentConfigRewardRecipient(
  config: SerializedV3DeploymentConfig | HoodMarketsV3DeploymentConfig,
): `0x${string}` {
  const recipient =
    'rewardsConfig' in config && typeof config.rewardsConfig.creatorRewardRecipient === 'string'
      ? config.rewardsConfig.creatorRewardRecipient
      : (config as HoodMarketsV3DeploymentConfig).rewardsConfig.creatorRewardRecipient;
  return recipient as `0x${string}`;
}
