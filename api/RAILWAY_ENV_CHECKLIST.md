# Railway deployment checklist (hood.markets API)

Service: **api.hood.markets** · Repo: **anondevv69/hoodmarkets** · Root directory: **`api`**

## "Application failed to respond" (502)

The API process is not running. Browsers often report this as a **CORS error** — fix the 502 first.

### Step 1: Root directory

In Railway → **Settings → Root Directory** → must be **`api`**.

The monorepo has no root `package.json`. Deploying from repo root will fail to build/start.

### Step 2: Required variables (`WEB_ONLY_MODE=true`)

- [ ] `WEB_ONLY_MODE=true`
- [ ] `NODE_ENV=production`
- [ ] `DEPLOYER_PRIVATE_KEY` — deployer wallet (0x + 64 hex chars)
- [ ] `ROBINHOOD_RPC_URL` — `https://rpc.mainnet.chain.robinhood.com`
- [ ] `HOODMARKETS_FACTORY` — from `contracts/deployed-robinhood-mainnet.json`
- [ ] `HOODMARKETS_FEE_LOCKER`
- [ ] `HOODMARKETS_HOOK_DYNAMIC_FEE_V2`
- [ ] `HOODMARKETS_HOOK_STATIC_FEE_V2`
- [ ] `HOODMARKETS_LP_LOCKER_FEE_CONVERSION`
- [ ] `HOODMARKETS_SNIPER_AUCTION_V2`
- [ ] `HOODMARKETS_UNIV4_ETH_DEV_BUY`
- [ ] **HoodMarkets V3 (simple launch — v0.11.0, 2026-07-05):**
  - [ ] `HOODMARKETS_V3_FACTORY=0x9BDdC8ddf28f5629C989A36Eb5bb6C73cBA60Df5`
  - [ ] `HOODMARKETS_V3_VAULT=0x856c6997A86752fB3E6A494AB93107B7A371A57f`
  - [ ] `HOODMARKETS_V3_LP_LOCKER=0x23a1c52F4E93B0283d12CC16c29Df119803E8745`
  - [ ] `HOODMARKETS_V3_FRACTION_DEPLOYER=0x40A19d561b3200A2C9E1014248FcEB724c450692`
  - [ ] `HOODMARKETS_V3_PLATFORM_FEE_RECIPIENT=0xbfD1be7a12A9FeF04D281C2D8D0D9EE15b576d98`
  - [ ] `HOODMARKETS_DEFAULT_LAUNCH_MODE=simple`
- [ ] `PRIVY_APP_ID`
- [ ] `PRIVY_APP_SECRET`
- [ ] `AGENT_CAPTCHA_JWT_SECRET` — HS256 secret for agent haiku JWT (`openssl rand -hex 32`). Optional when skip-captcha is on.
- [ ] `AGENT_DEPLOY_SKIP_CAPTCHA_CHANNELS=x,twitter` — **default** — X skips haiku (Bankr confirms in-thread); other agents need haiku. Do **not** set `AGENT_DEPLOY_SKIP_CAPTCHA=true` unless you want to skip haiku for every channel.

**Not required** for web-only: `NEYNAR_*`, `DISCORD_*`, `TELEGRAM_*`.

### Step 3: Volume

Mount path: **`/app/.data`** (persists deployment catalog SQLite DB).

### Step 4: CORS (browser deploys from Vercel)

- [ ] `WEB_DEPLOY_CORS_ALLOW_VERCEL=true` (default — allows `https://*.vercel.app`)
- [ ] `WEB_DEPLOY_CORS_ORIGINS=https://hood.markets,https://www.hood.markets`
- [ ] `LAUNCHER_WEB_URL=https://hood.markets`

### Step 5: Logs and redeploy

1. Railway → **Logs** → scroll to startup error
2. Fix variables → **Deployments → Redeploy**
3. Wait for `🚀 Liquid Social Launcher running on port …` (or hood-markets-api in health JSON)

### Step 6: Health check

```bash
curl https://api.hood.markets/
```

Expected:

```json
{
  "status": "ok",
  "service": "hood-markets-api",
  "webOnlyMode": true,
  "platforms": { "webDeploy": true }
}
```

CORS check:

```bash
curl -sI -H "Origin: https://hood.markets" https://api.hood.markets/api/web-deploy-config
```

Expected header: `access-control-allow-origin: https://hood.markets`

---

## HoodMarkets V3 v0.11.0 — copy/paste block

After updating variables, **Redeploy** the API service. Full reference: [`api/.env.hood.example`](.env.hood.example) and [`docs/HOODMARKETS_V3.md`](../docs/HOODMARKETS_V3.md).

```env
HOODMARKETS_V3_FACTORY=0x9BDdC8ddf28f5629C989A36Eb5bb6C73cBA60Df5
HOODMARKETS_V3_VAULT=0x856c6997A86752fB3E6A494AB93107B7A371A57f
HOODMARKETS_V3_LP_LOCKER=0x23a1c52F4E93B0283d12CC16c29Df119803E8745
HOODMARKETS_V3_FRACTION_DEPLOYER=0x40A19d561b3200A2C9E1014248FcEB724c450692
HOODMARKETS_V3_PLATFORM_FEE_RECIPIENT=0xbfD1be7a12A9FeF04D281C2D8D0D9EE15b576d98
HOODMARKETS_DEFAULT_LAUNCH_MODE=simple
```

**Previous factories (existing tokens only):** v0.10 `0xf65536Eb3354Ad7e77E1b0d0F7bEBFa1C88885C9` · v0.9 `0x3a94FD3422F50ed6cC08e547c6C697E4bb3e76c8` · v0.8 `0xC2A604fF131dDE9201838007A129ea28b85d00e8` · v0.7 `0x45A3820A9A563e78A4cF7F355F7Be10fA6B706B3` · v0.6 `0x7E2905ddF3Dca96117A9e9d50F2924C1E7FE7Be1` — full list in `skills/hoodmarkets/known-contracts.json`

---

## Optional variables

- `PINATA_JWT` — IPFS logo uploads from Launch tab ([Pinata docs](https://docs.pinata.cloud/files/uploading-files)) — **Railway API only**
- `PINATA_GATEWAY_URL` — optional dedicated gateway for image URLs stored at deploy — **Railway API**
- **Vercel web:** `VITE_IPFS_GATEWAY_URL` — same dedicated gateway base for fast logo reads (e.g. `https://your-subdomain.mypinata.cloud/ipfs`). Do **not** put `PINATA_JWT` on Vercel.
- `LIGHTHOUSE_API_KEY` — fallback IPFS uploads if Pinata is not set
- `PLATFORM_FEE_RECIPIENT` / `PLATFORM_FEE_BPS` — platform LP fee share
- `ZEROX_API_KEY` — in-app swaps (if supported on 4663)
- `DEPLOY_BOND_ETH` — dev buy ETH (default ~0.0001)

---

## Full setup guide

See [`docs/HOOD_MARKETS_SETUP.md`](../docs/HOOD_MARKETS_SETUP.md) in the repo root.
