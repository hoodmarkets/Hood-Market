import { createPublicClient, erc20Abi, formatUnits, http, type Address } from 'viem';
import { config } from '../config.js';
import { robinhood } from './robinhoodChain.js';

export type HolderStatus = {
  holds: boolean;
  balance: string;
  balanceRaw: bigint;
  decimals: number;
};

export async function readTokenHolderStatus(
  tokenAddress: string,
  walletAddress: string,
): Promise<HolderStatus> {
  const token = tokenAddress as Address;
  const wallet = walletAddress as Address;
  const publicClient = createPublicClient({
    chain: robinhood,
    transport: http(config.chainRpcUrl),
  });

  let decimals = 18;
  try {
    decimals = Number(
      await publicClient.readContract({
        address: token,
        abi: erc20Abi,
        functionName: 'decimals',
      }),
    );
  } catch {
    decimals = 18;
  }

  const balanceRaw = await publicClient.readContract({
    address: token,
    abi: erc20Abi,
    functionName: 'balanceOf',
    args: [wallet],
  });

  return {
    holds: balanceRaw > 0n,
    balance: formatUnits(balanceRaw, decimals),
    balanceRaw,
    decimals,
  };
}
