import { randomBytes } from 'node:crypto';
import {
  decodeEventLog,
  encodeAbiParameters,
  getAddress,
  isAddress,
  toHex,
  type Address,
  type PublicClient,
  type WalletClient,
  type Hex,
} from 'viem';
import { LiquidFactoryAbi } from 'liquid-sdk';
import { config } from '../config.js';
import { buildLiquidDevBuyExtension } from './liquidDevBuyExtension.js';
import {
  bruteForceVanitySalt,
  resolveVanityAddressSuffix,
} from './vanitySalt.js';
import {
  CHAIN_WETH,
  ROBINHOOD_CHAIN_ID,
  ROBINHOOD_WETH,
  robinhood,
} from './robinhoodChain.js';
import {
  DEFAULT_LAUNCH_TICK,
  DEFAULT_STATIC_LAUNCH_TICK,
} from './launchDefaults.js';

/** Factory ABI — from `liquid-sdk` (correct `payable` typing for `deployToken` + `value`). */
export const LIQUID_FACTORY_ABI = LiquidFactoryAbi;

/** Robinhood WETH — alias `BASE_WETH` for legacy imports. */
export const BASE_WETH = ROBINHOOD_WETH;

export function liquidMevModule(): `0x${string}` {
  const addr = config.liquid.mevModule;
  if (!addr) {
    throw new Error(
      'LIQUID_SNIPER_AUCTION_V2 is not set — deploy Liquid Protocol on Robinhood first.',
    );
  }
  return addr;
}

/** `deployToken` + dev-buy extension can exceed 5M gas on Base; BaseScan shows OOG at exactly 5M. */
const DEFAULT_DEPLOY_TOKEN_GAS_WITH_VALUE = 12_000_000n;

export function deployTokenGasLimitWithValue(): bigint {
  const raw = process.env.DEPLOY_TOKEN_GAS?.trim();
  if (raw) {
    const n = BigInt(raw);
    if (n >= 3_000_000n) return n;
  }
  return DEFAULT_DEPLOY_TOKEN_GAS_WITH_VALUE;
}

/** LP locker feePreference array length must match rewardBps / rewardRecipients length. */
function buildLpLockerFeeConversionData(rewardParticipantCount: number): Hex {
  const feePreference = Array.from({ length: rewardParticipantCount }, () => 0);
  return encodeAbiParameters(
    [
      {
        type: 'tuple',
        components: [{ name: 'feePreference', type: 'uint8[]' }],
      },
    ],
    [{ feePreference }],
  );
}

/** MEV / anti-sniper swap fee curve baked into each new pool at deploy time. */
function buildMevModuleData(): Hex {
  const startingFee = Number(process.env.HOOD_MEV_STARTING_FEE?.trim() || '10000');
  const endingFee = Number(process.env.HOOD_MEV_ENDING_FEE?.trim() || '10000');
  const secondsToDecay = BigInt(process.env.HOOD_MEV_DECAY_SECONDS?.trim() || '1');
  return encodeAbiParameters(
    [
      {
        type: 'tuple',
        components: [
          { name: 'startingFee', type: 'uint24' },
          { name: 'endingFee', type: 'uint24' },
          { name: 'secondsToDecay', type: 'uint256' },
        ],
      },
    ],
    [{ startingFee, endingFee, secondsToDecay }],
  );
}

/** Presets decoded from real on-chain `deployToken` calls — only token/admin fields are substituted. */
const STATIC_PRESET = {
  poolConfig: {
    pairedToken: CHAIN_WETH,
    tickIfToken0IsLiquid: DEFAULT_STATIC_LAUNCH_TICK,
    tickSpacing: 200,
    poolData:
      '0x00000000000000000000000000000000000000000000000000000000000000200000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000006000000000000000000000000000000000000000000000000000000000000000800000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000004000000000000000000000000000000000000000000000000000000000000027100000000000000000000000000000000000000000000000000000000000002710' as Hex,
  },
  lockerConfig: {
    tickLower: [DEFAULT_STATIC_LAUNCH_TICK, -208400, -178400] as const,
    tickUpper: [-200400, -170400, -124400] as const,
    positionBps: [4000, 5000, 1000] as const,
    rewardBps: [8000, 2000] as const,
    lockerData:
      '0x00000000000000000000000000000000000000000000000000000000000000200000000000000000000000000000000000000000000000000000000000000020000000000000000000000000000000000000000000000000000000000000000200000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000' as Hex,
  },
} as const;

