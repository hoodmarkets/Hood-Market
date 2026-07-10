import { parseEther } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { config } from '../config.js';

export const PETITION_GOAL_UNITS = 1000;
export const PETITION_OPEN_DURATION_HOURS = 24;
export const HOOD_CLAIM_RESERVE_UNITS = 1;

/** @deprecated fixed unit price removed — contributions are ETH toward target raise */
export const PETITION_PRICE_WEI = parseEther('0.00001');
export const PETITION_PRICE_ETH = '0.00001';

/** @deprecated use PETITION_MAX_CONTRIBUTION_ETH in petitionEthGoal.ts */
export const PETITION_MAX_LAUNCH_BUY_ETH = parseEther('10');

export function petitionOpenDurationMs(): number {
  const raw = process.env.PETITION_OPEN_DURATION_HOURS;
  const hours = raw ? Number.parseInt(raw, 10) : PETITION_OPEN_DURATION_HOURS;
  if (!Number.isFinite(hours) || hours < 1) return PETITION_OPEN_DURATION_HOURS * 60 * 60 * 1000;
  return hours * 60 * 60 * 1000;
}

export function petitionEscrowAddress(): `0x${string}` | null {
  try {
    return privateKeyToAccount(config.deployerPrivateKey).address;
  } catch {
    return null;
  }
}

export function petitionEscrowConfigured(): boolean {
  return Boolean(petitionEscrowAddress() && config.chainRpcUrl);
}

export function hoodClaimWallet(): `0x${string}` | undefined {
  const raw = process.env.PETITION_HOOD_CLAIM_WALLET?.trim() || config.platformFeeRecipient?.trim();
  if (!raw) return undefined;
  try {
    return raw as `0x${string}`;
  } catch {
    return undefined;
  }
}

/** Backer sends exactly this ETH contribution to escrow. */
export function requiredDepositWei(contributionWei: bigint): bigint {
  return contributionWei;
}
