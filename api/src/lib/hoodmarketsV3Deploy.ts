import { randomBytes } from 'node:crypto';
import {
  decodeEventLog,
  getAddress,
  keccak256,
  toHex,
  type Address,
  type Hex,
  type PublicClient,
  type WalletClient,
} from 'viem';
import { HOODMARKETS_V3_ABI } from './hoodmarketsV3Abi.js';
import { logger } from '../logger.js';
import { ROBINHOOD_CHAIN_ID, ROBINHOOD_WETH } from './robinhoodChain.js';
import {
  bruteForceVanitySalt,
  resolveVanityAddressSuffix,
} from './vanitySalt.js';
import {
  buildHoodMarketsV3DeployBytecode,
  mineVanitySaltsLocal,
  predictHoodMarketsV3TokenAddressWithBytecodeHash,
  vanityParamsFromDeploymentConfig,
} from './hoodmarketsV3Create2.js';

import { DEFAULT_LAUNCH_TICK } from './launchDefaults.js';
const POOL_FEE = 10_000; // 1%

export type HoodMarketsV3DeployInput = {
  factory: Address;
  name: string;
  symbol: string;
  tokenAdmin: Address;
  image: string;
  metadata: string;
  context: string;
  /** ETH attached to `deployToken` for optional initial buy (wei). */
  devBuyAmount: bigint;
  /** Rate-limit excess: route the creator share (95%) to the platform wallet on-chain. */
  feesToPlatformOnly?: boolean;
  platformFeeRecipient?: Address;
  buyerRewardShareCount?: number;
};

export type HoodMarketsV3DeployResult = {
  tokenAddress: Address;
  positionId: bigint;
  fractionCollection?: Address;
  fractionVaultAmount?: bigint;
  poolId: string;
  transactionHash: Hex;
  blockNumber: bigint;
};

export function assertHoodMarketsV3Factory(factory: string | undefined): Address {
  if (!factory?.trim()) {
    throw new Error(
      'HOODMARKETS_V3_FACTORY is not set — deploy HoodMarkets V3 on Robinhood first (10_DeployHoodMarketsV3.s.sol).',
    );
  }
  return getAddress(factory.trim());
}

export type HoodMarketsV3DeploymentConfig = {
  tokenConfig: {
    name: string;
    symbol: string;
    salt: Hex;
    image: string;
    metadata: string;
    context: string;
    originatingChainId: bigint;
  };
  vaultConfig: {
    vaultPercentage: number;
    vaultDuration: bigint;
  };
  poolConfig: {
    pairedToken: Address;
    tickIfToken0IsNewToken: number;
  };
  initialBuyConfig: {
    pairedTokenPoolFee: number;
    pairedTokenSwapAmountOutMinimum: bigint;
  };
  rewardsConfig: {
    creatorReward: bigint;
    creatorAdmin: Address;
    creatorRewardRecipient: Address;
    interfaceAdmin: Address;
    interfaceRewardRecipient: Address;
  };
  fractionConfig: {
    buyerRewardShareCount: number;
  };
};

export function clampBuyerRewardShareCount(value: unknown): number {
  const n = typeof value === 'number' ? value : Number.parseInt(String(value ?? '0'), 10);
  if (!Number.isFinite(n) || n <= 0) return 0;
  if (n > 1000) return 1000;
  return Math.floor(n);
}

/** Shares escrowed at launch when caller sets `buyerRewardShareCount` (default 0). */
export function defaultBuyerRewardShareCount(): number {
  return 0;
}

export function buildHoodMarketsV3DeploymentConfig(input: {
  name: string;
  symbol: string;
  tokenAdmin: Address;
  image: string;
  metadata: string;
  context: string;
  feesToPlatformOnly?: boolean;
  platformFeeRecipient?: Address;
  buyerRewardShareCount?: number;
  /** Pre-mined CREATE2 salt; when omitted a random salt is used (or vanity-mined at deploy). */
  salt?: Hex;
}): HoodMarketsV3DeploymentConfig {
  const salt = input.salt ?? keccak256(toHex(randomBytes(32)));
  const tokenAdmin = getAddress(input.tokenAdmin);
  /** Fee recipient admin; receives all 1,000 fraction shares at launch. On v0.5+, swap fees
   *  route to the fraction contract pro-rata unless feesToPlatformOnly overrides recipient. */
  const creatorRewardRecipient =
    input.feesToPlatformOnly && input.platformFeeRecipient
      ? getAddress(input.platformFeeRecipient)
      : tokenAdmin;

  return {
    tokenConfig: {
      name: input.name,
      symbol: input.symbol,
      salt,
      image: input.image,
      metadata: input.metadata,
      context: input.context,
      originatingChainId: BigInt(ROBINHOOD_CHAIN_ID),
    },
    vaultConfig: {
      /** Always zero — v0.4+ embeds mandatory 10% / 1000-share fractions in the factory. */
      vaultPercentage: 0,
      vaultDuration: 0n,
    },
    poolConfig: {
      pairedToken: ROBINHOOD_WETH,
      tickIfToken0IsNewToken: DEFAULT_LAUNCH_TICK,
    },
    initialBuyConfig: {
      pairedTokenPoolFee: POOL_FEE,
      pairedTokenSwapAmountOutMinimum: 0n,
    },
    rewardsConfig: {
      /** 95% of swap fees to creator; 5% platform is fixed in HoodMarketsV3LpLocker. */
      creatorReward: 95n,
      creatorAdmin: tokenAdmin,
      creatorRewardRecipient,
      interfaceAdmin: tokenAdmin,
      interfaceRewardRecipient: '0x0000000000000000000000000000000000000000' as Address,
    },
    fractionConfig: {
      buyerRewardShareCount:
        input.buyerRewardShareCount !== undefined
          ? clampBuyerRewardShareCount(input.buyerRewardShareCount)
          : defaultBuyerRewardShareCount(),
    },
  };
}

