export interface PlatformListenSnapshot {
  httpServer: boolean;
  /** Telegram long-polling bot running */
  telegram: boolean;
  /** Discord.js client logged in (slash commands) */
  discord: boolean;
  /** Neynar + Farcaster handler; POST /webhooks/neynar active */
  farcaster: boolean;
  /** X OAuth + handler; POST /webhooks/x active */
  x: boolean;
  /** Optional error lines from failed starts */
  errors: string[];
}

let snapshot: PlatformListenSnapshot | null = null;

export function setPlatformListenSnapshot(s: PlatformListenSnapshot): void {
  snapshot = s;
}

export function getPlatformListenSnapshot(): PlatformListenSnapshot | null {
  return snapshot;
}
