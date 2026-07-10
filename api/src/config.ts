import dotenv from 'dotenv';
import { parseEther } from 'viem';
import { parseDeployBondWeiFromEnv } from './lib/deployBondEnv.js';
import { addNameBlocklistEntries } from './lib/blocklistNormalize.js';
import { ROBINHOOD_RPC_DEFAULT } from './lib/robinhoodChain.js';
import { logger } from './logger.js';

dotenv.config();

/** Comma/whitespace-separated @handles or handles - normalized to lowercase without @ */
function parseHandleBlocklist(raw: string | undefined): ReadonlySet<string> {
  const set = new Set<string>();
  if (!raw?.trim()) return set;
  for (const part of raw.split(/[\s,;]+/)) {
    const h = part.trim().replace(/^@/, '').toLowerCase();
    if (h) set.add(h);
  }
  return set;
}

/** Agent channels that skip haiku captcha (e.g. `x,twitter` → Set with `x`). */
function parseAgentChannelSet(raw: string | undefined): ReadonlySet<string> {
  const set = new Set<string>();
  if (!raw?.trim()) return set;
  for (const part of raw.split(/[\s,;]+/)) {
    const t = part.trim().toLowerCase();
    if (!t) continue;
    if (t === 'twitter' || t === 'tweet') set.add('x');
    else set.add(t);
  }
  return set;
}

function requireEnv(key: string): string {
  const value = process.env[key];
  if (!value) {
    throw new Error(`Missing required environment variable: ${key}`);
  }
  return value;
}

/** viem expects `0x` + 64 hex chars; env often has quotes, spaces, or missing prefix */
export function normalizePrivateKey(raw: string): `0x${string}` {
  let s = raw.trim();
  if (
    (s.startsWith('"') && s.endsWith('"')) ||
    (s.startsWith("'") && s.endsWith("'"))
  ) {
    s = s.slice(1, -1).trim();
  }
  if (s.startsWith('0x') || s.startsWith('0X')) {
    s = s.slice(2);
  }
  if (!/^[0-9a-fA-F]{64}$/.test(s)) {
    throw new Error(
      'DEPLOYER_PRIVATE_KEY must be 64 hex characters (optional 0x prefix). ' +
        'In Railway, paste the raw key with no quotes. Example: 0x followed by 64 hex digits.'
    );
  }
  return `0x${s.toLowerCase()}` as `0x${string}`;
}

function liquidAddress(envKey: string, fallback: string): `0x${string}` {
  const raw = process.env[envKey]?.trim();
  return (raw || fallback) as `0x${string}`;
}

/** Prefer hoodmarkets env names; fall back to legacy LIQUID_* from earlier deploys. */
function protocolAddress(
  hoodEnvKey: string,
  legacyEnvKey: string,
  fallback: string,
): `0x${string}` {
  const raw =
    process.env[hoodEnvKey]?.trim() || process.env[legacyEnvKey]?.trim();
  return (raw || fallback) as `0x${string}`;
}

