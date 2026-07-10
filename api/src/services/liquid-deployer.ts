import { createPublicClient, getAddress, http, type PublicClient } from 'viem';
import { base } from 'viem/chains';
import { 
  TokenConfig, 
  DeploymentResult, 
  UserWallet,
  DeploymentRecord,
  Platform 
} from '../types';
import { config } from '../config/config';
import { Logger } from 'winston';
import { Database } from 'sqlite3';
import { randomUUID } from 'crypto';
import { launcherAppLaunchesTokenUrl } from '../lib/launcherAppUrl.js';

// ABI snippets for Liquid Protocol
const FACTORY_ABI = [
  {
    name: 'deployToken',
    type: 'function',
    stateMutability: 'payable',
    inputs: [
      { name: 'name', type: 'string' },
      { name: 'symbol', type: 'string' },
      { name: 'hookType', type: 'uint8' }, // 0 = dynamic, 1 = static
      { name: 'devBuyAmount', type: 'uint256' },
      { name: 'extensions', type: 'address[]' },
      { name: 'extensionData', type: 'bytes[]' },
    ],
    outputs: [
      { name: 'token', type: 'address' },
      { name: 'poolId', type: 'bytes32' },
    ],
  },
] as const;

export class LiquidDeployer {
  private publicClient: PublicClient;
  private logger: Logger;
  private db: Database;

  constructor(db: Database, logger: Logger) {
    this.db = db;
    this.logger = logger;
    
    this.publicClient = createPublicClient({
      chain: base,
      transport: http(config.rpcUrl),
    }) as PublicClient;
    
    this.initDatabase();
  }

  private initDatabase(): void {
    this.db.run(`
      CREATE TABLE IF NOT EXISTS deployments (
        id TEXT PRIMARY KEY,
        user_id TEXT NOT NULL,
        platform TEXT NOT NULL,
        token_name TEXT NOT NULL,
        token_symbol TEXT NOT NULL,
        token_address TEXT,
        pool_id TEXT,
        transaction_hash TEXT,
        block_number INTEGER,
        hook_address TEXT,
        lp_locker_address TEXT,
        status TEXT NOT NULL,
        error TEXT,
        created_at INTEGER NOT NULL,
        config_json TEXT NOT NULL
      )
    `);
    
    this.db.run(`
      CREATE INDEX IF NOT EXISTS idx_deployments_user ON deployments(user_id)
    `);
    
    this.db.run(`
      CREATE INDEX IF NOT EXISTS idx_deployments_status ON deployments(status)
    `);
  }

  async deployToken(
    userWallet: UserWallet,
    walletClient: any,
    tokenConfig: TokenConfig,
    platform: Platform
  ): Promise<DeploymentResult> {
    const deploymentId = randomUUID();
    const now = Date.now();

    // Log pending deployment
    await this.logDeployment({
      id: deploymentId,
      userId: userWallet.userId,
      platform,
      tokenConfig,
      result: null as any,
      status: 'pending',
      createdAt: now,
    });

    try {
      this.logger.info('Starting token deployment', {
        deploymentId,
        userId: userWallet.userId,
        platform,
        name: tokenConfig.name,
        symbol: tokenConfig.symbol,
      });

      // Get hook address based on type
      const hookAddress = tokenConfig.hookType === 'dynamic' 
        ? config.liquid.hookDynamic 
        : config.liquid.hookStatic;

      // Prepare extensions
      const extensions: `0x${string}`[] = [];
      const extensionData: `0x${string}`[] = [];

      if (tokenConfig.extensions?.devBuy && tokenConfig.extensions.devBuy.ethAmount > 0n) {
        extensions.push(config.liquid.lpLocker);
        // Encode dev buy data
        extensionData.push(this.encodeDevBuy(tokenConfig.extensions.devBuy));
      }

      if (tokenConfig.extensions?.vesting) {
        extensions.push(config.liquid.lpLocker);
        extensionData.push(this.encodeVesting(tokenConfig.extensions.vesting));
      }

      if (tokenConfig.extensions?.airdrop) {
        extensions.push('0x1423974d48f525462f1c087cBFdCC20BDBc33CdD' as `0x${string}`);
        extensionData.push(this.encodeAirdrop(tokenConfig.extensions.airdrop));
      }

      // Deploy token
      const hookTypeNum = tokenConfig.hookType === 'dynamic' ? 0 : 1;

      const txHash = await walletClient.writeContract({
        address: config.liquid.factory,
        abi: FACTORY_ABI,
        functionName: 'deployToken',
        args: [
          tokenConfig.name,
          tokenConfig.symbol,
          hookTypeNum,
          tokenConfig.devBuyAmount.toString(),
          extensions,
          extensionData,
        ],
        value: tokenConfig.devBuyAmount,
      });

      this.logger.info('Deployment transaction submitted', { deploymentId, txHash });

      // Wait for receipt
      const receipt = await this.publicClient.waitForTransactionReceipt({
        hash: txHash,
        timeout: 120000, // 2 minutes
      });

      if (receipt.status !== 'success') {
        throw new Error('Transaction failed');
      }

      // Parse logs to get token address and pool ID
      // This would need the actual event ABI from Liquid Protocol
      const result: DeploymentResult = {
        tokenAddress: '', // Would parse from event logs
        poolId: '', // Would parse from event logs
        transactionHash: txHash,
        blockNumber: receipt.blockNumber,
        hookAddress,
        lpLockerAddress: config.liquid.lpLocker,
        timestamp: Date.now(),
      };

      // Update deployment record
      await this.updateDeployment(deploymentId, {
        status: 'success',
        result,
        tokenAddress: result.tokenAddress,
        poolId: result.poolId,
        transactionHash: txHash,
        blockNumber: Number(receipt.blockNumber),
        hookAddress,
        lpLockerAddress: config.liquid.lpLocker,
      });

      this.logger.info('Token deployment successful', {
        deploymentId,
        tokenAddress: result.tokenAddress,
        poolId: result.poolId,
      });

      return result;

    } catch (error: any) {
      this.logger.error('Token deployment failed', {
        deploymentId,
        error: error.message,
      });

      await this.updateDeployment(deploymentId, {
        status: 'failed',
        error: error.message,
      });

      throw error;
    }
  }