function buildDeploymentConfig(input: HoodMarketsV3DeployInput, salt?: Hex) {
  return buildHoodMarketsV3DeploymentConfig({
    name: input.name,
    symbol: input.symbol,
    tokenAdmin: getAddress(input.tokenAdmin),
    image: input.image,
    metadata: input.metadata,
    context: input.context,
    feesToPlatformOnly: input.feesToPlatformOnly,
    platformFeeRecipient: input.platformFeeRecipient,
    buyerRewardShareCount: input.buyerRewardShareCount,
    salt,
  });
}

const V3_DEPLOY_SIM_GAS = 18_000_000n;

export async function mineHoodMarketsV3VanitySalt(
  publicClient: PublicClient,
  account: Address,
  factory: Address,
  deploymentConfig: HoodMarketsV3DeploymentConfig,
  devBuyAmount: bigint,
  suffix: string,
): Promise<Hex> {
  const params = vanityParamsFromDeploymentConfig(factory, deploymentConfig);
  const deployBytecode = buildHoodMarketsV3DeployBytecode(params);
  const deployBytecodeHash = keccak256(deployBytecode);
  const predict = (tokenSalt: Hex) =>
    predictHoodMarketsV3TokenAddressWithBytecodeHash(
      params.factory,
      params.admin,
      tokenSalt,
      deployBytecodeHash,
    );

  try {
    const mined = mineVanitySaltsLocal(predict, suffix, { count: 1 });
    return mined.primary;
  } catch (localErr) {
    logger.warn('Local vanity mining failed; falling back to RPC simulate', {
      suffix,
      error: localErr instanceof Error ? localErr.message : String(localErr),
    });
  }

  return bruteForceVanitySalt(suffix, async (candidate) => {
    const configWithSalt: HoodMarketsV3DeploymentConfig = {
      ...deploymentConfig,
      tokenConfig: { ...deploymentConfig.tokenConfig, salt: candidate },
    };
    try {
      const { result } = await publicClient.simulateContract({
        address: factory,
        abi: HOODMARKETS_V3_ABI,
        functionName: 'deployToken',
        args: [configWithSalt],
        account,
        value: devBuyAmount,
        gas: V3_DEPLOY_SIM_GAS,
      });
      const [tokenAddress] = result as readonly [Address, bigint];
      const addr = getAddress(tokenAddress);
      return addr.toLowerCase().endsWith(suffix) ? addr : null;
    } catch {
      return null;
    }
  });
}

export async function buildHoodMarketsV3DeploymentConfigWithVanity(
  publicClient: PublicClient,
  account: Address,
  factory: Address,
  input: HoodMarketsV3DeployInput,
): Promise<HoodMarketsV3DeploymentConfig> {
  const base = buildDeploymentConfig(input);
  const suffix = resolveVanityAddressSuffix();
  if (!suffix) return base;

  const mined = await mineHoodMarketsV3VanitySalt(
    publicClient,
    account,
    factory,
    base,
    input.devBuyAmount,
    suffix,
  );
  return {
    ...base,
    tokenConfig: { ...base.tokenConfig, salt: mined },
  };
}

const HOODMARKETS_V3_TOKEN_CREATED_TOPIC_V031 =
  '0x6b04d68ca5c822b9c981d731c83ecb1356b96c8596c7659d397d234856a4537b' as const;

export type HoodMarketsV3TokenCreated = {
  tokenAddress: Address;
  positionId: bigint;
  fractionCollection?: Address;
  fractionVaultAmount?: bigint;
};

