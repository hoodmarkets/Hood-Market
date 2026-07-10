# hood.markets — Contracts & SDK

> **Developer hub:** [hood.markets/Dev](https://hood.markets/Dev)

> Robinhood Chain (**4663**) · Open infrastructure — deploy from any site, agent, or script.

| Resource | Link |
|----------|------|
| **Contracts / API / docs** | [github.com/hoodmarkets/Hood-Market](https://github.com/hoodmarkets/Hood-Market) |
| **SDK guide** | [docs/sdk.md](https://github.com/hoodmarkets/Hood-Market/blob/main/docs/sdk.md) |
| **Agent API** | [hood.markets/agent.md](https://hood.markets/agent.md) |
| **Bankr skill** | [hoodmarkets/Hood-Market-Skill](https://github.com/hoodmarkets/Hood-Market-Skill) |
| **V3 contract docs** | [docs/HOODMARKETS_V3.md](https://github.com/hoodmarkets/Hood-Market/blob/main/docs/HOODMARKETS_V3.md) |

---

## Platform fees (only two)

| Fee | Split | When |
|-----|--------|------|
| **Uniswap swap / trading fees** | **5%** hood.markets platform · **95%** pro-rata to Holder NFT share holders | Embedded in `HoodMarketsV3LpLocker` at `claimTradingFees()` |
| **Share marketplace sales** (`buyShares`) | **5%** of listed price · **95%** to seller | When someone buys a share listing |

No platform fee on sends, batch airdrops (`airdropShares`), list/cancel escrow, mint/burn, or buyer-reward mints. **5% only on `buyShares` marketplace sales.**

---

## What you can do

### Launch & trade

| Action | How |
|--------|-----|
| **Deploy a token** | SDK `deployToken()`, factory `deployToken()`, or `POST https://api.hood.markets/api/deploy` |
| **Buy / sell the token** | [Uniswap on Robinhood Chain](https://app.uniswap.org/swap?chain=robinhood) — launch LP is **locked**; users swap, not “fund LP” |
| **List on DexScreener** | Automatic for simple (V3) launches |

### Holder NFTs (every simple launch)

Each token gets **1,000 ERC-1155 shares** = **10% of supply** vaulted at launch. All shares mint to the **fee recipient** wallet.

#### What shares represent

Holder NFTs are **not** Uniswap LP tokens. They bundle two rights:

| Right | Meaning |
|-------|---------|
| **Vault slice** | `1/1,000` of the **10%** token supply locked in the fraction contract — withdraw via `redeem` (burn shares) |
| **Fee slice** | `1/1,000` of the **95%** Uniswap trading-fee stream (after hood.markets takes 5% in the locker on each claim) |

The other **90%** of supply seeds a **locked** Uniswap V3 LP at launch. Trading fees accrue in that LP; `claimTradingFees()` pulls them and pays share holders. You cannot “deposit into launch LP” on hood.markets — buy the token on Uniswap or buy shares on listings instead.

Community Launch backers receive shares **pro-rata** to ETH contributed when the round finalizes.

#### What you can do

| Action | On-chain | Notes |
|--------|----------|--------|
| **Send shares** | `safeTransferFrom` | Full amount — no platform fee (v0.11+) |
| **Batch airdrop** | `airdropShares(recipients[], amounts[])` | **One tx**, full amounts (v0.10+ bytecode; v0.11+ no skim). hood.markets probes contract before batch. |
| **List shares for sale** | `listShares(amount, paymentToken, price)` | Escrow in contract |
| **Buy a listing** | `buyShares(listingId)` | **5%** platform on sale price |
| **Cancel listing** | `cancelListing(listingId)` | Shares return to seller |
| **Claim swap fees** | `claimTradingFees()` | One tx pays **all** share holders pro-rata (5%/95% split in locker first) |
| **Redeem vault** | `redeem(amount)` | Burn shares → withdraw underlying tokens (forfeit fee rights on burned shares) |
| **Buyer rewards** | `fundBuyerRewardPool` / `cancelBuyerRewardPool` / `issueBuyerShare` | Opt-in **post-launch** on token page (v0.9+) — not on hood.markets launch form |

### Web launch (hood.markets UI)

- **Someone else** fee recipient: **`0x…` wallet address only** — not `@handle` or profile URL.
- **Buyer rewards:** token page after launch — not at deploy.

Lookup fraction contract: `factory.fractionCollectionForToken(tokenAddress)`

#### How claiming works

1. Swaps on the token’s Uniswap pool accrue fees in the **locked LP** (`HoodMarketsV3LpLocker`).
2. Anyone calls **`claimTradingFees()`** on the fraction contract — permissionless.
3. Locker sends **5%** → platform wallet, **95%** → fraction contract.
4. Fraction contract credits **all share holders pro-rata** in one transaction.

| Where | How |
|-------|-----|
| Token page | **Claim trading fees** in Holder NFTs panel or sidebar |
| API | `POST /api/deployments/:token/claim-fees`, `POST /api/agent/claim`, `POST /api/agent/claim-for-recipient` (launcher pays gas) |
| SDK / wallet | `writeContract` on fraction with `claimTradingFees` |

You do **not** need to be the fee recipient to trigger a claim — but you need shares to receive a payout. Legacy **v0.6** tokens: `factory.claimRewards(token)` (fee wallet only).

### Agents & automation

| Action | API |
|--------|-----|
| Deploy | `POST /api/deploy` |
| Claim swap fees (gasless) | `POST /api/agent/claim` or `POST /api/agent/claim-for-recipient` |
| Token info + Uniswap link | `GET /api/agent/token-info` |
| Catalog | `GET /api/deployments` |

See [agent.md](https://hood.markets/agent.md) and Bankr skill `references/AGENT-API.md`.

---

## Contracts (Robinhood mainnet, v0.11.0)

Source of truth: [`contracts/deployed-hoodmarkets-v3-mainnet.json`](https://github.com/hoodmarkets/Hood-Market/blob/main/contracts/deployed-hoodmarkets-v3-mainnet.json)

| Contract | Address |
|----------|---------|
| HoodMarketsV3 factory | `0x9BDdC8ddf28f5629C989A36Eb5bb6C73cBA60Df5` |
| HoodMarketsV3 vault | `0x856c6997A86752fB3E6A494AB93107B7A371A57f` |
| HoodMarketsV3 LP locker | `0x23a1c52F4E93B0283d12CC16c29Df119803E8745` |
| HoodMarketsV3 fraction deployer | `0x40A19d561b3200A2C9E1014248FcEB724c450692` |
| Platform fee wallet (5%) | `0xbfD1be7a12A9FeF04D281C2D8D0D9EE15b576d98` |
| Contract owner | `0xFA45A3b8d1662E3432D1B5bE3F37e4923D1b796C` |
| WETH | `0x0Bd7D308f8E1639FAb988df18A8011f41EAcAD73` |
| Uniswap V3 SwapRouter02 | `0xCaf681a66D020601342297493863E78C959E5cb2` |
| Uniswap V3 factory | `0x1f7d7550B1b028f7571E69A784071F0205FD2EfA` |
| Uniswap V3 position manager | `0x73991a25C818Bf1f1128dEAaB1492D45638DE0D3` |

**Pro launches (V4):** see [`contracts/deployed-robinhood-mainnet.json`](https://github.com/hoodmarkets/Hood-Market/blob/main/contracts/deployed-robinhood-mainnet.json)

**Legacy V3 factories** (existing tokens keep their bytecode): v0.10 `0xf655…85C9`, v0.9 `0x3a94…76c8`, v0.8 `0xC2A6…00e8` — full list in [`known-contracts.json`](https://github.com/hoodmarkets/Hood-Market-Skill/blob/main/known-contracts.json)

Explorer: [robinhoodchain.blockscout.com](https://robinhoodchain.blockscout.com)

---

## Integrate (API + contracts)

Public source: [github.com/hoodmarkets/Hood-Market](https://github.com/hoodmarkets/Hood-Market)

### Agent / HTTP deploy

```bash
curl -X POST https://api.hood.markets/api/deploy \
  -H "Content-Type: application/json" \
  -H "X-Agent-Captcha-JWT: …" \
  -d '{"name":"My Token","symbol":"MTK","image":"ipfs://…","feeRecipient":"0x…"}'
```

### Direct on-chain

Call `HoodMarketsV3.deployToken` on the factory above. Foundry source: [`contracts/src/v31/`](https://github.com/hoodmarkets/Hood-Market/tree/main/contracts/src/v31)

Full guide: [docs/sdk.md](https://github.com/hoodmarkets/Hood-Market/blob/main/docs/sdk.md) · live copy: [hood.markets/sdk.md](https://hood.markets/sdk.md)

---

## On-chain: claim trading fees

```ts
const fraction = await publicClient.readContract({
  address: '0x9BDdC8ddf28f5629C989A36Eb5bb6C73cBA60Df5',
  abi: factoryAbi,
  functionName: 'fractionCollectionForToken',
  args: [tokenAddress],
});

await wallet.writeContract({
  address: fraction,
  abi: fractionAbi,
  functionName: 'claimTradingFees',
});
```

Locker sends **5% WETH → platform**, **95% → fraction contract**, then pro-rata to all share holders. Legacy v0.6 tokens: `factory.claimRewards(token)` instead.

---

## Integration paths

### 1. Direct on-chain / viem

Point at HoodMarketsV3 factory above. Foundry source: [`contracts/src/v31/`](https://github.com/hoodmarkets/Hood-Market/tree/main/contracts/src/v31)

### 2. hood.markets API (catalog + gasless deploy/claim)

- Preview: `POST https://api.hood.markets/api/deploy/preview`
- Catalog: `GET https://api.hood.markets/api/deployments`
- Agents: [agent.md](https://hood.markets/agent.md)

### 3. Fork & self-host

| Path | Purpose |
|------|---------|
| [`contracts/`](https://github.com/hoodmarkets/Hood-Market/tree/main/contracts) | Foundry — deploy your own factory |
| [`api/`](https://github.com/hoodmarkets/Hood-Market/tree/main/api) | Express launcher API |
| [`docs/`](https://github.com/hoodmarkets/Hood-Market/tree/main/docs) | SDK, agent, and deploy docs |

Deploy V3: `./scripts/deploy-hoodmarkets-v3.sh` from `contracts/`

---

## Redeploy factory

```bash
cd contracts
cp .env.robinhood.example .env.robinhood   # DEPLOYER_PRIVATE_KEY=0x…
./scripts/deploy-hoodmarkets-v3.sh
```

Update Railway `HOODMARKETS_V3_*` env vars — see [`api/RAILWAY_ENV_CHECKLIST.md`](https://github.com/hoodmarkets/Hood-Market/blob/main/api/RAILWAY_ENV_CHECKLIST.md)

---

## Support

- Contracts / API / docs: [github.com/hoodmarkets/Hood-Market](https://github.com/hoodmarkets/Hood-Market)
- Bankr skill: [github.com/hoodmarkets/Hood-Market-Skill](https://github.com/hoodmarkets/Hood-Market-Skill)
- Agents: [agent.md](https://hood.markets/agent.md)