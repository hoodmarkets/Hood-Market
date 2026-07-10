# HoodMarkets V3 simple launcher

DexScreener- and Uniswap-friendly token launches on **Robinhood Chain (4663)** using **Uniswap V3** pools (1% swap fee).

Forked from upstream v3.1 launchpad contracts and rebranded as **HoodMarkets** — no Clanker labels in our `src/v31/` code.

## Platform fees (only two)

| Fee | Split |
|-----|--------|
| **Uniswap swap / trading fees** | **5%** hood.markets platform · **95%** pro-rata to Holder NFT share holders (embedded in `HoodMarketsV3LpLocker` at `claimTradingFees()`) |
| **Share marketplace sales (`buyShares`)** | **5%** of listed price to platform · **95%** to seller |

No platform fee on wallet sends, batch airdrops, list/cancel escrow, mint/burn, or buyer-reward mints.

The 5% platform wallet is set at locker deploy (`HOODMARKETS_PLATFORM_FEE_RECIPIENT`). The locker **owner** can change the default platform wallet via `updateTeamRecipient()`.

## Embedded 1000-share fraction (v0.5.0+)

Every token launched through **HoodMarkets V3 v0.5.0+** automatically:

| Step | On-chain behavior |
|------|-------------------|
| **Vault** | **10%** of the 100B supply (`FRACTION_VAULT_PERCENTAGE = 10`) |
| **Fraction collection** | New `HoodMarketsV3TokenFraction` ERC-1155 per token (id `#0`, supply **1000**) |
| **Initial holder** | All 1,000 shares go to the fee recipient (`creatorAdmin`) at launch — send, sell, or airdrop via ERC-1155 transfer |
| **Trading fees (95%)** | Routed to the fraction contract; anyone calls `claimTradingFees()` once to pay all share holders pro-rata |
| **Share marketplace** | `listShares` / `buyShares` / `cancelListing` — on-chain escrow; buyer pays listed price; **5% platform fee** + 95% to seller |
| **Pool** | Remaining **90%** seeds the Uniswap V3 pool |

### What Holder NFT shares represent

Holder NFTs are **not** LP tokens. Each simple launch splits supply like this:

| Piece | What it is |
|-------|------------|
| **1,000 ERC-1155 shares** | Rights to **10% of token supply** held in the fraction vault + **pro-rata rights to 95%** of Uniswap swap fees (after the 5% platform cut in the locker) |
| **Locked Uniswap V3 LP** | The other **90%** of supply — fees accrue here, but LP NFT stays locked; shares are how you participate in the fee stream |
| **Per share** | `1/1000` of vault tokens (via `redeem`) + `1/1000` of the post-platform trading-fee payout on each `claimTradingFees()` |

At launch, all shares mint to the **fee recipient**. **Community Launch** backers receive shares proportional to ETH contributed when the round finalizes.

### What you can do with shares

| Action | Function | Notes |
|--------|----------|--------|
| Send | `safeTransferFrom` | No platform fee on sends (v0.11+) |
| Batch airdrop | `airdropShares(recipients[], amounts[])` | One tx, full amounts (v0.10+ bytecode) |
| List for sale | `listShares(amount, paymentToken, price)` | Shares escrow in contract |
| Buy listing | `buyShares(listingId)` | **5%** platform on sale price |
| Cancel listing | `cancelListing(listingId)` | Escrow returns to seller |
| Redeem vault | `redeem(amount)` | Burn shares → withdraw underlying launch tokens |
| Buyer rewards | `fundBuyerRewardPool` / `cancelBuyerRewardPool` | Fee recipient only — post-launch opt-in |
| Claim swap fees | `claimTradingFees()` | Permissionless — see below |

hood.markets token page: **Holder NFTs** panel for send, airdrop, list, redeem, buyer rewards, and claim.

## Buyer reward pool (opt-in, post-launch preferred)

Buyer rewards are **never on by default**. The fee recipient chooses how many shares to escrow:

