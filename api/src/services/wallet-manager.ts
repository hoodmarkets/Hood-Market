import { createWalletClient, http, publicActions } from 'viem';
import { privateKeyToAccount, generatePrivateKey } from 'viem/accounts';
import { base } from 'viem/chains';
import crypto from 'crypto';
import { Database } from 'sqlite3';
import { UserWallet, Platform } from '../types';
import { config } from '../config/config';
import { Logger } from 'winston';

export class WalletManager {
  private db: Database;
  private logger: Logger;
  private algorithm = 'aes-256-gcm';

  constructor(db: Database, logger: Logger) {
    this.db = db;
    this.logger = logger;
    this.initDatabase();
  }

  private initDatabase(): void {
    this.db.run(`
      CREATE TABLE IF NOT EXISTS wallets (
        user_id TEXT PRIMARY KEY,
        platform TEXT NOT NULL,
        address TEXT NOT NULL,
        private_key_encrypted TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        last_used_at INTEGER NOT NULL
      )
    `);
    
    this.db.run(`
      CREATE INDEX IF NOT EXISTS idx_wallets_platform ON wallets(platform)
    `);
  }

  private encrypt(text: string): { encrypted: string; authTag: string } {
    const iv = crypto.randomBytes(16);
    const cipher = crypto.createCipheriv(
      this.algorithm,
      Buffer.from(config.encryption.key.slice(0, 32).padEnd(32, '0')),
      iv
    ) as crypto.CipherGCM;
    
    let encrypted = cipher.update(text, 'utf8', 'hex');
    encrypted += cipher.final('hex');
    
    const authTag = cipher.getAuthTag();
    
    return {
      encrypted: iv.toString('hex') + ':' + encrypted,
      authTag: authTag.toString('hex'),
    };
  }

  private decrypt(encryptedData: string, authTag: string): string {
    const [ivHex, encrypted] = encryptedData.split(':');
    const iv = Buffer.from(ivHex, 'hex');
    
    const decipher = crypto.createDecipheriv(
      this.algorithm,
      Buffer.from(config.encryption.key.slice(0, 32).padEnd(32, '0')),
      iv
    ) as crypto.DecipherGCM;
    
    decipher.setAuthTag(Buffer.from(authTag, 'hex'));
    
    let decrypted = decipher.update(encrypted, 'hex', 'utf8');
    decrypted += decipher.final('utf8');
    
    return decrypted;
  }

  async createWallet(userId: string, platform: Platform): Promise<UserWallet> {
    const existingWallet = await this.getWallet(userId, platform);
    if (existingWallet) {
      throw new Error('Wallet already exists for this user');
    }

    const privateKey = generatePrivateKey();
    const account = privateKeyToAccount(privateKey);
    
    const { encrypted, authTag } = this.encrypt(privateKey);
    const now = Date.now();

    return new Promise((resolve, reject) => {
      this.db.run(
        `INSERT INTO wallets (user_id, platform, address, private_key_encrypted, created_at, last_used_at)
         VALUES (?, ?, ?, ?, ?, ?)`,
        [userId, platform, account.address, `${encrypted}:${authTag}`, now, now],
        (err: Error | null) => {
          if (err) {
            this.logger.error('Failed to create wallet', { error: err, userId, platform });
            reject(err);
            return;
          }

          const wallet: UserWallet = {
            userId,
            platform,
            address: account.address,
            privateKeyEncrypted: `${encrypted}:${authTag}`,
            createdAt: now,
            lastUsedAt: now,
          };

          this.logger.info('Created new wallet', { userId, platform, address: account.address });
          resolve(wallet);
        }
      );
    });
  }

  async importWallet(userId: string, platform: Platform, privateKey: string): Promise<UserWallet> {
    const existingWallet = await this.getWallet(userId, platform);
    if (existingWallet) {
      throw new Error('Wallet already exists for this user');
    }

    // Validate private key
    let account;
    try {
      account = privateKeyToAccount(privateKey as `0x${string}`);
    } catch (error) {
      throw new Error('Invalid private key');
    }

    const { encrypted, authTag } = this.encrypt(privateKey);
    const now = Date.now();

    return new Promise((resolve, reject) => {
      this.db.run(
        `INSERT INTO wallets (user_id, platform, address, private_key_encrypted, created_at, last_used_at)
         VALUES (?, ?, ?, ?, ?, ?)`,
        [userId, platform, account.address, `${encrypted}:${authTag}`, now, now],
        (err: Error | null) => {
          if (err) {
            this.logger.error('Failed to import wallet', { error: err, userId, platform });
            reject(err);
            return;
          }

          const wallet: UserWallet = {
            userId,
            platform,
            address: account.address,
            privateKeyEncrypted: `${encrypted}:${authTag}`,
            createdAt: now,
            lastUsedAt: now,
          };

          this.logger.info('Imported wallet', { userId, platform, address: account.address });
          resolve(wallet);
        }
      );
    });
  }

  async getWallet(userId: string, platform: Platform): Promise<UserWallet | null> {
    return new Promise((resolve, reject) => {
      this.db.get(
        `SELECT * FROM wallets WHERE user_id = ? AND platform = ?`,
        [userId, platform],
        (err: Error | null, row: any) => {
          if (err) {
            reject(err);
            return;
          }

          if (!row) {
            resolve(null);
            return;
          }

          resolve({
            userId: row.user_id,
            platform: row.platform as Platform,
            address: row.address,
            privateKeyEncrypted: row.private_key_encrypted,
            createdAt: row.created_at,
            lastUsedAt: row.last_used_at,
          });
        }
      );
    });
  }

  async getWalletClient(userId: string, platform: Platform) {
    const wallet = await this.getWallet(userId, platform);
    if (!wallet) {
      throw new Error('No wallet found for this user. Create one with /wallet create');
    }

    const [encryptedData, authTag] = wallet.privateKeyEncrypted.split(':');
    const privateKey = this.decrypt(encryptedData, authTag);

    const client = createWalletClient({
      account: privateKeyToAccount(privateKey as `0x${string}`),
      chain: base,
      transport: http(config.rpcUrl),
    }).extend(publicActions);

    // Update last used
    this.db.run(
      `UPDATE wallets SET last_used_at = ? WHERE user_id = ? AND platform = ?`,
      [Date.now(), userId, platform]
    );

    return { client, address: wallet.address, wallet };
  }

  async getOrCreateWallet(userId: string, platform: Platform): Promise<UserWallet> {
    const existing = await this.getWallet(userId, platform);
    if (existing) {
      return existing;
    }
    return this.createWallet(userId, platform);
  }

  async getBalance(userId: string, platform: Platform): Promise<{ eth: bigint; address: string }> {
    const { client, address } = await this.getWalletClient(userId, platform);
    
    const balance = await client.getBalance({ address: address as `0x${string}` });
    
    return { eth: balance, address };
  }

  async listWallets(platform?: Platform): Promise<UserWallet[]> {
    return new Promise((resolve, reject) => {
      let query = `SELECT * FROM wallets`;
      const params: any[] = [];

      if (platform) {
        query += ` WHERE platform = ?`;
        params.push(platform);
      }

      this.db.all(query, params, (err: Error | null, rows: any[]) => {
        if (err) {
          reject(err);
          return;
        }

        resolve(rows.map(row => ({
          userId: row.user_id,
          platform: row.platform as Platform,
          address: row.address,
          privateKeyEncrypted: row.private_key_encrypted,
          createdAt: row.created_at,
          lastUsedAt: row.last_used_at,
        })));
      });
    });
  }
}
