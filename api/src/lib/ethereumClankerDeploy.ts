import { Clanker } from 'clanker-sdk/v4';
import { POOL_POSITIONS } from 'clanker-sdk';
import {
  formatEther,
  getAddress,
  isAddress,
  parseEventLogs,
  type Hex,
  type PublicClient,
  type WalletClient,
} from 'viem';
import { mainnet } from 'viem/chains';
import { config } from '../config.js';
import { CLANKER_V4_TOKEN_CREATED_ABI } from '../abi/clankerTokenCreated.js';
import { formatDeployError } from './formatDeployError.js';

/** Dynamic fee preset aligned with Clanker SDK valid ranges (Uniswap v4 hook). */
const ETH_DYNAMIC_FEES = {
  type: 'dynamic' as const,
  baseFee: 500,
  maxFee: 2500,
  referenceTickFilterPeriod: 30,
  resetPeriod: 340,
  resetTickFilter: 580,
  feeControlNumerator: 166,
  decayFilterBps: 9920,
};

/** Static hook fees (basis points × 100 for uni in SDK). */
const ETH_STATIC_FEES = {
  type: 'static' as const,
  clankerFee: 100,
  pairedFee: 100,
};

export interface EthereumClankerDeployArgs {
  name: string;
  symbol: string;
  description?: string;
  imageUrl?: string;
  walletAddress: string;
  hookType: 'dynamic' | 'static';
  devBuyAmount: bigint;
  liquidContextInterface: string;
}

export async function deployEthereumTokenViaClanker(
  publicClient: PublicClient,
  walletClient: WalletClient,
  args: EthereumClankerDeployArgs,
): Promise<{
  tokenAddress: string;
  poolId: Hex;
  transactionHash: Hex;
  blockNumber: bigint;
}> {
  const tokenAdmin = getAddress(args.walletAddress);

  let image = (args.imageUrl ?? '').trim();
  if (image.startsWith('data:')) image = '';

  const metadataObj: Record<string, string> = {
    description: args.description?.trim() || `${args.name} (${args.symbol})`,
  };

  const contextObj = {
    interface: args.liquidContextInterface,
    platform: config.liquidDeployContextPlatform,
  };

  const fees = args.hookType === 'dynamic' ? ETH_DYNAMIC_FEES : ETH_STATIC_FEES;

  let rewards:
    | {
        recipients: {
          admin: `0x${string}`;
          recipient: `0x${string}`;
          bps: number;
          token: 'Both';
        }[];
      }
    | undefined;

  const plat = config.platformFeeRecipient?.trim();
  const bps = config.platformFeeBps;
  if (plat && isAddress(plat) && bps > 0 && bps < 10000) {
    const p = getAddress(plat);
    rewards = {
      recipients: [
        {
          admin: tokenAdmin,
          recipient: tokenAdmin,
          bps: 10000 - bps,
          token: 'Both',
        },
        {
          admin: p,
          recipient: p,
          bps,
          token: 'Both',
        },
      ],
    };
  }

  const devEth =
    args.devBuyAmount > 0n ? Number(formatEther(args.devBuyAmount)) : 0;

  const tokenDeploy = {
    name: args.name.trim(),
    symbol: args.symbol.trim(),
    image,
    chainId: mainnet.id,
    ...(config.ethereum.clankerVanityAddresses ? { vanity: true as const } : {}),
    tokenAdmin,
    metadata: metadataObj,
    context: contextObj,
    pool: {
      pairedToken: 'WETH' as const,
      tickIfToken0IsClanker: -230400,
      tickSpacing: 200,
      positions: POOL_POSITIONS.Standard,
    },
    locker: { locker: 'Locker' as const },
    fees,
    ...(devEth > 0
      ? {
          devBuy: {
            ethAmount: devEth,
            amountOutMin: 0,
            recipient: tokenAdmin,
          },
        }
      : {}),
    ...(rewards ? { rewards } : {}),
  };

  if (!walletClient.account) {
    throw new Error('Ethereum deploy requires a funded deployer wallet account on Ethereum mainnet.');
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- Clanker's viem client generics are stricter than our dynamically built wallet client.
  const clanker = new Clanker({
    wallet: walletClient as any,
    publicClient,
  });

  let result: unknown;
  try {
    result = await clanker.deploy(tokenDeploy as Parameters<Clanker['deploy']>[0]);
  } catch (e: unknown) {
    throw new Error(`Ethereum deploy (before tx): ${formatDeployError(e)}`);
  }

  if (result && typeof result === 'object' && 'error' in result && result.error) {
    const raw = result.error;
    const detail = formatDeployError(raw);
    throw new Error(`Ethereum deploy failed: ${detail}`);
  }

  const { txHash, waitForTransaction } = result as {
    txHash: Hex;
    waitForTransaction: () => Promise<{ address?: string }>;
  };

  try {
    await waitForTransaction();
  } catch (e: unknown) {
    throw new Error(`Ethereum deploy (waitForTransaction): ${formatDeployError(e)}`);
  }

  let receipt;
  try {
    receipt = await publicClient.waitForTransactionReceipt({
      hash: txHash,
      timeout: 300_000,
    });
  } catch (e: unknown) {
    throw new Error(`Ethereum deploy (receipt): ${formatDeployError(e)} — tx ${txHash}`);
  }

  if (receipt.status !== 'success') {
    throw new Error(`Ethereum deploy tx reverted: ${txHash}`);
  }

  const decoded = parseEventLogs({
    abi: CLANKER_V4_TOKEN_CREATED_ABI,
    logs: receipt.logs,
    eventName: 'TokenCreated',
    strict: false,
  });

  const first = decoded[0];
  const tokenAddress = first?.args?.tokenAddress ?? (undefined as unknown);
  const poolId = first?.args?.poolId ?? ('0x' + '0'.repeat(64));

  if (!tokenAddress || typeof tokenAddress !== 'string') {
    throw new Error('TokenCreated event missing tokenAddress');
  }

  return {
    tokenAddress: getAddress(tokenAddress),
    poolId: poolId as Hex,
    transactionHash: txHash,
    blockNumber: receipt.blockNumber,
  };
}