export const config = {
  /**
   * Web-only API (no Telegram/Discord/Farcaster/X bots). Requires Privy for browser deploys.
   * Env: `WEB_ONLY_MODE=true`
   */
  webOnlyMode: process.env.WEB_ONLY_MODE === 'true',

  /**
   * When true, per-user deploy limits return HTTP 409 instead of routing fees to burn.
   * Defaults on when `WEB_ONLY_MODE=true`. Env: `STRICT_DEPLOY_RATE_LIMITS=false` to disable.
   */
  strictDeployRateLimits:
    process.env.STRICT_DEPLOY_RATE_LIMITS === 'true' ||
    (process.env.WEB_ONLY_MODE === 'true' && process.env.STRICT_DEPLOY_RATE_LIMITS !== 'false'),

  // Server
  port: (() => { const p = parseInt(process.env.PORT || '3000', 10); return Number.isFinite(p) ? p : 3000; })(),
  nodeEnv: process.env.NODE_ENV || 'development',

  /** Robinhood Chain RPC (4663). `BASE_RPC_URL` kept as alias for older env files. */
  chainRpcUrl:
    process.env.ROBINHOOD_RPC_URL?.trim() ||
    process.env.CHAIN_RPC_URL?.trim() ||
    process.env.BASE_RPC_URL?.trim() ||
    ROBINHOOD_RPC_DEFAULT,
  baseRpcUrl:
    process.env.ROBINHOOD_RPC_URL?.trim() ||
    process.env.CHAIN_RPC_URL?.trim() ||
    process.env.BASE_RPC_URL?.trim() ||
    ROBINHOOD_RPC_DEFAULT,

  // hoodmarkets factory + protocol modules on Robinhood — set after deploy-robinhood.sh
  liquid: {
    factory: protocolAddress('HOODMARKETS_FACTORY', 'LIQUID_FACTORY', ''),
    feeLocker: protocolAddress('HOODMARKETS_FEE_LOCKER', 'LIQUID_FEE_LOCKER', ''),
    hookDynamic: protocolAddress(
      'HOODMARKETS_HOOK_DYNAMIC_FEE_V2',
      'LIQUID_HOOK_DYNAMIC_FEE_V2',
      '',
    ),
    hookStatic: protocolAddress(
      'HOODMARKETS_HOOK_STATIC_FEE_V2',
      'LIQUID_HOOK_STATIC_FEE_V2',
      '',
    ),
    lpLocker: protocolAddress(
      'HOODMARKETS_LP_LOCKER_FEE_CONVERSION',
      'LIQUID_LP_LOCKER_FEE_CONVERSION',
      '',
    ),
    mevModule: protocolAddress(
      'HOODMARKETS_SNIPER_AUCTION_V2',
      'LIQUID_SNIPER_AUCTION_V2',
      '',
    ),
    univ4EthDevBuy: protocolAddress(
      'HOODMARKETS_UNIV4_ETH_DEV_BUY',
      'LIQUID_UNIV4_ETH_DEV_BUY',
      '',
    ),
    /** One-tx buy/sell helper — set after `02b_DeploySwapHelper.s.sol`. */
    swapHelper: protocolAddress('HOODMARKETS_SWAP_HELPER', 'LIQUID_SWAP_HELPER', ''),
  },

  /** Uniswap V3 simple launcher (DexScreener-friendly) — set after `10_DeployHoodMarketsV3.s.sol`. */
  hoodmarketsV3: {
    factory: protocolAddress('HOODMARKETS_V3_FACTORY', '', ''),
    vault: protocolAddress('HOODMARKETS_V3_VAULT', '', ''),
    lpLocker: protocolAddress('HOODMARKETS_V3_LP_LOCKER', '', ''),
    /** Embedded 5% platform fee recipient in HoodMarketsV3LpLocker (owner can update). */
    platformFeeRecipient: protocolAddress(
      'HOODMARKETS_V3_PLATFORM_FEE_RECIPIENT',
      'HOODMARKETS_PLATFORM_FEE_RECIPIENT',
      '',
    ),
  },

  /**
   * Default web launch mode when client omits `launchMode`.
   * `simple` = HoodMarkets V3 (Uniswap V3). `pro` = HoodMarkets V4 hook stack.
   * Env: `HOODMARKETS_DEFAULT_LAUNCH_MODE=simple|pro`
   */
  defaultLaunchMode: (() => {
    const raw = (process.env.HOODMARKETS_DEFAULT_LAUNCH_MODE || 'simple').trim().toLowerCase();
    return raw === 'pro' ? ('pro' as const) : ('simple' as const);
  })(),

  /** Web wallet vanity suffix (default `00d`). Env: `WEB_WALLET_DEPLOY_VANITY=false` to disable. */
  webWalletDeployVanity: process.env.WEB_WALLET_DEPLOY_VANITY !== 'false',
  webVanityAddressSuffix: (process.env.WEB_VANITY_ADDRESS_SUFFIX?.trim() || '00d').toLowerCase(),
  /** Pre-mined salts kept per launch config. Env: `VANITY_SALT_BANK_SIZE` (default 20). */
  vanitySaltBankSize: (() => {
    const n = Number.parseInt(process.env.VANITY_SALT_BANK_SIZE?.trim() || '20', 10);
    return Number.isFinite(n) && n > 0 ? n : 20;
  })(),
  vanitySaltMaxAttempts: (() => {
    const n = Number.parseInt(process.env.VANITY_SALT_MAX_ATTEMPTS?.trim() || '250000', 10);
    return Number.isFinite(n) && n > 0 ? n : 250_000;
  })(),

  // Deployer wallet (pays gas + minimal deploy bond)
  deployerPrivateKey: normalizePrivateKey(requireEnv('DEPLOYER_PRIVATE_KEY')),

  /**
   * ETH attached to `deployToken` for the Univ4EthDevBuy extension (launch swap + visible liquidity).
   * Override: `DEPLOY_BOND_ETH`. Set to `0` to disable the launch buy (gas-only deploy).
   * Blank/unset env uses the default (see `parseDeployBondWeiFromEnv`).
   */
  deployBondWei: parseDeployBondWeiFromEnv(),

  /**
   * Default deploy chain — Robinhood only.
   */
  deployDefaultChain: 'robinhood' as const,

  /** Ethereum mainnet disabled for Robinhood-only launcher. */
  ethereum: {
    deployEnabled: false,
    rpcUrl: (
      process.env.ETHEREUM_RPC_URL?.trim() ||
      process.env.ETH_RPC_URL?.trim() ||
      'https://ethereum.publicnode.com'
    ).replace(/\/$/, ''),
    /**
     * When true (default), the Ethereum deploy SDK uses vanity CREATE2 salts so new token addresses
     * end with suffix …4b07. Set `ETHEREUM_CLANKER_VANITY=false` to disable vanity addressing.
     */
    clankerVanityAddresses: process.env.ETHEREUM_CLANKER_VANITY !== 'false',
  },

  // Platform Fee Capture (1-2% of LP fees from each token deployment)
  // When set, this address becomes a reward recipient receiving a % of all trading fees
  platformFeeRecipient: (process.env.PLATFORM_FEE_RECIPIENT || '') as `0x${string}`,
  platformFeeBps: (() => { const b = parseInt(process.env.PLATFORM_FEE_BPS || '200', 10); return Number.isFinite(b) && b >= 0 && b <= 10000 ? b : 200; })(), // 200 BPS = 2%

  /**
   * Symbols/tickers that cannot be deployed. Checked case-insensitively.
   * Env: TICKER_BLOCKLIST=ETH,BTC,USDC,USDT,SOL (comma-separated)
   * Always includes a sensible default set of reserved/misleading symbols.
   */
  tickerBlocklist: (() => {
    const defaults = [
      'ETH','WETH','BTC','WBTC','USDC','USDT','DAI','SOL','MATIC','BNB',
      'AVAX','OP','ARB','BASE','CBETH','STETH','RETH','PEPE','DOGE','SHIB',
      'XRP','LTC','DOT','LINK','UNI','AAVE','MKR','COMP','CRV','SNX',
    ];
    const hoodBrand =
      process.env.WEB_ONLY_MODE === 'true'
        ? ['HOODMARKET', 'HOODMKT', 'HOODMKTS', 'HOODLAUNCH']
        : [];
    const custom = (process.env.TICKER_BLOCKLIST || '')
      .split(',')
      .map(s => s.trim().toUpperCase())
      .filter(Boolean);
    return new Set([...defaults, ...hoodBrand, ...custom]);
  })(),

  /**
   * Token **display names** that cannot be deployed (case-insensitive; punctuation/spacing variants blocked).
   * Env: `NAME_BLOCKLIST=Foo,Bar` (comma-separated). Hood.markets brand names are blocked when `WEB_ONLY_MODE=true`.
   */
  nameBlocklist: (() => {
    const set = new Set<string>();
    if (process.env.WEB_ONLY_MODE === 'true') {
      for (const brand of [
        'hood markets',
        'hoodmarkets',
        'hood.markets',
        'hood market',
        'hood markets official',
        'official hood markets',
        'hood launch',
        'hoodlaunch',
      ]) {
        addNameBlocklistEntries(set, brand);
      }
    }
    for (const part of (process.env.NAME_BLOCKLIST || '').split(',')) {
      const t = part.trim();
      if (t) addNameBlocklistEntries(set, t);
    }
    return set;
  })(),

  /**
   * On-chain `context` JSON for factory deploy (visible on block explorers).
   * - `interface` is set per deploy from the surface (discord, telegram, farcaster, x, web, agent).
   * - `platform` identifies this product (hoodmarkets).
   */
  /** Used when deploy params do not include a known `platform` (default `web`). */
  liquidDeployContextInterfaceFallback: (
    process.env.HOODMARKETS_DEPLOY_CONTEXT_INTERFACE ||
    process.env.LIQUID_DEPLOY_CONTEXT_INTERFACE ||
    'web'
  ).trim(),
  liquidDeployContextPlatform: (
    process.env.HOODMARKETS_DEPLOY_CONTEXT_PLATFORM ||
    process.env.LIQUID_DEPLOY_CONTEXT_PLATFORM ||
    (process.env.WEB_ONLY_MODE === 'true' ? 'hoodmarkets' : 'liquidlauncher')
  ).trim(),

  // Neynar (Farcaster) — optional when WEB_ONLY_MODE=true (hood.markets web app)
  neynar: {
    apiKey: (process.env.NEYNAR_API_KEY || '').trim(),
    signerUuid: (process.env.NEYNAR_SIGNER_UUID || '').trim(),
    webhookSecret: process.env.NEYNAR_WEBHOOK_SECRET,
    enabled: !!(process.env.NEYNAR_API_KEY?.trim()),
  },

  // Telegram
  telegram: {
    botToken: process.env.TELEGRAM_BOT_TOKEN,
    /**
     * Optional: channel or supergroup id to post every cataloged deployment (same bot as TELEGRAM_BOT_TOKEN).
     * Add the bot as admin to the channel, or add it to the group. Id often looks like -100xxxxxxxxxx.
     */
    feedChatId: (process.env.TELEGRAM_FEED_CHAT_ID || '').trim(),
    /**
     * Forum topic ids (`message_thread_id`) for a supergroup with Topics enabled.
     * Set only the topics you use; each deploy may post to multiple matching topics.
     * Env: TELEGRAM_FEED_THREAD_MEME, _X, _DISCORD, _TELEGRAM, _FARCASTER, _WEB, _AGENT, _DEPLOYER_FEE_MATCH
     */
    feedThreads: (() => {
      const n = (k: string) => {
        const raw = process.env[k];
        if (raw == null || String(raw).trim() === '') return undefined;
        const v = parseInt(String(raw).trim(), 10);
        return Number.isFinite(v) && v >= 1 ? v : undefined;
      };
      return {
        meme: n('TELEGRAM_FEED_THREAD_MEME'),
        x: n('TELEGRAM_FEED_THREAD_X'),
        discord: n('TELEGRAM_FEED_THREAD_DISCORD'),
        telegram: n('TELEGRAM_FEED_THREAD_TELEGRAM'),
        farcaster: n('TELEGRAM_FEED_THREAD_FARCASTER'),
        web: n('TELEGRAM_FEED_THREAD_WEB'),
        agent: n('TELEGRAM_FEED_THREAD_AGENT'),
        deployerFeeMatch: n('TELEGRAM_FEED_THREAD_DEPLOYER_FEE_MATCH'),
      };
    })(),
  },

  /**
   * Public URL of the hoodmarkets web app (Privy: sign in + export wallet).
   * Included in deploy success messages. Optional but recommended in production.
   */
  launcherWebUrl: (process.env.LAUNCHER_WEB_URL || '').trim(),

  // Discord
  discord: {
    token: process.env.DISCORD_TOKEN,
    clientId: process.env.DISCORD_CLIENT_ID,
    debugChannelId: process.env.DISCORD_DEBUG_CHANNEL_ID,
    feedChannelId: process.env.DISCORD_FEED_CHANNEL_ID,
    /**
     * Optional incoming webhook URL (Server Settings → Integrations → Webhooks) to mirror web launches.
     * Works without the Discord bot; use alongside or instead of DISCORD_FEED_CHANNEL_ID.
     */
    launchWebhookUrl: (process.env.DISCORD_LAUNCH_WEBHOOK_URL || '').trim(),
  },

  // X/Twitter (optional auto-posting)
  x: {
    enabled: process.env.X_POSTING_ENABLED === 'true',
    consumerKey: process.env.X_CONSUMER_KEY,
    consumerSecret: process.env.X_CONSUMER_SECRET,
    accessToken: process.env.X_ACCESS_TOKEN,
    accessTokenSecret: process.env.X_ACCESS_TOKEN_SECRET,
    /** X Account Activity API dev environment label (set in X Developer Portal) */
    webhookEnv: process.env.X_WEBHOOK_ENV || 'dev',
    /**
     * Bot screen name without @ (e.g. liquidlauncher). When set, deploy/help flows
     * only run if the tweet includes @thishandle - matches how people tag the bot to deploy.
     */
    botUsername: (() => {
      const raw = (process.env.X_BOT_USERNAME || process.env.X_BOT_HANDLE || '').trim();
      return raw ? raw.replace(/^@/, '').toLowerCase() : undefined;
    })(),
    /** Screen names that cannot use deploy (or help) on X - `X_DEPLOY_BLOCKLIST` e.g. `spam,badactor` */
    deployBlocklist: parseHandleBlocklist(
      process.env.X_DEPLOY_BLOCKLIST || process.env.X_BLOCKLIST
    ),
    /** Bot user id (numeric). Optional - avoids one GET /2/users/me per process if set (`X_BOT_USER_ID`). */
    botUserId: process.env.X_BOT_USER_ID?.trim() || undefined,
    /**
     * Poll GET /2/users/:id/mentions - legacy Account Activity webhooks return 410.
     * 0 = disable polling (webhook-only; needs Enterprise v2 Account Activity).
     * Default 20000 ms.
     * Note: X often returns 402 on this endpoint on free API tiers while /2/users/me still works — paid tier/credits may be required.
     */
    mentionsPollMs: (() => {
      const raw = process.env.X_MENTIONS_POLL_MS;
      if (raw === '0') return 0;
      const n = parseInt(raw ?? '20000', 10);
      return Number.isFinite(n) && n >= 0 ? n : 20000;
    })(),
    /** If true, first mentions poll processes backlog; default skips backlog (warmup cursor only). */
    mentionsProcessBacklog: process.env.X_MENTIONS_PROCESS_BACKLOG === 'true',
    /**
     * Max successful deploys per **US Eastern calendar day** when fees go to the user’s own
     * Privy-linked wallet (all platforms). Linked Privy accounts share one counter. `0` = unlimited.
     * Env: `X_MAX_SELF_FEE_DEPLOYS_PER_DAY`
     */
    maxSelfFeeDeploysPerEasternDay: (() => {
      const raw = process.env.X_MAX_SELF_FEE_DEPLOYS_PER_DAY;
      if (raw === undefined || raw.trim() === '') return 0;
      const n = parseInt(raw, 10);
      if (!Number.isFinite(n)) return 0;
      return n < 0 ? 0 : n;
    })(),
    /**
     * Max deploys per Eastern day with fees routed to **someone else** (third party), per Privy user.
     * `0` = unlimited. Env: `MAX_OTHER_FEE_DEPLOYS_PER_EASTERN_DAY`
     */
    maxOtherFeeDeploysPerEasternDay: (() => {
      const raw = process.env.MAX_OTHER_FEE_DEPLOYS_PER_EASTERN_DAY;
      if (raw === undefined || raw.trim() === '') {
        return process.env.WEB_ONLY_MODE === 'true' ? 1 : 0;
      }
      const n = parseInt(raw, 10);
      if (!Number.isFinite(n)) return 0;
      return n < 0 ? 0 : n;
    })(),
  },

  /**
   * Web and all platforms: max **third-party** fee assignments per **US Eastern calendar day** per
   * resolved fee recipient (`fee_to_self = 0`). Self-fee launches to the same wallet use a separate
   * bucket. `0` = unlimited. Env: `MAX_FEE_RECIPIENT_DEPLOYS_PER_EASTERN_DAY`
   */
  maxFeeRecipientDeploysPerEasternDay: (() => {
    const raw = process.env.MAX_FEE_RECIPIENT_DEPLOYS_PER_EASTERN_DAY;
    if (raw === undefined || raw.trim() === '') {
      return process.env.WEB_ONLY_MODE === 'true' ? 1 : 0;
    }
    const n = parseInt(raw, 10);
    if (!Number.isFinite(n)) return 0;
    return n < 0 ? 0 : n;
  })(),

  /**
   * Each ticker symbol can be deployed at most once in this rolling window (hours), **globally**
   * (all users and platforms). `0` disables. Env: `GLOBAL_TICKER_COOLDOWN_HOURS` (default 24).
   */
  globalTickerCooldownHours: (() => {
    const raw = process.env.GLOBAL_TICKER_COOLDOWN_HOURS;
    if (raw === undefined || raw.trim() === '') return 24;
    const n = parseInt(raw, 10);
    if (!Number.isFinite(n)) return 24;
    return n < 0 ? 0 : n;
  })(),

  /**
   * Rolling window (hours) for per-wallet deploy rate limits (self-fee + third-party recipient).
   * Env: `DEPLOY_RATE_LIMIT_HOURS` (default 24).
   */
  deployRateLimitRollingHours: (() => {
    const raw = process.env.DEPLOY_RATE_LIMIT_HOURS;
    if (raw === undefined || raw.trim() === '') return 24;
    const n = parseInt(raw, 10);
    if (!Number.isFinite(n)) return 24;
    return n < 1 ? 24 : Math.min(n, 168);
  })(),

  /**
   * Optional **rolling** (last N hours) cap on self-fee deploys — in addition to Eastern-day caps above.
   * `0` = off (use only `X_MAX_SELF_FEE_DEPLOYS_PER_DAY` if set). Env: `MAX_SELF_FEE_DEPLOYS_PER_24H`
   */
  maxSelfFeeDeploysPerRollingWindow: (() => {
    const raw = process.env.MAX_SELF_FEE_DEPLOYS_PER_24H;
    if (raw === undefined || raw.trim() === '') {
      return process.env.WEB_ONLY_MODE === 'true' ? 1 : 0;
    }
    const n = parseInt(raw, 10);
    if (!Number.isFinite(n)) return 0;
    return n < 0 ? 0 : n;
  })(),

  /**
   * Optional **rolling** cap on third-party fee assignments (`fee_to_self = 0`) to the same wallet.
   * `0` = off. Env: `MAX_THIRD_PARTY_FEE_TO_WALLET_PER_24H` (Eastern per-recipient cap stays `MAX_FEE_RECIPIENT_DEPLOYS_PER_EASTERN_DAY`).
   */
  maxThirdPartyFeeToSameWalletPerRollingWindow: (() => {
    const raw = process.env.MAX_THIRD_PARTY_FEE_TO_WALLET_PER_24H;
    if (raw === undefined || raw.trim() === '') {
      return process.env.WEB_ONLY_MODE === 'true' ? 1 : 0;
    }
    const n = parseInt(raw, 10);
    if (!Number.isFinite(n)) return 0;
    return n < 0 ? 0 : n;
  })(),

  // Supabase (Image storage)
  supabase: {
    url: process.env.SUPABASE_URL || '',
    anonKey: process.env.SUPABASE_ANON_KEY || '',
    bucket: process.env.SUPABASE_BUCKET || 'token-images',
  },

  /**
   * Pinata (IPFS) for token images — preferred when `PINATA_JWT` is set.
   * See https://docs.pinata.cloud/files/uploading-files
   */
  pinata: {
    jwt: (process.env.PINATA_JWT || '').trim(),
    /** HTTPS gateway for returned image URLs (no trailing slash). Use your dedicated gateway from Pinata dashboard when available. */
    gatewayBase: (
      process.env.PINATA_GATEWAY_URL?.trim() || 'https://gateway.pinata.cloud/ipfs'
    ).replace(/\/$/, ''),
  },

  /**
   * Lighthouse (IPFS) for token images — fallback when Pinata is not configured.
   * See https://docs.lighthouse.storage/quick-start
   */
  lighthouse: {
    apiKey: (process.env.LIGHTHOUSE_API_KEY || '').trim(),
    /** No trailing slash. Avoid gateway.lighthouse.storage (402). */
    ipfsGatewayBase: (
      process.env.LIGHTHOUSE_IPFS_GATEWAY_URL?.trim() ||
      'https://alternative-sparrow-qk8yx.lighthouseweb3.xyz/ipfs'
    ).replace(/\/$/, ''),
  },

  // Privy (identity-linked fee wallets — optional)
  privy: {
    appId: process.env.PRIVY_APP_ID || '',
    appSecret: process.env.PRIVY_APP_SECRET || '',
    enabled: !!(process.env.PRIVY_APP_ID && process.env.PRIVY_APP_SECRET),
    /**
     * Base64 PKCS8 private key for Privy Wallet API authorization (dashboard → Authorization keys).
     * Required for server-side `eth_sendTransaction` after the user delegates in the web app.
     */
    walletApiAuthorizationPrivateKey: (process.env.PRIVY_WALLET_API_AUTHORIZATION_PRIVATE_KEY || '').trim(),
    /**
     * Request sponsored gas on server `eth_sendTransaction` (Node SDK). Must match Privy Dashboard →
     * Gas sponsorship (e.g. Base enabled) and **available credits**; optional policies there still apply.
     * Env: `PRIVY_SPONSOR_SERVER_TRANSACTIONS=true`
     */
    sponsorServerTransactions: process.env.PRIVY_SPONSOR_SERVER_TRANSACTIONS === 'true',
  },

  /** Rainbow / Bankr wallet login for the web app (HS256 session JWT). */
  webWallet: {
    jwtSecret: (
      process.env.WEB_WALLET_JWT_SECRET ||
      process.env.AGENT_CAPTCHA_JWT_SECRET ||
      ''
    ).trim(),
    sessionHours: Math.max(
      1,
      Number.parseInt(process.env.WEB_WALLET_SESSION_HOURS || '24', 10) || 24,
    ),
    get enabled(): boolean {
      return !!this.jwtSecret;
    },
  },

  /**
   * Default ETH size for delegated *buy* swaps from chat (server → 0x → Privy).
   * Env: DELEGATED_SWAP_BUY_ETH (e.g. `0.01`).
   */
  delegatedSwapBuyEth: (() => {
    const raw = process.env.DELEGATED_SWAP_BUY_ETH?.trim();
    if (!raw) return '0.01';
    return raw;
  })(),

  /**
   * Human token amount for delegated *sell* swaps from chat (server → 0x → Privy).
   * Env: DELEGATED_SWAP_SELL_TOKEN_AMOUNT (default `1`; decimals resolved on-chain).
   */
  delegatedSwapSellTokenAmount: (process.env.DELEGATED_SWAP_SELL_TOKEN_AMOUNT || '1').trim(),

  /**
   * Comma-separated origins allowed for browser CORS (deploy, profile APIs, etc.).
   * `https://llauncher.app` and `https://www.llauncher.app` are always merged in so production works
   * even if WEB_DEPLOY_CORS_ORIGINS is unset. Add localhost via env for local dev.
   */
  webDeployCorsOrigins: (() => {
    const fromEnv = (process.env.WEB_DEPLOY_CORS_ORIGINS || '')
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean);
    const hoodDefaults = ['https://hood.markets', 'https://www.hood.markets'];
    const legacyDefaults = ['https://llauncher.app', 'https://www.llauncher.app'];
    const defaults =
      process.env.WEB_ONLY_MODE === 'true' ? hoodDefaults : [...hoodDefaults, ...legacyDefaults];
    return [...new Set([...defaults, ...fromEnv])];
  })(),

  /**
   * When true (default), allow CORS from Lovable hostnames (https://*.lovable.app, *.lovable.dev, *.lovableproject.com).
   * Custom domains are also covered by defaults + WEB_DEPLOY_CORS_ORIGINS.
   * Set WEB_DEPLOY_CORS_ALLOW_LOVABLE=false to disable Lovable-only auto-allow.
   */
  webDeployCorsAllowLovable: process.env.WEB_DEPLOY_CORS_ALLOW_LOVABLE !== 'false',

  /**
   * When true (default), allow CORS from Vercel hostnames (https://*.vercel.app).
   * Set WEB_DEPLOY_CORS_ALLOW_VERCEL=false to disable (production custom domain only).
   */
  webDeployCorsAllowVercel: process.env.WEB_DEPLOY_CORS_ALLOW_VERCEL !== 'false',

  /**
   * 0x Swap API (AllowanceHolder) — server-side proxy only; never expose the key to the browser.
   * Env: `ZEROX_API_KEY` from https://dashboard.0x.org
   */
  zeroX: {
    apiKey: (process.env.ZEROX_API_KEY || '').trim(),
    enabled: !!(process.env.ZEROX_API_KEY?.trim()),
  },

  /**
   * Odos SOR (quote + assemble) — optional alternative to 0x for server-side bot swaps.
   * @see https://docs.odos.xyz/
   */
  odos: {
    apiKey: (process.env.ODOS_API_KEY || '').trim(),
    apiBase: (process.env.ODOS_API_BASE || 'https://enterprise-api.odos.xyz').replace(/\/$/, ''),
    enabled: !!(process.env.ODOS_API_KEY?.trim()),
  },

  /**
   * Server bot swap API (`POST /api/bot/swap`) + policy enforcement (routers, spend cap).
   * Set `BOT_SWAP_API_SECRET`; bots/agents send `Authorization: Bearer <secret>`.
   */
  botSwap: {
    apiSecret: (process.env.BOT_SWAP_API_SECRET || '').trim(),
    maxSellEthWei: (() => {
      const raw = process.env.BOT_SWAP_MAX_ETH?.trim();
      if (!raw) return parseEther('0.05');
      try {
        return parseEther(raw);
      } catch {
        return parseEther('0.05');
      }
    })(),
    maxSellEthHuman: process.env.BOT_SWAP_MAX_ETH?.trim() || '0.05',
    /** Lowercase 0x addresses; defaults include Base AllowanceHolder, Odos router, Velora/ParaSwap Augustus. */
    routerAllowlist: (() => {
      const defaults = [
        '0x0000000000001ff3684f28c67538d4d072c22734',
        '0x221a4c9e54baebd678ff1823e4fca2ac3685ca64',
        '0x59c7c832e96d2568bea6db468c1aadcbbda08a52',
      ];
      const extra = (process.env.BOT_SWAP_ROUTER_ALLOWLIST || '')
        .split(',')
        .map((s) => s.trim().toLowerCase())
        .filter(Boolean);
      return new Set([...defaults, ...extra]);
    })(),
    rateLimitMs: (() => {
      const n = parseInt(process.env.BOT_SWAP_RATE_LIMIT_MS || '3000', 10);
      return Number.isFinite(n) && n >= 0 ? n : 3000;
    })(),
    defaultQuoteProvider: ((): '0x' | 'odos' => {
      const raw = (process.env.BOT_SWAP_DEFAULT_QUOTE_PROVIDER || '').trim().toLowerCase();
      if (raw === '0x' || raw === 'odos') return raw;
      return 'odos';
    })(),
  },

  /**
   * [agent-captcha](https://github.com/Dhravya/agent-captcha) — HS256 JWT from POST /api/solve.
   * Set the same secret your Worker uses to sign JWTs. Required for `feeTarget: agent_wallet` deploys
   * unless AGENT_CAPTCHA_SKIP_VERIFY is enabled (development only).
   */
  agentCaptcha: {
    jwtSecret: (process.env.AGENT_CAPTCHA_JWT_SECRET || '').trim(),
    /** Only when NODE_ENV !== 'production' — decodes JWT without verification (local dev). */
    skipVerify:
      process.env.NODE_ENV !== 'production' &&
      process.env.AGENT_CAPTCHA_SKIP_VERIFY === 'true',
  },

  /**
   * Agent deploy auth for `feeTarget: agent_wallet`:
   * - X/Twitter (`agentChannel: x` or `x-agent-channel: x`): skip haiku — Bankr confirms in-thread first.
   * - Other agents: haiku JWT (automatable).
   * - `AGENT_DEPLOY_SKIP_CAPTCHA=true`: legacy global skip (all channels).
   */
  agentDeploy: {
    skipCaptchaGlobal: process.env.AGENT_DEPLOY_SKIP_CAPTCHA === 'true',
    skipCaptchaChannels: parseAgentChannelSet(
      process.env.AGENT_DEPLOY_SKIP_CAPTCHA_CHANNELS || 'x,twitter',
    ),
    /**
     * Max server-side launches via X/Bankr (`agentChannel: x`) per Eastern calendar day per wallet.
     * Over limit → HTTP 409 with today's token + reset time; users deploy more at hood.markets.
     * `0` = unlimited. Env: `AGENT_X_MAX_DEPLOYS_PER_EASTERN_DAY` (default 1).
     */
    maxXDeploysPerEasternDay: (() => {
      const raw = process.env.AGENT_X_MAX_DEPLOYS_PER_EASTERN_DAY;
      if (raw === undefined || raw.trim() === '') return 1;
      const n = parseInt(raw, 10);
      if (!Number.isFinite(n)) return 1;
      return n < 0 ? 0 : n;
    })(),
  },

  /**
   * CoinGecko (public API) — token search → Base `contract_address` for `resolve_token_on_base` agent tool.
   * Optional `COINGECKO_API_KEY` sets `x-cg-demo-api-key` on requests (higher rate limits on supported plans).
   */
  coingecko: {
    apiKey: (process.env.COINGECKO_API_KEY || '').trim(),
  },

  /**
   * LangChain + OpenAI-compatible tool-calling agent: `POST /api/agent/langchain`.
   * Auth: `Authorization: Bearer <LANGCHAIN_AGENT_SECRET>` — if unset, falls back to `BOT_SWAP_API_SECRET`.
   * LLM: `LANGCHAIN_LLM_API_KEY` or `OPENAI_API_KEY`. Optional `LANGCHAIN_OPENAI_BASE_URL` for Groq / Together / Fireworks.
   *
   * Two-model routing (optional):
   *   LANGCHAIN_TOOL_MODEL      — cheap model for tool-calling iterations (default: LANGCHAIN_AGENT_MODEL)
   *   LANGCHAIN_SYNTHESIS_MODEL — model for final user-facing response (default: LANGCHAIN_AGENT_MODEL)
   *   LANGCHAIN_SYNTHESIS_API_KEY    — separate API key for synthesis model (default: LANGCHAIN_LLM_API_KEY)
   *   LANGCHAIN_SYNTHESIS_BASE_URL   — separate base URL for synthesis model (default: LANGCHAIN_OPENAI_BASE_URL)
   */
  langchainAgent: {
    apiSecret: (process.env.LANGCHAIN_AGENT_SECRET || '').trim(),
    llmApiKey: (process.env.LANGCHAIN_LLM_API_KEY || process.env.OPENAI_API_KEY || '').trim(),
    openaiCompatibleBaseUrl: (process.env.LANGCHAIN_OPENAI_BASE_URL || '').trim(),
    model: (process.env.LANGCHAIN_AGENT_MODEL || 'gpt-4o-mini').trim(),
    /** Model used for tool-calling iterations. Defaults to `model`. */
    toolModel: (process.env.LANGCHAIN_TOOL_MODEL || process.env.LANGCHAIN_AGENT_MODEL || 'gpt-4o-mini').trim(),
    /** Model used for final synthesis (user-facing response). Defaults to `model`. */
    synthesisModel: (process.env.LANGCHAIN_SYNTHESIS_MODEL || process.env.LANGCHAIN_AGENT_MODEL || 'gpt-4o-mini').trim(),
    /** Separate API key for the synthesis model. Defaults to `llmApiKey`. */
    synthesisApiKey: (process.env.LANGCHAIN_SYNTHESIS_API_KEY || process.env.LANGCHAIN_LLM_API_KEY || process.env.OPENAI_API_KEY || '').trim(),
    /** Separate base URL for the synthesis model. Defaults to `openaiCompatibleBaseUrl`. */
    synthesisBaseUrl: (process.env.LANGCHAIN_SYNTHESIS_BASE_URL || process.env.LANGCHAIN_OPENAI_BASE_URL || '').trim(),
    maxIterations: (() => {
      const n = parseInt(process.env.LANGCHAIN_AGENT_MAX_ITERATIONS || '8', 10);
      return Number.isFinite(n) && n >= 1 && n <= 25 ? n : 8;
    })(),
    /** Number of past (human, assistant) turns to keep in memory per user. 0 = disabled. */
    memoryTurns: (() => {
      const n = parseInt(process.env.LANGCHAIN_MEMORY_TURNS || '6', 10);
      return Number.isFinite(n) && n >= 0 && n <= 20 ? n : 6;
    })(),
  },

  /**
   * Tavily web search (optional — enables `web_search` agent tool).
   * Env: TAVILY_API_KEY — get one at https://tavily.com
   */
  tavily: {
    apiKey: (process.env.TAVILY_API_KEY || '').trim(),
  },

  /**
   * Legacy agent deploy payment treasury (Robinhood ETH). X/Bankr daily cap is now a hard block (409);
   * paid relaunches on X are disabled — users deploy at hood.markets instead.
   */
  agentDeployPayment: {
    treasury: (process.env.AGENT_DEPLOY_PAYMENT_TREASURY || '').trim(),
    minWei: (() => {
      const raw = process.env.AGENT_DEPLOY_PAYMENT_WEI?.trim();
      if (raw) {
        try {
          if (/^\d+$/.test(raw)) return BigInt(raw);
          if (raw.startsWith('0x')) return BigInt(raw);
          return parseEther(raw);
        } catch {
          /* fall through to default */
        }
      }
      return parseDeployBondWeiFromEnv() + parseEther('0.002');
    })(),
  },

  // Features
  features: {
    autoPostToX: process.env.AUTO_POST_TO_X === 'true',
    /**
     * When Privy `PRIVY_APP_ID` + `PRIVY_APP_SECRET` are set, Discord/X/Farcaster/Telegram use
     * identity-linked Privy fee wallets by default (same user id as the web app).
     * Set `USE_PRIVY_WALLETS=false` to disable and require explicit 0x fee addresses instead.
     */
    usePrivyWallets:
      !!(process.env.PRIVY_APP_ID?.trim() && process.env.PRIVY_APP_SECRET?.trim()) &&
      process.env.USE_PRIVY_WALLETS !== 'false',
  },
};