const DYNAMIC_PRESET = {
  poolConfig: {
    pairedToken: CHAIN_WETH,
    tickIfToken0IsLiquid: DEFAULT_LAUNCH_TICK,
    tickSpacing: 200,
    poolData:
      '0x0000000000000000000000000000000000000000000000000000000000000020000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000600000000000000000000000000000000000000000000000000000000000000080000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000e00000000000000000000000000000000000000000000000000000000000002710000000000000000000000000000000000000000000000000000000000000c35000000000000000000000000000000000000000000000000000000000000002580000000000000000000000000000000000000000000000000000000000000e1000000000000000000000000000000000000000000000000000000000000003e8000000000000000000000000000000000000000000000000000000000000c3500000000000000000000000000000000000000000000000000000000000001388' as Hex,
  },
  lockerConfig: {
    tickLower: [DEFAULT_LAUNCH_TICK, -224000, -210000, -163000, -149000] as const,
    tickUpper: [-216000, -155000, -155000, -120000, -120000] as const,
    positionBps: [1000, 5000, 1500, 2000, 500] as const,
    rewardBps: [10000] as const,
    lockerData:
      '0x0000000000000000000000000000000000000000000000000000000000000020000000000000000000000000000000000000000000000000000000000000002000000000000000000000000000000000000000000000000000000000000000010000000000000000000000000000000000000000000000000000000000000001' as Hex,
  },
} as const;

export type DeployTokenArgs = {
  factory: `0x${string}`;
  hookStatic: `0x${string}`;
  hookDynamic: `0x${string}`;
  lpLocker: `0x${string}`;
  name: string;
  symbol: string;
  tokenAdmin: `0x${string}`;
  hookType: 'dynamic' | 'static';
  image: string;
  metadata: string;
  context: string;
  /**
   * Optional launch-time ETH→token swap via Univ4EthDevBuy (same tx as deploy).
   * `recipient` is usually the token admin (fee wallet). Omit or zero wei to skip.
   */
  devBuy?: { ethAmount: bigint; recipient: `0x${string}` };
  /**
   * CREATE2 salt. When omitted, a random salt is used (or one mined to match
   * `VANITY_ADDRESS_SUFFIX` inside `deployTokenOnchain`).
   */
  salt?: Hex;
  /** Rate-limit excess: 100% of LP fees to platform recipient instead of token admin split. */
  feesToPlatformOnly?: boolean;
};

export type OnchainDeployResult = {
  tokenAddress: `0x${string}`;
  poolId: `0x${string}`;
  transactionHash: `0x${string}`;
  blockNumber: bigint;
};

