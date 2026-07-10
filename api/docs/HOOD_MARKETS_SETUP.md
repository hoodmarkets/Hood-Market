# Hood.markets production setup

**Repo:** [github.com/anondevv69/hoodmarkets](https://github.com/anondevv69/hoodmarkets)

Monorepo layout:

| Path | Deploy to | Root directory |
|------|-----------|----------------|
| [`api/`](../api/) | **Railway** (`api.hood.markets`) | `api` |
| [`web/`](../web/) | **Vercel** (`hood.markets`) | `web` |
| [`contracts/`](../contracts/) | Robinhood mainnet (Foundry, local/CI) | — |

Token factory on-chain: **`HoodMarkets`**, **`HoodMarketsFeeLocker`**, etc. Contract addresses live in [`contracts/deployed-robinhood-mainnet.json`](../contracts/deployed-robinhood-mainnet.json).

---

## Migrate from `liquid-social-launcher`

If Railway/Vercel still point at the old repo, switch them to this monorepo:

### Railway (API)

1. Open your **api.hood.markets** service in [Railway](https://railway.app).
2. **Settings → Source** → connect **GitHub repo** `anondevv69/hoodmarkets`.
3. **Settings → Root Directory** → set to **`api`** (required — there is no `package.json` at repo root).
4. **Settings → Volumes** → mount path **`/app/.data`** (SQLite deployment catalog).
5. **Variables** → copy from [`api/.env.hood.example`](../api/.env.hood.example) (see below). Keep existing secrets (`DEPLOYER_PRIVATE_KEY`, `PRIVY_*`) from the old service.
6. Remove legacy `LIQUID_*` vars after `HOODMARKETS_*` are set.
7. **Deploy** → wait for build (`npm ci --include=dev` → `npm run build` → `npm start`).

### Vercel (web)

1. Open your Vercel project (e.g. `liquid-social-launcher` or `hood.markets`).
2. **Settings → Git** → connect **GitHub repo** `anondevv69/hoodmarkets`.
3. **Settings → General → Root Directory** → set to **`web`**.
4. **Settings → Environment Variables** (Production + Preview):

```env
VITE_PRIVY_APP_ID=<same Privy app as Railway>
VITE_API_URL=https://api.hood.markets
```

5. **Deploy** → connect custom domain `hood.markets` (+ `www`).

### Privy

In [dashboard.privy.io](https://dashboard.privy.io), allow domains:

- `https://hood.markets`
- `https://www.hood.markets`
- `https://*.vercel.app` (or your specific Vercel URL while testing)
- `http://localhost:5173` (local dev)

Chains → **Robinhood Chain (4663)**.

---

## 1. Railway variables (required)

Copy [`api/.env.hood.example`](../api/.env.hood.example):

```env
WEB_ONLY_MODE=true
NODE_ENV=production

DEPLOYER_PRIVATE_KEY=0x...
ROBINHOOD_RPC_URL=https://rpc.mainnet.chain.robinhood.com

HOODMARKETS_FACTORY=0xdeBc9bC5c3Ca697493a01e8ac503B590D209d8bD
HOODMARKETS_FEE_LOCKER=0xD588F6F8819Fc0B34fF72300Bb87b8c69C4cD454
HOODMARKETS_HOOK_DYNAMIC_FEE_V2=0x5de599D4363bb9308434351600c34C96D46868CC
HOODMARKETS_HOOK_STATIC_FEE_V2=0xCD9DD3fa11c53cf6aE3d4e4D3fdf7C1f790468cc
HOODMARKETS_LP_LOCKER_FEE_CONVERSION=0x34861965c8eFc302E794C8593404CF17c6e65fF0
HOODMARKETS_SNIPER_AUCTION_V2=0xcbbc3534a892a365c57023c34349300d360f6a1b
HOODMARKETS_UNIV4_ETH_DEV_BUY=0x39ddf0339f9dccef59457a3579de1789c38d5a40

PRIVY_APP_ID=...
PRIVY_APP_SECRET=...

WEB_DEPLOY_CORS_ORIGINS=https://hood.markets,https://www.hood.markets
WEB_DEPLOY_CORS_ALLOW_LOVABLE=false
WEB_DEPLOY_CORS_ALLOW_VERCEL=true
LAUNCHER_WEB_URL=https://hood.markets
HOODMARKETS_DEPLOY_CONTEXT_PLATFORM=hoodmarkets
```

**Do not set** `NEYNAR_*`, `DISCORD_*`, `TELEGRAM_*` for web-only mode.

Optional: `PINATA_JWT` + `PINATA_GATEWAY_URL` (logo uploads via [Pinata](https://docs.pinata.cloud/files/uploading-files)), `LIGHTHOUSE_API_KEY` (fallback), `PLATFORM_FEE_RECIPIENT`, `PLATFORM_FEE_BPS`.

---

## 2. Smoke tests

After Railway deploy:

```bash
# API must return JSON (not 502)
curl https://api.hood.markets/
# expect: "status":"ok", "webOnlyMode":true, "webDeploy":true

# CORS from your Vercel origin
curl -sI -H "Origin: https://hood.markets" https://api.hood.markets/api/web-deploy-config
# expect: access-control-allow-origin: https://hood.markets
```

If you see **502 Application failed to respond**, the Node process crashed on startup — check Railway **Logs** (missing env var, wrong root directory, or build failure). Browser console will show CORS errors even when the real issue is a 502.

Common log errors:

- `Missing required environment variable: DEPLOYER_PRIVATE_KEY`
- `Missing required environment variable: PRIVY_APP_ID`
- `HOODMARKETS_FACTORY (or LIQUID_FACTORY) is required`
- `Cannot find module` → Root Directory is not set to `api`

---

## 3. DNS

| Record | Points to |
|--------|-----------|
| `hood.markets` | Vercel (frontend) |
| `www` | Vercel or redirect to apex |
| `api.hood.markets` | Railway custom domain |

Set `VITE_API_URL=https://api.hood.markets` on Vercel.

---

## Architecture

```
hood.markets (Vercel web/)  →  api.hood.markets (Railway api/)  →  HoodMarkets contracts (4663)
                                      ↑
                         contracts/deployed-robinhood-mainnet.json
```

See also: [`ROBINHOOD_DEPLOY.md`](ROBINHOOD_DEPLOY.md), [`api/RAILWAY_ENV_CHECKLIST.md`](../api/RAILWAY_ENV_CHECKLIST.md).