| When | How |
|------|-----|
| **After launch (preferred)** | Fee recipient calls `fundBuyerRewardPool(amount)` on the fraction contract (v0.9+ bytecode) — or uses hood.markets token page “Reward on buy”. |
| **At deploy (API legacy)** | Optional `buyerRewardShareCount` (1–1000) in `POST /api/deploy` — shares mint to contract escrow instead of fee wallet. **Not** on hood.markets web launch form. |
| **Cancel** | `cancelBuyerRewardPool()` returns all **unused** escrow shares to the fee recipient. |

The API background poller and `POST /api/deployments/:token/process-buyer-rewards` call `issueBuyerShare` when escrow remains — gasless for holders, no wallet popup per buyer.

**v0.8 tokens** can escrow at deploy via `buyerRewardShareCount` but cannot fund/cancel post-launch (use v0.9+ factory for that).

There is **no SDK toggle** and **no optional vault config** — legacy `vaultConfig` values revert with `LegacyVaultDisabled`. Integrators call `deployToken` exactly as before; fractions are created inside the factory.

Lookup: `fractionCollectionForToken(tokenAddress)` on the factory, or `fractionCollection` in the `TokenCreated` event.

**Deployed on mainnet 4663 (2026-07-05 v0.11.0).** Update Railway `HOODMARKETS_V3_*` env vars to the addresses below.

### v0.9 buyer reward fund/cancel

- **`fundBuyerRewardPool(amount)`** — fee recipient escrows shares from wallet after launch (can add more while pool is active).
- **`cancelBuyerRewardPool()`** — returns unused escrow shares to fee recipient.

### v0.10 batch share airdrop

- **`airdropShares(recipients[], amounts[])`** — many recipients in **one** transaction (v0.10+ bytecode). v0.10 incorrectly skimmed 5% like wallet sends; fixed in v0.11.
- hood.markets token page probes the fraction contract and uses batch when supported (not legacy per-wallet sends).

### v0.11 sales-only share fees (deployed 2026-07-05)

- **Removed** 5% share skim on wallet sends and airdrops.
- **Kept** 5% platform fee on **`buyShares`** marketplace sales only.
- **`airdropShares`** delivers full amounts with no skim.

| Contract | Address |
|----------|---------|
| Factory | `0x9BDdC8ddf28f5629C989A36Eb5bb6C73cBA60Df5` |
| Deploy tx | `0xf291bfe09436850ea091ae8bc0f52f27edd7dd19d8d35afbde18c97c000bad8e` |

Update Railway `HOODMARKETS_V3_*` to match the deployed addresses table below.

### v0.7 fraction contract

- **`claimTradingFees()`** — one permissionless tx pulls LP fees and pays **every** share holder pro-rata (not caller-only).
- **`listShares` / `buyShares` / `cancelListing`** — on-chain marketplace; seller escrows shares, buyer pays listed price; **5%** to platform fee wallet (`teamRecipient`), **95%** to seller.

**Existing v0.6 tokens keep old behavior** (per-holder fee claim, no marketplace). **v0.7 tokens** have marketplace without share platform fees. **v0.8–v0.10** add 5% on share sales; **v0.8–v0.10 also skimmed wallet sends** (removed in v0.11).

### v0.8–v0.10 share platform fees (legacy fraction bytecode)

- **`buyShares`** — buyer pays the full listed price; **5%** ETH/ERC-20 to the locker’s platform fee wallet, **95%** to the seller.
- **Wallet transfers** — **5%** of shares skimmed to the platform fee wallet; recipient gets **95%** (integer rounding — transfers under ~20 shares may round to zero fee).
- Exempt: mint/burn, escrow (`listShares` / `cancelListing` / `buyShares` settlement), buyer-reward mints, transfers to/from the platform wallet.

**Existing v0.7 tokens** keep prior marketplace/transfer behavior without these fees.

## Deployed addresses (mainnet 4663)