  private encodeDevBuy(config: { ethAmount: bigint; minTokensExpected: bigint }): `0x${string}` {
    // Simplified encoding - actual encoding would use proper ABI encoding
    return `0x${config.ethAmount.toString(16).padStart(64, '0')}${config.minTokensExpected.toString(16).padStart(64, '0')}`;
  }

  private encodeVesting(config: { amount: bigint; startTime: number; endTime: number; recipient: string }): `0x${string}` {
    return `0x${config.amount.toString(16).padStart(64, '0')}${config.startTime.toString(16).padStart(64, '0')}${config.endTime.toString(16).padStart(64, '0')}${config.recipient.slice(2).padStart(64, '0')}`;
  }

  private encodeAirdrop(config: { merkleRoot: string; totalAmount: bigint }): `0x${string}` {
    return `0x${config.merkleRoot.slice(2).padStart(64, '0')}${config.totalAmount.toString(16).padStart(64, '0')}`;
  }

  private async logDeployment(record: DeploymentRecord): Promise<void> {
    return new Promise((resolve, reject) => {
      this.db.run(
        `INSERT INTO deployments (
          id, user_id, platform, token_name, token_symbol, status, 
          created_at, config_json
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          record.id,
          record.userId,
          record.platform,
          record.tokenConfig.name,
          record.tokenConfig.symbol,
          record.status,
          record.createdAt,
          JSON.stringify(record.tokenConfig),
        ],
        (err: Error | null) => {
          if (err) reject(err);
          else resolve();
        }
      );
    });
  }

  private async updateDeployment(
    id: string, 
    updates: Partial<DeploymentRecord & { 
      tokenAddress?: string; 
      poolId?: string; 
      transactionHash?: string;
      blockNumber?: number;
      hookAddress?: string;
      lpLockerAddress?: string;
    }>
  ): Promise<void> {
    return new Promise((resolve, reject) => {
      const fields: string[] = [];
      const values: any[] = [];

      if (updates.status) {
        fields.push('status = ?');
        values.push(updates.status);
      }
      if (updates.error) {
        fields.push('error = ?');
        values.push(updates.error);
      }
      if (updates.tokenAddress) {
        fields.push('token_address = ?');
        values.push(updates.tokenAddress);
      }
      if (updates.poolId) {
        fields.push('pool_id = ?');
        values.push(updates.poolId);
      }
      if (updates.transactionHash) {
        fields.push('transaction_hash = ?');
        values.push(updates.transactionHash);
      }
      if (updates.blockNumber !== undefined) {
        fields.push('block_number = ?');
        values.push(updates.blockNumber);
      }
      if (updates.hookAddress) {
        fields.push('hook_address = ?');
        values.push(updates.hookAddress);
      }
      if (updates.lpLockerAddress) {
        fields.push('lp_locker_address = ?');
        values.push(updates.lpLockerAddress);
      }

      values.push(id);

      this.db.run(
        `UPDATE deployments SET ${fields.join(', ')} WHERE id = ?`,
        values,
        (err: Error | null) => {
          if (err) reject(err);
          else resolve();
        }
      );
    });
  }

  async getDeployments(userId?: string, limit: number = 50): Promise<DeploymentRecord[]> {
    return new Promise((resolve, reject) => {
      let query = `SELECT * FROM deployments`;
      const params: any[] = [];

      if (userId) {
        query += ` WHERE user_id = ?`;
        params.push(userId);
      }

      query += ` ORDER BY created_at DESC LIMIT ?`;
      params.push(limit);

      this.db.all(query, params, (err: Error | null, rows: any[]) => {
        if (err) {
          reject(err);
          return;
        }

        resolve(rows.map(row => ({
          id: row.id,
          userId: row.user_id,
          platform: row.platform as Platform,
          tokenConfig: JSON.parse(row.config_json),
          result: {
            tokenAddress: row.token_address,
            poolId: row.pool_id,
            transactionHash: row.transaction_hash,
            blockNumber: BigInt(row.block_number || 0),
            hookAddress: row.hook_address,
            lpLockerAddress: row.lp_locker_address,
            timestamp: row.created_at,
          },
          status: row.status as 'pending' | 'success' | 'failed',
          error: row.error,
          createdAt: row.created_at,
        })));
      });
    });
  }

  generateTokenLinks(tokenAddress: string, poolId?: string): {
    basescan: string;
    dexscreener: string;
    uniswap: string;
    uniswapSwap: string;
    launcherApp: string;
    launcherInAppSwap: string;
  } {
    const addr = getAddress(tokenAddress as `0x${string}`);
    return {
      basescan: `https://basescan.org/token/${addr}`,
      dexscreener: `https://dexscreener.com/base/${addr}`,
      uniswap: `https://app.uniswap.org/explore/tokens/base/${addr}`,
      uniswapSwap: `https://app.uniswap.org/swap?chain=base&outputCurrency=${addr}`,
      launcherApp: launcherAppLaunchesTokenUrl(addr),
      launcherInAppSwap: launcherAppLaunchesTokenUrl(addr, { openSwap: true }),
    };
  }
}
