# hood.markets — Agent API

> **Developer hub:** [hood.markets/Dev](https://hood.markets/Dev) · **SDK & contracts:** [hood.markets/sdk.md](https://hood.markets/sdk.md)

> Robinhood Chain (4663) · API: `https://api.hood.markets` · Web: `https://hood.markets`

Bankr: install skill from [hoodmarkets/Hood-Market-Skill](https://github.com/hoodmarkets/Hood-Market-Skill) or [BankrBot/skills](https://github.com/BankrBot/skills).

---

## Platform fees (only two)

1. **Swap trading fees** — 5% platform / 95% pro-rata to Holder NFT share holders (`claimTradingFees()`)
2. **Share marketplace sales** — 5% of listed price on `buyShares` / 95% to seller

No fee on sends, airdrops, or other share moves (v0.11 factory).

---

## Contracts (Robinhood mainnet, v0.11.0)

| Contract | Address |
|----------|---------|
| HoodMarketsV3 factory | `0x9BDdC8ddf28f5629C989A36Eb5bb6C73cBA60Df5` |
| HoodMarketsV3 vault | `0x856c6997A86752fB3E6A494AB93107B7A371A57f` |
| HoodMarketsV3 LP locker | `0x23a1c52F4E93B0283d12CC16c29Df119803E8745` |
| HoodMarketsV3 fraction deployer | `0x40A19d561b3200A2C9E1014248FcEB724c450692` |
| Platform fee wallet (5%) | `0xbfD1be7a12A9FeF04D281C2D8D0D9EE15b576d98` |
| WETH | `0x0Bd7D308f8E1639FAb988df18A8011f41EAcAD73` |
| Uniswap V3 SwapRouter02 | `0xCaf681a66D020601342297493863E78C959E5cb2` |

Pinned JSON: [`known-contracts.json`](https://github.com/hoodmarkets/Hood-Market-Skill/blob/main/known-contracts.json)

**Legacy V3 factories** (existing tokens keep bytecode): v0.10 `0xf655…85C9`, v0.9 `0x3a94…76c8`, v0.8 `0xC2A6…00e8` — full list in `known-contracts.json`.

---

## Agent endpoints

| Method | Path | Purpose |
|--------|------|---------|
| GET | `/health` | API + chainId 4663 |
| GET | `/api/agent/briefing?wallet=0x…` | Tokens where wallet is fee recipient |
| GET | `/api/agent/preflight-deploy?…&launchMode=simple` | Blockers before captcha |
| GET | `/api/agent/token-info?token=0x…` | Metadata + Uniswap trade link |
| POST | `/api/agent/prepare-deploy` | Deploy checklist + preflight |
| POST | `/api/agent/resolve-deploy-image` | Tweet/logo resolution (X deploys) |
| POST | `/api/deploy` | Deploy token |
| POST | `/api/agent/claim` | Claim fees (fee recipient; launcher pays gas) |
| POST | `/api/agent/claim-for-recipient` | Anyone triggers claim for catalog token |
| POST | `/api/agent/prepare-buy` / `prepare-sell` | Pro tokens only → Bankr submit |
| POST | `/api/agent/prepare-fund-buyer-rewards` | Escrow Holder shares for buyer rewards (fee recipient → Bankr submit) |
| POST | `/api/agent/prepare-cancel-buyer-rewards` | Return unissued buyer-reward shares (fee recipient) |
| GET | `/api/deployments` | Public catalog |

**POST only on `https://api.hood.markets`** — not `hood.markets`.

---

## Auth

**X / Twitter:** confirm in-thread → `agentChannel: "x"` + `x-agent-channel: x` — no haiku.

**Other agents:** haiku JWT (8h):

```
GET  https://api.hood.markets/api/agent-captcha/challenge
POST https://api.hood.markets/api/agent-captcha/verify
{ "sessionId", "response", "agentFeeRecipient" }
```

---

## Deploy

```
GET https://api.hood.markets/api/agent/preflight-deploy?wallet=0x…&name=My+Token&symbol=MTK&launchMode=simple

POST https://api.hood.markets/api/deploy
X-Agent-Captcha-JWT: <jwt>
Content-Type: application/json

{
  "name": "Token Name",
  "symbol": "SYM",
  "feeTarget": "agent_wallet",
  "clientKind": "agent",
  "agentProvider": "bankr",
  "launchMode": "simple",
  "imageUrl": "https://…"
}
```

- Embeds **1,000 Holder NFT shares** (10% supply) to fee recipient
- Launch LP locked — users trade on Uniswap
- Gasless for user (launcher wallet pays)

**Web UI:** “Someone else” fee recipient = **`0x…` wallet only**. Buyer rewards: `prepare-fund-buyer-rewards` on X/Bankr or token page after launch.

---

## Buy / sell

```
GET https://api.hood.markets/api/agent/token-info?token=0x…
```

- **Simple (V3):** use `uniswapSwapUrl` — no hood.markets swap helper
- **Pro (V4):** `prepare-buy` / `prepare-sell` → Bankr `/wallet/submit` chain 4663

---

## Claim fees

```
POST https://api.hood.markets/api/agent/claim
{ "tokenAddress": "0x…" }

POST https://api.hood.markets/api/agent/claim-for-recipient
{ "tokenAddress": "0x…" }
```

- v0.7+ → `claimTradingFees()` on Holder NFT (pro-rata to all holders)
- **No Bankr `/wallet/submit`** — post `replyHint` when `ok: true`

---

## Holder NFTs (on token page / on-chain)

| Capability | Method |
|------------|--------|
| Send shares | `safeTransferFrom` (no fee v0.11) |
| Batch airdrop | `airdropShares` — **one tx** (v0.10+; hood.markets auto-detects) |
| List / buy / cancel | `listShares` / `buyShares` / `cancelListing` (5% on sale) |
| Claim swap fees | `claimTradingFees()` |
| Buyer rewards | `prepare-fund-buyer-rewards` / `prepare-cancel-buyer-rewards` → Bankr submit (fee recipient only) |

Full reference: skill `references/HOLDER-NFTS.md` · `references/AGENT-API.md`

---

## Community Launch (petition)

24h ETH raise on Robinhood → V3 deploy + pro-rata Holder NFT airdrop. **No JWT.**

| Intent | Flow |
|--------|------|
| Create | `GET /api/community-launch/preflight` → `POST /api/community-launch/create` |
| Back | `GET …/prepare-deposit` → Bankr submit (native ETH) → `POST …/confirm` |
| Status / list | `GET …/status?id=` · `GET …/list` |
| Refund / cancel | `POST …/refund` · `POST …/cancel` (creator) |

Web: [hood.markets/community-launch](https://hood.markets/community-launch) · Skill: `references/COMMUNITY-LAUNCH.md` · Index: [community-launch-api.json](https://hood.markets/community-launch-api.json)

---

## Briefing

```
GET https://api.hood.markets/api/agent/briefing?wallet=0x…
```

---

*Skill: `skills/hoodmarkets/` v21 · Contracts: [sdk.md](https://hood.markets/sdk.md)*
