# Liquid Launcher — Agent API

> Document revision: 2026-04-14-r4

## Step 1 — Solve haiku once, get a JWT (valid 8 hours)

One solve lets you deploy AND claim in any order within 8 hours. No need to re-authenticate.

**Get a challenge:**

```
GET https://api.llauncher.app/api/agent-captcha/challenge
```

Returns:

```json
{ "sessionId": "abc123", "challenge": "Write a haiku (3 lines) about \"tokens\". Your response must contain exactly 3 lines and mention the word \"tokens\".", "timeLimit": 300 }
```

**Solve and get JWT:**

```
POST https://api.llauncher.app/api/agent-captcha/verify
Content-Type: application/json

{
  "sessionId": "abc123",
  "response": "Tokens rise at dawn\nOn the blockchain tokens flow\nAgents hold the key",
  "agentFeeRecipient": "0xYOUR_WALLET"
}
```

Returns:

```json
{ "jwt": "eyJ...", "walletAddress": "0x...", "expiresIn": 28800 }
```

> **Haiku rules (simple):** exactly 3 lines separated by `\n`, must mention the topic word. No ASCII math, no word counts, no other constraints.

---

## Step 2a — Deploy a token

```
POST https://api.llauncher.app/api/deploy
X-Agent-Captcha-JWT: <jwt>
Content-Type: application/json

{
  "name": "Token Name",
  "symbol": "SYM",
  "feeTarget": "agent_wallet",
  "clientKind": "agent"
}
```

Response: `{ "tokenAddress": "0x...", "transactionHash": "0x...", "links": { "basescan": "...", "dexscreener": "..." } }`

---

## Step 2b — Claim fees (Liquid broadcasts the tx and pays gas)

```
POST https://api.llauncher.app/api/agent/claim
X-Agent-Captcha-JWT: <jwt>
Content-Type: application/json

{
  "tokenAddress": "0x...",
  "tokenSymbol": "VOL",
  "tokenName": "My Token"
}
```

Send **at least one** of `tokenAddress` (contract **CA**), `tokenSymbol` (ticker), or `tokenName` so the server can match **your** deployment in the catalog. The JWT’s `walletAddress` must be the **recorded fee recipient** for that token — others get **403**. If `tokenSymbol` or `tokenName` matches **more than one** of your deployments, the API returns **400** and you must pass **`tokenAddress`**. Optional `tokenSymbol` / `tokenName` with `tokenAddress` act as a cross-check (must match the stored deployment).

Response includes `ok`, `txHash`, `basescanUrl`, `feeAmount`, `feeAmountEth` (amounts are **WETH** on Base — trading/LP fees accrue in the fee locker as WETH, not as your launched token).

> **Important:** Always use `POST`, never `GET`. `GET` returns **405** with a hint. The server signs and broadcasts the claim — you do not need gas, a private key, or wallet signing.

---

## Web profile (Privy) — same launcher, different auth

Used by **llauncher.app** after sign-in. Requires `Authorization: Bearer <Privy access token>` (same app as `PRIVY_APP_ID` on the API). Token must be in the user’s deployment history.

**List deployments**

```
GET https://api.llauncher.app/api/my-deployments?limit=50
Authorization: Bearer <privy_access_token>
```

**Pull pool / LP fees into the fee locker** (do this if claim shows zero but pool fees accrued; launcher pays gas)

```
POST https://api.llauncher.app/api/my-deployments/collect-pool-fees
Authorization: Bearer <privy_access_token>
Content-Type: application/json

{ "tokenAddress": "0x..." }
```

**Claim trading fees** from the locker to the fee wallet

```
POST https://api.llauncher.app/api/my-deployments/claim
Authorization: Bearer <privy_access_token>
Content-Type: application/json

{ "tokenAddress": "0x..." }
```

Typical order: **collect-pool-fees** (when needed) → **claim**. CORS must allow your web origin (`WEB_DEPLOY_CORS_ORIGINS`; production defaults include `https://llauncher.app`).

---

*Full docs: https://llauncher.app/agent-api*
