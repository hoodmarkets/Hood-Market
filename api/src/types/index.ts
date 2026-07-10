export interface TokenConfig {
  name: string;
  symbol: string;
  devBuyAmount: bigint; // in wei
  hookType: 'dynamic' | 'static';
  initialPrice?: bigint;
  metadata?: {
    description?: string;
    image?: string;
    website?: string;
    twitter?: string;
    telegram?: string;
  };
  extensions?: {
    vesting?: VestingConfig;
    airdrop?: AirdropConfig;
    devBuy?: DevBuyConfig;
    presale?: PresaleConfig;
  };
}

export interface VestingConfig {
  amount: bigint;
  startTime: number;
  endTime: number;
  recipient: string;
}

export interface AirdropConfig {
  merkleRoot: string;
  totalAmount: bigint;
}

export interface DevBuyConfig {
  ethAmount: bigint;
  minTokensExpected: bigint;
}

export interface PresaleConfig {
  allowlistMerkleRoot: string;
  ethCap: bigint;
  tokenAllocation: bigint;
}

export interface DeploymentResult {
  tokenAddress: string;
  poolId: string;
  transactionHash: string;
  blockNumber: bigint;
  hookAddress: string;
  lpLockerAddress: string;
  timestamp: number;
}

export interface UserWallet {
  userId: string;
  platform: Platform;
  address: string;
  privateKeyEncrypted: string;
  createdAt: number;
  lastUsedAt: number;
}

export interface DeploymentRecord {
  id: string;
  userId: string;
  platform: Platform;
  tokenConfig: TokenConfig;
  result: DeploymentResult;
  status: 'pending' | 'success' | 'failed';
  error?: string;
  createdAt: number;
}

export type Platform = 'telegram' | 'discord' | 'farcaster' | 'x';

export interface PlatformMessage {
  platform: Platform;
  userId: string;
  username: string;
  text: string;
  messageId: string;
  replyToMessageId?: string;
  timestamp: number;
}

export interface CommandContext {
  platform: Platform;
  userId: string;
  username: string;
  messageId: string;
  reply: (text: string, options?: { buttons?: any[] }) => Promise<void>;
  getWallet: () => Promise<UserWallet | null>;
  createWallet: () => Promise<UserWallet>;
}

export interface SniperConfig {
  targetTokens: string[];
  maxGasPrice: bigint;
  maxSlippage: number; // in bps
  buyAmount: bigint;
  takeProfit?: number; // percentage
  stopLoss?: number; // percentage
}

export interface LaunchEvent {
  tokenAddress: string;
  name: string;
  symbol: string;
  timestamp: number;
  blockNumber: number;
  devBuyAmount: bigint;
  hookType: string;
  score: LaunchScore;
}

export interface LaunchScore {
  total: number;
  devBuyScore: number;
  vestingScore: number;
  liquidityScore: number;
  metadataScore: number;
}