| Contract | Address |
|----------|---------|
| HoodMarketsV3 factory (v0.11.0) | `0x9BDdC8ddf28f5629C989A36Eb5bb6C73cBA60Df5` |
| HoodMarketsV3Vault | `0x856c6997A86752fB3E6A494AB93107B7A371A57f` |
| HoodMarketsV3LpLocker | `0x23a1c52F4E93B0283d12CC16c29Df119803E8745` |
| HoodMarketsV3FractionDeployer | `0x40A19d561b3200A2C9E1014248FcEB724c450692` |
| Platform fee recipient (5%) | `0xbfD1be7a12A9FeF04D281C2D8D0D9EE15b576d98` |
| Contract owner | `0xFA45A3b8d1662E3432D1B5bE3F37e4923D1b796C` |

**Previous factory (v0.10.0):** `0xf65536Eb3354Ad7e77E1b0d0F7bEBFa1C88885C9`

**Previous factory (v0.9.0):** `0x3a94FD3422F50ed6cC08e547c6C697E4bb3e76c8`

**Previous factory (v0.8.0):** `0xC2A604fF131dDE9201838007A129ea28b85d00e8`

**Previous factory (v0.7.0):** `0x45A3820A9A563e78A4cF7F355F7Be10fA6B706B3`

**Previous factory (v0.5.0):** `0x4c18e43F8B8b63f42a944b98b8af29f576c7Ffa8`

**Previous factory (v0.3.1):** `0xcFE4D69Ac8e5F79a95d99e991162902f68029f09`

**Earlier test factory:** `0xa77911C301b30283ca3dBc32812839AdF443b39f`

Robinhood Uniswap V3 infra:

| Contract | Address |
|----------|---------|
| V3 Factory | `0x1f7d7550B1b028f7571E69A784071F0205FD2EfA` |
| V3 Position Manager | `0x73991a25C818Bf1f1128dEAaB1492D45638DE0D3` |
| V3 SwapRouter02 | `0xCaf681a66D020601342297493863E78C959E5cb2` |
| WETH | `0x0Bd7D308f8E1639FAb988df18A8011f41EAcAD73` |

## Contract deploy

```bash
cd contracts
# .env.robinhood: DEPLOYER_PRIVATE_KEY, ROBINHOOD_RPC_URL, WETH, plus:
# UNISWAP_V3_FACTORY, UNISWAP_V3_POSITION_MANAGER, UNISWAP_V3_SWAP_ROUTER
# HOODMARKETS_PLATFORM_FEE_RECIPIENT=<hoodfees treasury — 5% of swap fees>
# HOODMARKETS_OWNER=<admin wallet — defaults to deployer if unset>
forge script script/robinhood/10_DeployHoodMarketsV3.s.sol:DeployHoodMarketsV3 \
  --rpc-url "$ROBINHOOD_RPC_URL" --broadcast --slow
```

## API / Railway env

Add to `api.hood.markets` (alongside existing V4 vars):

```env
HOODMARKETS_V3_FACTORY=0x9BDdC8ddf28f5629C989A36Eb5bb6C73cBA60Df5
HOODMARKETS_V3_VAULT=0x856c6997A86752fB3E6A494AB93107B7A371A57f
HOODMARKETS_V3_LP_LOCKER=0x23a1c52F4E93B0283d12CC16c29Df119803E8745
HOODMARKETS_V3_FRACTION_DEPLOYER=0x40A19d561b3200A2C9E1014248FcEB724c450692
HOODMARKETS_V3_PLATFORM_FEE_RECIPIENT=0xbfD1be7a12A9FeF04D281C2D8D0D9EE15b576d98
HOODMARKETS_DEFAULT_LAUNCH_MODE=simple
```

### Changing wallets

| Role | Env var | Notes |
|------|---------|-------|
| **Deployer** (pays gas + launch seed) | `DEPLOYER_PRIVATE_KEY` | Fund this wallet on Robinhood |
| **Platform 5% fees** | `HOODMARKETS_PLATFORM_FEE_RECIPIENT` at deploy, or `updateTeamRecipient` on locker | New tokens use updated default |
| **V4 platform slice** (optional) | `PLATFORM_FEE_RECIPIENT` + `PLATFORM_FEE_BPS` | Pro launches only |

