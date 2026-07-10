# Liquid Social Launcher

Multi-platform token launcher for [Liquid Protocol](https://liquidprotocol.org) on Base.

Deploy tokens via Farcaster, Telegram, Discord, and X.

## Features

- 🚀 **One-command deployment** - Launch tokens instantly
- 💰 **User keeps 100% of fees** - You only pay gas (~$0.01)
- 🔗 **Multi-platform** - Farcaster, Telegram, Discord, X
- 🎯 **Smart wallet detection** - Auto-pulls Farcaster verified wallets
- 🔐 **Privy Integration** - Create embedded wallets for users (optional)
- 📊 **Auto-links** - Generates BaseScan, DexScreener, Liquid Protocol links

## Supported Platforms

| Platform | Wallet Source | Flow |
|----------|--------------|------|
| **Farcaster** | Verified/custody address, else **Privy** (same FID) | Mention deploy |
| **Telegram** | **Privy** (Telegram id) or manual address | Wizard / commands |
| **Discord** | **Privy** (Discord id) or optional `wallet` | `/deploy` |
| **X/Twitter** | **Privy** (X author id) or optional `0x` in tweet | Mention deploy |

## Web frontend

This repo is **API + bots only** (no bundled Vite app). Use a separate Privy + Vite host, for example **[privy-heart-landing](https://github.com/anondevv69/privy-heart-landing)** or **[privy-welcome-mat](https://github.com/anondevv69/privy-welcome-mat)**. Set `VITE_PRIVY_APP_ID`, `VITE_API_URL` (Railway API origin, no trailing slash), and any optional `VITE_*` vars there; the API must allow your site origin in `WEB_DEPLOY_CORS_ORIGINS`.

Agent / skill reference copies live in **`docs/agent-api.md`** and **`docs/launcher-skill.md`** (same material that used to ship under `web/public/`).

## Quick Start

### Farcaster
```
@liquidlauncher deploy TestToken TEST
```
Uses your verified/custody ETH address when present; otherwise your **Privy** fee wallet for this Farcaster identity (when enabled).

### Telegram
```
/deploy
```
Bot asks: name, symbol, description, wallet, dev buy amount.

Or quick mode:
```
/launch TestToken TEST 0xABC...
```

With Privy wallet:
```
/deploy
Bot: Creating wallet for you...
     🔐 Claim: https://auth.privy.io/login?app_id=xxx
```

### Discord
```
/deploy name:TestToken symbol:TEST
```
Fee wallet is your **Privy-linked** address whenever `PRIVY_APP_ID` and `PRIVY_APP_SECRET` are set (set `USE_PRIVY_WALLETS=false` to opt out). Optional `wallet:` overrides.

### X/Twitter
```
@liquidlauncher deploy TestToken TEST
```
No `0x` in the tweet required — fee wallet comes from **Privy** for your X account. You can still include an address to override.

## Setup

1. Clone and install:
```bash
git clone <repo>
cd liquid-social-launcher
npm install
```

2. Copy `.env.example` to `.env` and fill in:
```bash
# Required
DEPLOYER_PRIVATE_KEY=0x...        # Your Base wallet (pays gas)
NEYNAR_API_KEY=...                # Get from neynar.com
NEYNAR_SIGNER_UUID=...            # Bot's Farcaster signer

# Optional (enable platforms you want)
TELEGRAM_BOT_TOKEN=...            # From @BotFather
DISCORD_TOKEN=...
DISCORD_CLIENT_ID=...

# Optional - Privy (identity-linked fee wallets; on by default when both are set)
PRIVY_APP_ID=...                  # From dashboard.privy.io
PRIVY_APP_SECRET=...              # Server secret from Privy
# USE_PRIVY_WALLETS=false         # Uncomment to require explicit 0x fee addresses

# Optional
X_POSTING_ENABLED=true            # Auto-post to X
X_CONSUMER_KEY=...
X_CONSUMER_SECRET=...
X_ACCESS_TOKEN=...
X_ACCESS_TOKEN_SECRET=...
```

3. Run:
```bash
npm run dev     # Development
npm run build   # Build
npm start       # Production
```

## Privy Integration (Optional)

Privy enables your bot to create embedded wallets for users who don't have one.

### How it works:
1. User deploys from any platform (Discord, Telegram, X)
2. Bot creates or reuses a wallet linked to their platform identity
3. User opens the Liquid Launcher web app and signs in with the same social account
4. **Discord:** the server uses Privy’s `discord_oauth` identity (Discord user id + username/discriminator), matching the React app’s Discord login — **not** a separate `custom_auth` user, so the fee wallet matches the site.

### Security:
- **Discord:** same Privy user as OAuth login (`discord_oauth` subject)
- **Telegram / X / Farcaster:** server uses Telegram id or `custom_auth` until aligned with your web login strategy
- Only the original user can access the embedded wallet via Privy
- Claim links are public but identity-gated
- Users can link multiple social accounts to same wallet

### User Flow:
```
User on Discord: /deploy MyToken MTK

Bot: 🚀 Creating your wallet...
     💳 Address: 0xABC...
     
     🔐 Claim your wallet:
     https://auth.privy.io/login?app_id=xxx
     
     (Login with Discord to access your wallet)

User clicks → Logs in with Discord → Wallet claimed!
```

## Environment Variables

| Variable | Required | Description |
|----------|----------|-------------|
| `DEPLOYER_PRIVATE_KEY` | ✅ | Private key for gas payments |
| `NEYNAR_API_KEY` | ✅ | Neynar API key |
| `NEYNAR_SIGNER_UUID` | ✅ | Bot's Farcaster signer UUID |
| `PRIVY_APP_ID` | ❌ | Privy app ID (for wallet creation) |
| `PRIVY_APP_SECRET` | ❌ | Privy server secret |
| `USE_PRIVY_WALLETS` | ❌ | Set `false` to disable Privy fee wallets (default: on when Privy keys are set) |
| `BASE_RPC_URL` | ❌ | Base RPC (default: mainnet.base.org) |
| `TELEGRAM_BOT_TOKEN` | ❌ | Telegram bot token |
| `LAUNCHER_WEB_URL` | ❌ | Public URL of the Liquid Launcher web app (Privy login / export wallet link in Telegram deploy success) |
| `DISCORD_TOKEN` | ❌ | Discord bot token |
| `DISCORD_CLIENT_ID` | ❌ | Discord application ID |
| `X_POSTING_ENABLED` | ❌ | Auto-post deployments to X |
| `X_*` | ❌ | X API credentials |

## Architecture

```
┌─────────────┐  ┌─────────────┐  ┌─────────────┐  ┌─────────────┐
│  Farcaster  │  │  Telegram   │  │   Discord   │  │      X      │
└──────┬──────┘  └──────┬──────┘  └──────┬──────┘  └──────┬──────┘
       │                │                │                │
       └────────────────┴────────────────┴────────────────┘
                          │
                   ┌──────▼──────┐
                   │   Neynar    │  (wallet lookup)
                   └──────┬──────┘
                          │
                   ┌──────▼──────┐
                   │   Bot API   │  (deploy tokens)
                   └──────┬──────┘
                          │
              ┌───────────┼───────────┐
              │           │           │
         ┌────▼───┐  ┌───▼────┐  ┌───▼────┐
         │  Base  │  │ Privy  │  │Discord │
         │(Liquid)│  │(Wallet)│  │(Debug) │
         └────────┘  └────────┘  └────────┘
```

## Fee Structure

- **Gas**: Paid by deployer wallet (~$0.01 per deployment)
- **Platform fee**: None (user keeps 100% of trading fees)
- **Protocol fee**: 20% of LP fees go to Liquid Protocol

## Links

- [Liquid Launcher web UI — privy-heart-landing](https://github.com/anondevv69/privy-heart-landing)
- [Liquid Launcher web UI — privy-welcome-mat](https://github.com/anondevv69/privy-welcome-mat)
- [Liquid Protocol](https://liquidprotocol.org)
- [Neynar Docs](https://docs.neynar.com)
- [Base Docs](https://docs.base.org)
- [Privy Docs](https://docs.privy.io)

## License

MIT