// Validate config on startup
export function validateConfig(): void {
  if (config.webOnlyMode) {
    const required = ['DEPLOYER_PRIVATE_KEY', 'PRIVY_APP_ID', 'PRIVY_APP_SECRET'];
    for (const key of required) {
      if (!process.env[key]?.trim()) {
        throw new Error(`Missing required environment variable: ${key}`);
      }
    }
    if (!config.liquid.factory) {
      throw new Error(
        'HOODMARKETS_FACTORY (or LIQUID_FACTORY) is required — set Robinhood contract addresses from deployed-robinhood-mainnet.json',
      );
    }
    if (config.defaultLaunchMode === 'simple' && !config.hoodmarketsV3.factory) {
      throw new Error(
        'HOODMARKETS_V3_FACTORY is required when HOODMARKETS_DEFAULT_LAUNCH_MODE=simple — run 10_DeployHoodMarketsV3.s.sol',
      );
    }
    logger.info('WEB_ONLY_MODE: bots and Neynar are optional');
  } else {
    const required = ['DEPLOYER_PRIVATE_KEY', 'NEYNAR_API_KEY', 'NEYNAR_SIGNER_UUID'];
    for (const key of required) {
      if (!process.env[key]) {
        throw new Error(`Missing required environment variable: ${key}`);
      }
    }
  }

  if (config.deployBondWei === 0n) {
    logger.warn(
      'DEPLOY_BOND_ETH is 0: launch Univ4EthDevBuy is disabled (deploys send no ETH with deployToken; pools may show no initial swap liquidity). Set a positive value (e.g. 0.05) unless intentional.'
    );
  }

  if (config.deployDefaultChain !== 'robinhood' && !config.liquid.factory) {
    logger.warn(
      'LIQUID_FACTORY is not set — deploy Liquid Protocol on Robinhood (see contracts-robinhood/scripts/deploy-robinhood.sh) before launching tokens.',
    );
  }
}