## Web launch modes

- **Simple** (default): `launchMode: "simple"` → HoodMarkets V3
- **Pro**: `launchMode: "pro"` → existing HoodMarkets V4 hook stack

**hood.markets Launch tab (web UI):**

- **Fee recipient “Someone else”** — **`0x…` wallet address only** (not `@handle` or profile URL).
- **Buyer rewards** — configured **after launch** on the token page (`fundBuyerRewardPool`), not at deploy.
- **Holder NFT airdrop** — “Airdrop to many” uses `airdropShares` in one transaction when fraction bytecode supports it (v0.10+).

## Claiming V3 fees

### Flow

1. Swaps on the token’s Uniswap V3 pool generate trading fees inside the **locked LP position** (`HoodMarketsV3LpLocker`).
2. Anyone calls **`claimTradingFees()`** on the token’s Holder NFT / fraction contract (`factory.fractionCollectionForToken(tokenAddress)`). No special role required to trigger the tx.
3. The locker collects accrued fees from the LP, sends **5%** to the hood.markets platform wallet, and forwards **95%** to the fraction contract.
4. The fraction contract credits **every current share holder pro-rata** by ERC-1155 balance. Holders do not each need to claim separately — one tx pays everyone.

### Where to claim

| Path | How |
|------|-----|
| **Token page** | **Claim trading fees** in the Holder NFTs section or sidebar — any connected wallet can submit the tx |
| **API (gasless)** | `POST /api/deployments/:token/claim-fees`, `POST /api/agent/claim`, or `POST /api/agent/claim-for-recipient` — launcher wallet pays gas |
| **On-chain** | `wallet.writeContract({ address: fraction, functionName: 'claimTradingFees' })` |

**Legacy v0.6** tokens without the fraction marketplace use `HoodMarketsV3.claimRewards(token)` on the factory — **fee recipient wallet only**, not pro-rata.

## Redeploy V3 (v0.7+)

From `contracts/` with `.env.robinhood` funded:

```bash
forge test --match-contract HoodMarketsV3TokenFractionTest

forge script script/robinhood/10_DeployHoodMarketsV3.s.sol:DeployHoodMarketsV3 \
  --rpc-url "$ROBINHOOD_RPC_URL" --broadcast --slow -vvv
```

Copy logged addresses into Railway (`api/RAILWAY_ENV_CHECKLIST.md`):

- `HOODMARKETS_V3_FACTORY`
- `HOODMARKETS_V3_VAULT`
- `HOODMARKETS_V3_LP_LOCKER`
- `HOODMARKETS_V3_FRACTION_DEPLOYER` (implicit in factory init — log line `HoodMarketsV3FractionDeployer`)
- Keep `HOODMARKETS_V3_PLATFORM_FEE_RECIPIENT` unless changing treasury

Then **Redeploy Railway API** and **Vercel web**. Optional: verify new factory on Blockscout (`contracts/scripts/verify-robinhood.sh` pattern for V3 contracts).

**Do not** mark the old factory `deprecated` until you are ready — existing tokens stay on the old fraction bytecode forever.

## Move admin to a Gnosis Safe (later)

All three V3 contracts use OpenZeppelin `Ownable`. After you deploy a Safe on Robinhood Chain (4663), transfer admin in one script:

```bash
# .env.robinhood: DEPLOYER_PRIVATE_KEY = current owner (0xFA45…)
HOODMARKETS_V3_FACTORY=<deployed>
HOODMARKETS_V3_VAULT=<deployed>
HOODMARKETS_V3_LP_LOCKER=<deployed>
HOODMARKETS_NEW_OWNER=<safe address on 4663>

forge script script/robinhood/11_TransferOwnershipV3.s.sol:TransferOwnershipV3 \
  --rpc-url "$ROBINHOOD_RPC_URL" --broadcast
```

The **5% fee wallet** (`HOODMARKETS_PLATFORM_FEE_RECIPIENT`) is separate from owner. To change it later without redeploying, the locker owner calls `updateTeamRecipient(newTreasury)`.