export function buildDeploymentConfig(
  input: DeployTokenArgs,
  platformFeeRecipient?: `0x${string}`,
  platformFeeBps?: number
) {
  const hook =
    input.hookType === 'dynamic' ? input.hookDynamic : input.hookStatic;
  const preset = input.hookType === 'dynamic' ? DYNAMIC_PRESET : STATIC_PRESET;

  const salt = input.salt ?? toHex(randomBytes(32));

  const tokenAdmin = getAddress(input.tokenAdmin);

  // Determine reward recipients based on preset and platform fee
  const rewardAdmins: `0x${string}`[] = [];
  const rewardRecipients: `0x${string}`[] = [];
  const rewardBpsArr: number[] = [];

  if (input.feesToPlatformOnly) {
    if (!platformFeeRecipient) {
      throw new Error('Platform fee recipient required when feesToPlatformOnly is set');
    }
    const plat = getAddress(platformFeeRecipient);
    rewardRecipients.push(plat);
    rewardAdmins.push(plat);
    rewardBpsArr.push(10000);
  } else if (platformFeeRecipient && platformFeeBps && platformFeeBps > 0) {
    // With platform fee: 2 recipients (creator + platform), total 10000 BPS
    const creatorBps = 10000 - platformFeeBps;
    if (creatorBps < 0) {
      throw new Error(
        `Platform fee ${platformFeeBps} BPS exceeds max 10000 BPS`
      );
    }
    rewardRecipients.push(tokenAdmin, getAddress(platformFeeRecipient));
    rewardAdmins.push(tokenAdmin, getAddress(platformFeeRecipient));
    rewardBpsArr.push(creatorBps, platformFeeBps);
  } else {
    // Without platform fee: use preset as-is
    if (preset.lockerConfig.rewardBps.length === 2) {
      // Static preset: 2 recipients (8000/2000)
      rewardAdmins.push(tokenAdmin, tokenAdmin);
      rewardRecipients.push(tokenAdmin, tokenAdmin);
      rewardBpsArr.push(8000, 2000);
    } else {
      // Dynamic preset: 1 recipient (10000)
      rewardAdmins.push(tokenAdmin);
      rewardRecipients.push(tokenAdmin);
      rewardBpsArr.push(10000);
    }
  }

  return {
    tokenConfig: {
      tokenAdmin,
      name: input.name,
      symbol: input.symbol,
      salt,
      image: input.image,
      metadata: input.metadata,
      context: input.context,
      originatingChainId: BigInt(ROBINHOOD_CHAIN_ID),
    },
    poolConfig: {
      hook,
      pairedToken: preset.poolConfig.pairedToken,
      tickIfToken0IsLiquid: preset.poolConfig.tickIfToken0IsLiquid,
      tickSpacing: preset.poolConfig.tickSpacing,
      poolData: preset.poolConfig.poolData,
    },
    lockerConfig: {
      locker: input.lpLocker,
      rewardAdmins,
      rewardRecipients,
      rewardBps: rewardBpsArr,
      tickLower: [...preset.lockerConfig.tickLower],
      tickUpper: [...preset.lockerConfig.tickUpper],
      positionBps: [...preset.lockerConfig.positionBps],
      lockerData: buildLpLockerFeeConversionData(rewardBpsArr.length),
    },
    mevModuleConfig: {
      mevModule: liquidMevModule(),
      mevModuleData: buildMevModuleData(),
    },
    extensionConfigs: (() => {
      const eth = input.devBuy?.ethAmount ?? 0n;
      if (!input.devBuy || eth <= 0n) return [];
      return [
        buildLiquidDevBuyExtension(eth, getAddress(input.devBuy.recipient)),
      ];
    })(),
  };
}

export function assertValidTokenAdmin(address: string): `0x${string}` {
  if (!isAddress(address)) {
    throw new Error(
      `Invalid token admin address: ${address}. User must provide a valid 0x wallet.`
    );
  }
  return getAddress(address);
}

async function mineVanitySalt(
  publicClient: PublicClient,
  account: Address,
  input: DeployTokenArgs,
  platformFeeRecipient: `0x${string}` | undefined,
  platformFeeBps: number | undefined,
  suffix: string,
): Promise<Hex> {
  const simGas =
    deploymentConfigExtensionMsgValue(input, platformFeeRecipient, platformFeeBps) > 0n
      ? deployTokenGasLimitWithValue()
      : undefined;

  return bruteForceVanitySalt(suffix, async (candidate) => {
    const deploymentConfig = buildDeploymentConfig(
      { ...input, salt: candidate },
      platformFeeRecipient,
      platformFeeBps,
    );
    const msgValue = deploymentConfig.extensionConfigs.reduce(
      (sum, ext) => sum + ext.msgValue,
      0n,
    );
    try {
      const { result } = await publicClient.simulateContract({
        address: input.factory,
        abi: LIQUID_FACTORY_ABI,
        functionName: 'deployToken',
        args: [deploymentConfig],
        account,
        value: msgValue,
        ...(simGas !== undefined ? { gas: simGas } : {}),
      });
      const tokenAddress = getAddress(result as Address);
      return tokenAddress.toLowerCase().endsWith(suffix) ? tokenAddress : null;
    } catch {
      return null;
    }
  });
}