function parseTokenCreatedLogFallback(log: {
  topics: readonly Hex[];
  data: Hex;
}): HoodMarketsV3TokenCreated | null {
  if (log.topics[0]?.toLowerCase() !== HOODMARKETS_V3_TOKEN_CREATED_TOPIC_V031) return null;
  const tokenTopic = log.topics[1];
  if (!tokenTopic) return null;
  const tokenAddress = getAddress(`0x${tokenTopic.slice(-40)}`);
  const dataHex = log.data.startsWith('0x') ? log.data.slice(2) : log.data;
  // Non-indexed head: creatorRewardRecipient, interfaceRewardRecipient, positionId (3 words).
  if (dataHex.length < 192) return null;
  const positionId = BigInt(`0x${dataHex.slice(128, 192)}`);
  return { tokenAddress, positionId };
}

export function parseHoodMarketsV3TokenCreatedFromReceipt(
  receipt: { logs: { address: string; data: Hex; topics: readonly Hex[] }[] },
  factory: Address,
): HoodMarketsV3TokenCreated {
  const factoryLower = factory.toLowerCase();
  for (const log of receipt.logs) {
    if (log.address.toLowerCase() !== factoryLower) continue;

    try {
      const decoded = decodeEventLog({
        abi: HOODMARKETS_V3_ABI,
        data: log.data,
        topics: log.topics as [Hex, ...Hex[]],
      });
      if (decoded.eventName === 'TokenCreated') {
        const args = decoded.args as {
          tokenAddress: Address;
          positionId: bigint;
          fractionCollection?: Address;
          fractionVaultAmount?: bigint;
        };
        return {
          tokenAddress: args.tokenAddress,
          positionId: args.positionId,
          fractionCollection: args.fractionCollection
            ? getAddress(args.fractionCollection)
            : undefined,
          fractionVaultAmount: args.fractionVaultAmount,
        };
      }
    } catch {
      // try legacy topic fallback for v0.3.1 factory receipts
    }

    const fallback = parseTokenCreatedLogFallback(log);
    if (fallback) return fallback;
  }
  throw new Error('TokenCreated event not found in transaction receipt');
}

export async function deployHoodMarketsV3Token(
  publicClient: PublicClient,
  walletClient: WalletClient,
  input: HoodMarketsV3DeployInput,
): Promise<HoodMarketsV3DeployResult> {
  const factory = getAddress(input.factory);
  const account = walletClient.account;
  if (!account) {
    throw new Error('Wallet client has no account');
  }

  const deploymentConfig = await buildHoodMarketsV3DeploymentConfigWithVanity(
    publicClient,
    account.address,
    factory,
    input,
  );

  const writeParams = {
    address: factory,
    abi: HOODMARKETS_V3_ABI,
    functionName: 'deployToken' as const,
    args: [deploymentConfig] as const,
    value: input.devBuyAmount,
    account,
  };

  /** V3 deploy + pool mint + LP lock + embedded 1000-share fraction vault + initial buy. */
  let gasLimit = 18_000_000n;
  try {
    const estimated = await publicClient.estimateContractGas(writeParams);
    gasLimit = estimated + estimated / 4n;
    if (gasLimit < 14_000_000n) gasLimit = 14_000_000n;
    if (gasLimit > 24_000_000n) gasLimit = 24_000_000n;
  } catch {
    gasLimit = 18_000_000n;
  }

  const hash = await walletClient.writeContract({
    ...writeParams,
    chain: walletClient.chain,
    gas: gasLimit,
  });

  const receipt = await publicClient.waitForTransactionReceipt({ hash });
  if (receipt.status !== 'success') {
    const used = receipt.gasUsed;
    const likelyOog = used >= (gasLimit * 95n) / 100n;
    throw new Error(
      likelyOog
        ? `HoodMarkets V3 deploy ran out of gas (used ${used} / limit ${gasLimit}). Tx: ${hash}`
        : `HoodMarkets V3 deploy reverted on-chain. Tx: ${hash}`,
    );
  }

  let tokenAddress: Address | undefined;
  let positionId: bigint | undefined;
  let fractionCollection: Address | undefined;
  let fractionVaultAmount: bigint | undefined;

  try {
    const created = parseHoodMarketsV3TokenCreatedFromReceipt(receipt, factory);
    tokenAddress = created.tokenAddress;
    positionId = created.positionId;
    fractionCollection = created.fractionCollection;
    fractionVaultAmount = created.fractionVaultAmount;
  } catch {
    tokenAddress = undefined;
    positionId = undefined;
  }

  if (!tokenAddress || positionId === undefined) {
    throw new Error(`TokenCreated event not found in tx ${hash}`);
  }

  return {
    tokenAddress,
    positionId,
    fractionCollection,
    fractionVaultAmount,
    poolId: `v3:${positionId.toString()}`,
    transactionHash: hash,
    blockNumber: receipt.blockNumber,
  };
}
