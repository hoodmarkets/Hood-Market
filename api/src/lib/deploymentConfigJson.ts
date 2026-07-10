/** JSON-safe deployment config for wallet-signed `deployToken` (BigInts as decimal strings). */

export type SerializedDeploymentConfig = {
  tokenConfig: {
    tokenAdmin: `0x${string}`;
    name: string;
    symbol: string;
    salt: `0x${string}`;
    image: string;
    metadata: string;
    context: string;
    originatingChainId: string;
  };
  poolConfig: {
    hook: `0x${string}`;
    pairedToken: `0x${string}`;
    tickIfToken0IsLiquid: number;
    tickSpacing: number;
    poolData: `0x${string}`;
  };
  lockerConfig: {
    locker: `0x${string}`;
    rewardAdmins: `0x${string}`[];
    rewardRecipients: `0x${string}`[];
    rewardBps: number[];
    tickLower: number[];
    tickUpper: number[];
    positionBps: number[];
    lockerData: `0x${string}`;
  };
  mevModuleConfig: {
    mevModule: `0x${string}`;
    mevModuleData: `0x${string}`;
  };
  extensionConfigs: {
    extension: `0x${string}`;
    msgValue: string;
    extensionBps: number;
    extensionData: `0x${string}`;
  }[];
};

type DeploymentConfig = {
  tokenConfig: {
    tokenAdmin: `0x${string}`;
    name: string;
    symbol: string;
    salt: `0x${string}`;
    image: string;
    metadata: string;
    context: string;
    originatingChainId: bigint;
  };
  poolConfig: {
    hook: `0x${string}`;
    pairedToken: `0x${string}`;
    tickIfToken0IsLiquid: number;
    tickSpacing: number;
    poolData: `0x${string}`;
  };
  lockerConfig: {
    locker: `0x${string}`;
    rewardAdmins: `0x${string}`[];
    rewardRecipients: `0x${string}`[];
    rewardBps: number[];
    tickLower: number[];
    tickUpper: number[];
    positionBps: number[];
    lockerData: `0x${string}`;
  };
  mevModuleConfig: {
    mevModule: `0x${string}`;
    mevModuleData: `0x${string}`;
  };
  extensionConfigs: {
    extension: `0x${string}`;
    msgValue: bigint;
    extensionBps: number;
    extensionData: `0x${string}`;
  }[];
};

export function serializeDeploymentConfig(cfg: DeploymentConfig): SerializedDeploymentConfig {
  return {
    tokenConfig: {
      ...cfg.tokenConfig,
      originatingChainId: cfg.tokenConfig.originatingChainId.toString(),
    },
    poolConfig: cfg.poolConfig,
    lockerConfig: cfg.lockerConfig,
    mevModuleConfig: cfg.mevModuleConfig,
    extensionConfigs: cfg.extensionConfigs.map((ext) => ({
      ...ext,
      msgValue: ext.msgValue.toString(),
    })),
  };
}

export function deserializeDeploymentConfig(cfg: SerializedDeploymentConfig): DeploymentConfig {
  return {
    tokenConfig: {
      ...cfg.tokenConfig,
      originatingChainId: BigInt(cfg.tokenConfig.originatingChainId),
    },
    poolConfig: cfg.poolConfig,
    lockerConfig: cfg.lockerConfig,
    mevModuleConfig: cfg.mevModuleConfig,
    extensionConfigs: cfg.extensionConfigs.map((ext) => ({
      ...ext,
      msgValue: BigInt(ext.msgValue),
    })),
  };
}

export function deploymentConfigMsgValueWei(cfg: DeploymentConfig): bigint {
  return cfg.extensionConfigs.reduce((sum, ext) => sum + ext.msgValue, 0n);
}