function deploymentConfigExtensionMsgValue(
  input: DeployTokenArgs,
  platformFeeRecipient?: `0x${string}`,
  platformFeeBps?: number
): bigint {
  const cfg = buildDeploymentConfig(input, platformFeeRecipient, platformFeeBps);
  return cfg.extensionConfigs.reduce((sum, ext) => sum + ext.msgValue, 0n);
}

export async function deployTokenOnchain(
  publicClient: PublicClient,
  walletClient: WalletClient,
  input: DeployTokenArgs,
  platformFeeRecipient?: `0x${string}`,
  platformFeeBps?: number
): Promise<OnchainDeployResult> {
  const account = walletClient.account;
  if (!account) throw new Error('WalletClient has no account');

  let deployInput: DeployTokenArgs = input;
  const vanitySuffix = resolveVanityAddressSuffix();
  if (vanitySuffix) {
    if (input.salt) {
      throw new Error(
        'Do not set salt manually when vanity addressing is enabled (salt is mined).',
      );
    }
    const mined = await mineVanitySalt(
      publicClient,
      account.address,
      input,
      platformFeeRecipient,
      platformFeeBps,
      vanitySuffix,
    );
    deployInput = { ...input, salt: mined };
  }

  const deploymentConfig = buildDeploymentConfig(
    deployInput,
    platformFeeRecipient,
    platformFeeBps
  );

  const msgValue = deploymentConfig.extensionConfigs.reduce(
    (sum, ext) => sum + ext.msgValue,
    0n
  );

  const hash = await walletClient.writeContract({
    chain: robinhood,
    account,
    address: input.factory,
    abi: LIQUID_FACTORY_ABI,
    functionName: 'deployToken',
    args: [deploymentConfig],
    value: msgValue,
    ...(msgValue > 0n ? { gas: deployTokenGasLimitWithValue() } : {}),
  });

  const receipt = await publicClient.waitForTransactionReceipt({
    hash,
    timeout: 180_000,
  });

  if (receipt.status !== 'success') {
    throw new Error(
      `deployToken transaction reverted: ${hash} (see https://robinhoodchain.blockscout.com/tx/${hash} — check revert reason; gas OOG only if gasUsed ≈ gas limit)`,
    );
  }

  const created = parseTokenCreatedFromReceipt(receipt, input.factory);
  return {
    ...created,
    transactionHash: hash,
    blockNumber: receipt.blockNumber,
  };
}

export function parseTokenCreatedFromReceipt(
  receipt: { logs: readonly { address: Address; data: Hex; topics: readonly Hex[] }[] },
  factory: Address,
): { tokenAddress: `0x${string}`; poolId: `0x${string}` } {
  const factoryHex = factory.toLowerCase();
  for (const log of receipt.logs) {
    if (log.address.toLowerCase() !== factoryHex) continue;
    try {
      const decoded = decodeEventLog({
        abi: LIQUID_FACTORY_ABI,
        data: log.data,
        topics: log.topics as [Hex, ...Hex[]],
      });
      if (decoded.eventName !== 'TokenCreated') continue;
      const args = decoded.args as {
        tokenAddress: `0x${string}`;
        poolId: `0x${string}`;
      };
      return {
        tokenAddress: getAddress(args.tokenAddress),
        poolId: args.poolId,
      };
    } catch {
      continue;
    }
  }

  throw new Error('TokenCreated event not found in transaction receipt.');
}
