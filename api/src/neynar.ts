import { NeynarAPIClient } from '@neynar/nodejs-sdk';
import { config } from './config.js';
import { logger } from './logger.js';

export interface FarcasterUser {
  fid: number;
  username: string;
  displayName: string;
  verifications: string[];
  ethAddresses: string[];
  xUsername?: string;   // linked X/Twitter account (from verified_accounts, requires experimental)
  pfpUrl?: string;
}

export class NeynarClient {
  private client: NeynarAPIClient | null;

  constructor() {
    this.client = config.neynar.apiKey
      ? new NeynarAPIClient(config.neynar.apiKey)
      : null;
  }

  get enabled(): boolean {
    return this.client != null;
  }
  
  /** Resolve Farcaster profile by username (for web fee recipient). */
  async getUserByFarcasterUsername(username: string): Promise<FarcasterUser | null> {
    if (!this.client || !config.neynar.apiKey) return null;
    const clean = username.replace(/^@/, '').trim();
    if (!clean) return null;
    try {
      const res = await fetch(
        `https://api.neynar.com/v2/farcaster/user/by_username/?username=${encodeURIComponent(clean)}`,
        {
          headers: {
            'x-api-key': config.neynar.apiKey,
            'x-neynar-experimental': 'true',
          },
        }
      );
      if (!res.ok) return null;
      const data = (await res.json()) as { user?: any };
      const user = data.user;
      if (!user) return null;
      const verifiedEth: string[] = user.verified_addresses?.eth_addresses ?? [];
      const custody: string = user.custody_address ?? '';
      const ethAddresses = Array.from(
        new Set([...verifiedEth, custody].filter((a) => /^0x[a-fA-F0-9]{40}$/i.test(a)))
      );
      return {
        fid: user.fid,
        username: user.username,
        displayName: user.display_name ?? user.username,
        verifications: user.verifications ?? [],
        ethAddresses,
        pfpUrl:
          typeof user.pfp_url === 'string' && user.pfp_url.startsWith('http')
            ? user.pfp_url
            : undefined,
      };
    } catch {
      return null;
    }
  }

  async getUserByFid(fid: number): Promise<FarcasterUser | null> {
    if (!this.client) return null;
    try {
      // Access the underlying v2 user API directly so we can pass x_neynar_experimental=true.
      // The high-level fetchBulkUsers wrapper doesn't expose this flag.
      const v2UserApi = (this.client as any).clients?.v2?.apis?.user;
      let user: any;

      if (v2UserApi?.fetchBulkUsers) {
        const response = await v2UserApi.fetchBulkUsers({
          fids: String(fid),
          x_neynar_experimental: true,
        });
        user = response.data?.users?.[0];
      } else {
        // Fallback if internal structure changes
        const response = await this.client.fetchBulkUsers([fid]);
        user = response.users?.[0];
      }

      if (!user) return null;

      const verifiedEth: string[] = user.verified_addresses?.eth_addresses ?? [];
      const custody: string = user.custody_address ?? '';
      const ethAddresses = Array.from(
        new Set([...verifiedEth, custody].filter((a) => /^0x[a-fA-F0-9]{40}$/i.test(a)))
      );

      // Extract linked X/Twitter account from verified_accounts (requires experimental flag)
      const xAccount = (user.verified_accounts ?? []).find(
        (a: { platform?: string; username?: string }) => a.platform === 'x'
      );

      return {
        fid: user.fid,
        username: user.username,
        displayName: user.display_name ?? user.username,
        verifications: user.verifications ?? [],
        ethAddresses,
        xUsername: xAccount?.username,
        pfpUrl:
          typeof user.pfp_url === 'string' && user.pfp_url.startsWith('http')
            ? user.pfp_url
            : undefined,
      };
    } catch (error) {
      console.error('Failed to fetch user from Neynar:', error);
      return null;
    }
  }
  
  /**
   * Look up a Farcaster user by their linked X (Twitter) username.
   * Uses Neynar's /v2/farcaster/user/by_x_username/ endpoint.
   * Returns the user's primary ETH address if found.
   */
  async getWalletByXUsername(xUsername: string): Promise<string | null> {
    if (!config.neynar.apiKey) return null;
    try {
      const res = await fetch(
        `https://api.neynar.com/v2/farcaster/user/by_x_username/?x_username=${encodeURIComponent(xUsername)}`,
        {
          headers: {
            'x-api-key': config.neynar.apiKey,
            'x-neynar-experimental': 'true',
          },
        }
      );
      if (!res.ok) {
        const body = await res.text().catch(() => '');
        // 404 = no Farcaster user has this X handle linked — expected, not an ops issue.
        if (res.status === 404) return null;
        logger.warn('Neynar by_x_username request failed', {
          xUsername,
          status: res.status,
          body: body.slice(0, 300),
        });
        return null;
      }
      const data = await res.json() as { users?: any[] };
      const user = data.users?.[0];
      if (!user) return null;

      // Prefer primary verified eth address, then first verified, then custody
      const primary = user.verified_addresses?.primary?.eth_address;
      if (primary && /^0x[a-fA-F0-9]{40}$/i.test(primary)) return primary;

      const firstVerified = user.verified_addresses?.eth_addresses?.[0];
      if (firstVerified && /^0x[a-fA-F0-9]{40}$/i.test(firstVerified)) return firstVerified;

      const custody = user.custody_address;
      if (custody && /^0x[a-fA-F0-9]{40}$/i.test(custody)) return custody;

      return null;
    } catch {
      return null;
    }
  }

  async getUsersByWallets(addresses: string[]): Promise<Map<string, FarcasterUser>> {
    if (!this.client) return new Map();
    try {
      const response = await this.client.fetchBulkUsersByEthereumAddress(addresses, {});
      
      const map = new Map<string, FarcasterUser>();
      
      for (const [address, users] of Object.entries(response)) {
        if (Array.isArray(users) && users.length > 0) {
          const user = users[0];
          map.set(address.toLowerCase(), {
            fid: user.fid,
            username: user.username,
            displayName: user.display_name ?? user.username,
            verifications: user.verifications || [],
            ethAddresses: user.verified_addresses?.eth_addresses ?? [],
          });
        }
      }
      
      return map;
    } catch (error) {
      console.error('Failed to fetch users by wallets:', error);
      return new Map();
    }
  }
  
  async publishCast(text: string, replyTo?: string): Promise<void> {
    if (!this.client) return;
    try {
      await this.client.publishCast(
        config.neynar.signerUuid,
        text,
        replyTo ? { replyTo } : undefined,
      );
      console.log('Published cast:', text.slice(0, 50));
    } catch (error) {
      console.error('Failed to publish cast:', error);
      throw error;
    }
  }

  /** Full cast embeds (webhooks sometimes omit embeds until Neynar finishes processing). */
  async getCastEmbedsByHash(castHash: string): Promise<unknown[] | undefined> {
    if (!this.client) return undefined;
    try {
      const res = await this.client.fetchBulkCasts([castHash]);
      const r = res as { result?: { casts?: Array<{ embeds?: unknown[] }> }; casts?: unknown[] };
      const first = r.result?.casts?.[0] ?? (r as { casts?: Array<{ embeds?: unknown[] }> }).casts?.[0];
      return first?.embeds;
    } catch (error) {
      console.error('fetchBulkCasts failed:', error);
      return undefined;
    }
  }
}
