# Liquid Protocol Analysis

**Date:** April 9, 2026  
**Analyzed Repositories:**
1. https://github.com/Liquid-Protocol-Ops/SDK
2. https://github.com/Liquid-Protocol-Ops/liquid-protocol-v0

---

## Executive Summary

Liquid Protocol is a token factory on Base (chain ID 8453) that deploys ERC-20 tokens with integrated Uniswap V4 liquidity pools. The protocol features permanently locked liquidity, configurable fee structures, MEV protection via sniper auctions, and an extensible system for custom behaviors.

**Key Finding:** The protocol is a **closed extension ecosystem** — new extensions require full third-party audits, Uniswap alignment approval, and multisig consensus. **Revenue capture via our platform is NOT feasible through extensions.** Alternative fee capture approaches exist through standard fee mechanisms.

---

## 1. Repository Structure & Folder Organization

### 1.1 Liquid Protocol V0 (Contracts)

```
liquid-protocol-v0/
├── src/
│   ├── Liquid.sol                    # Factory contract (orchestrator)
│   ├── LiquidToken.sol               # ERC-20 token implementation
│   ├── LiquidFeeLocker.sol           # Fee escrow & claims
│   ├── hooks/
│   │   ├── LiquidHookV2.sol          # Base hook (pool init, callbacks, MEV)
│   │   ├── LiquidHookStaticFeeV2.sol # 1% fee (default)
│   │   ├── LiquidHookDynamicFeeV2.sol # Dynamic fees (1%-5%)
│   │   └── LiquidPoolExtensionAllowlist.sol # Per-pool extension gating
│   ├── extensions/
│   │   ├── LiquidAirdropV2.sol       # Merkle-based airdrop
│   │   ├── LiquidVault.sol           # Token lockup + vesting
│   │   ├── LiquidUniv4EthDevBuy.sol  # Buy tokens at launch
│   │   ├── LiquidUniv3EthDevBuy.sol  # V3 dev buy
│   │   ├── LiquidPresaleEthToCreator.sol # Presale with ETH forwarding
│   │   └── LiquidPresaleAllowlist.sol # Allowlisted presale
│   ├── lp-lockers/
│   │   └── LiquidLpLockerFeeConversion.sol # Lock LP, manage rewards, convert fees to ETH
│   ├── mev-modules/
│   │   ├── LiquidSniperAuctionV2.sol # MEV protection auction
│   │   ├── LiquidMevDescendingFees.sol # Fee decay logic (80%→40% over 20s)
│   │   └── LiquidSniperUtilV2.sol    # Auction utilities
│   ├── interfaces/                   # ILiquid*, ILiquidHook*, etc.
│   ├── utils/                        # LiquidDeployer, OwnerAdmins
│   └── archive/                      # Deprecated v4.0 contracts
├── foundry.toml                      # Build config (Solidity 0.8.28)
├── EXTENSION-ALLOWLIST.md            # Extension approval process
└── README.md
```

### 1.2 SDK (TypeScript)

```
SDK/
├── skills/
│   ├── sdk-overview.md              # Comprehensive API reference
│   ├── deploy-token.md              # Token deployment workflows
│   ├── bid-in-auction.md            # Sniper auction bidding
│   └── index-tokens.md              # Token discovery
├── src/
│   ├── index.ts                     # Main SDK export
│   ├── types/                       # DeployTokenParams, DeploymentConfig, etc.
│   ├── client/LiquidSDK.ts          # Main SDK class
│   ├── utils/                       # Tick math, position helpers, encoding
│   ├── abis/                        # Contract ABIs (LiquidFactory, etc.)
│   └── constants/                   # ADDRESSES, EXTERNAL, FEE, DEFAULTS
├── package.json
└── README.md
```

---

## 2. Token Deployment Flow

### 2.1 High-Level Deployment Process

When `sdk.deployToken()` is called, a **single transaction** executes the following sequence:

```
1. Deploy ERC-20 Token (100 billion supply)
   └─ CREATE2 deterministic deployment
   
2. Initialize Uniswap V4 Pool
   └─ Calls hook.initializePool() → creates PoolKey
   
3. Place Liquidity (via LP Locker)
   └─ Approve token to LP Locker
   └─ LP Locker mints position(s) in Uniswap V4
   └─ LP is permanently locked (non-ruggable)
   
4. Configure MEV Protection
   └─ Initialize sniper auction on hook
   └─ Sets up fee decay (80%→40% over 20s)
   
5. Execute Extensions (if any)
   └─ Allocate token supply to extensions
   └─ Send tokens + ETH to extension contracts
   
6. Emit TokenCreated Event
   └─ Contains all deployment data
```

### 2.2 Deployment Parameters (from SDK)

#### Required Parameters
- `name` (string) - Token name
- `symbol` (string) - Token symbol

#### Optional Parameters (with defaults)

| Parameter | Type | Default | Purpose |
|-----------|------|---------|---------|
| `image` | URL/IPFS | "" | Token icon (256x256 PNG recommended) |
| `metadata` | JSON string | "" | Description, social links, audit URLs |
| `context` | JSON string | `{"interface":"SDK"}` | Attribution/tracking data |
| `tokenAdmin` | Address | msg.sender | Can update image/metadata |
| `hook` | Address | HOOK_STATIC_FEE_V2 | Fee logic contract |
| `pairedToken` | Address | WETH | Quote token (always WETH on Base) |
| `poolData` | Hex | 1% buy + 1% sell | Encoded fee configuration |

#### Liquidity Position Parameters

| Parameter | Type | Default | Purpose |
|-----------|------|---------|---------|
| `tickIfToken0IsLiquid` | number | -230400 | Starting tick (~10 ETH / ~$20K cap) |
| `tickSpacing` | number | 200 | Uniswap V4 spacing |
| `tickLower[]` | number[] | [5 values] | Position lower bounds |
| `tickUpper[]` | number[] | [5 values] | Position upper bounds |
| `positionBps[]` | number[] | [10%, 50%, 15%, 20%, 5%] | Supply % per position |

#### Reward Configuration

| Parameter | Type | Default | Purpose |
|-----------|------|---------|---------|
| `rewardRecipients[]` | Address[] | [msg.sender] | Fee destination addresses |
| `rewardAdmins[]` | Address[] | [msg.sender] | Who can update recipients |
| `rewardBps[]` | number[] | [10000] | Fee % per recipient (sum = 10000) |

#### Extensions & MEV

| Parameter | Type | Default | Purpose |
|-----------|------|---------|---------|
| `extensions[]` | ExtensionConfig[] | [] | Dev buy, vault, airdrop, presale |
| `mevModule` | Address | SNIPER_AUCTION_V2 | MEV protection |
| `mevModuleData` | Hex | auto-encoded | Auction parameters |
| `devBuy` | DevBuyParams | none | Buy tokens at launch |

### 2.3 Default Liquidity Position Layout (5-Tranche Liquid)

The default deployment creates 5 liquidity positions across the token's price curve:

| Position | Supply % | Tick Range | Market Cap Range (@$2,000 ETH) |
|----------|----------|-----------|------------------------------|
| 1 (bottom) | 10% | -230,400 → -216,000 | ~$20K → ~$83K |
| 2 (core) | 50% | -216,000 → -155,000 | ~$83K → ~$37M |
| 3 (mid) | 15% | -202,000 → -155,000 | ~$338K → ~$37M |
| 4 (upper) | 20% | -155,000 → -120,000 | ~$37M → ~$1.2B |
| 5 (top) | 5% | -141,000 → -120,000 | ~$151M → ~$1.2B |

**Purpose:** Provides deep liquidity at multiple price points, supporting token growth from $20K to $1B+ market cap.

### 2.4 Transaction Gas Cost

Not explicitly documented, but typical deployment involves:
- Token creation (CREATE2)
- Pool initialization
- Position minting (5 positions)
- MEV module setup
- Extension triggers (if any)

**Estimated:** ~2-3 million gas units (varies with extensions)

---

## 3. Fee & Commission Structure

### 3.1 LP Fees (Trading Fees)

LP fees are applied when users swap tokens through the Uniswap V4 pool.

#### Default Fee Configuration
- **Buy fee:** 1% (from WETH)
- **Sell fee:** 1% (to WETH)
- **Fee type:** Static (configured by hook)

#### Dynamic Fee Alternative
Optional hook (`LiquidHookDynamicFeeV2`) supports 1%-5% range:
- Base: 0.3%-1%
- Max: up to 5%
- Volatility-responsive adjustments

#### Fee Flow

```
Swap occurs (User A buys 1000 tokens with 1 WETH)
│
├─ 0.01 WETH goes to fee mechanism
│
├─ Fee is collected by Uniswap V4 Pool Manager
│
├─ Hook (LiquidHookV2) processes fee callback
│
├─ Locker (LiquidLpLockerFeeConversion) receives fee
│
├─ Fee is converted to WETH (already WETH if paired token is WETH)
│
├─ Fee is distributed to reward recipients per rewardBps split
│
└─ Recipients can claim via sdk.claimFees(owner, token)
```

### 3.2 Fee Capture Points & Addressable Components

#### 1. **LP Fee Percentage (Mutable)**
- Set by deployer via `poolData` encoding
- Currently: 1% each direction (default)
- Can be 0%-5% via dynamic fee hook
- **Possible for us:** Could suggest/force a custom fee split through our platform

#### 2. **Fee Recipient Configuration (Immutable)**
- `rewardRecipients[]` - who gets paid
- `rewardBps[]` - what % each recipient gets
- Set at deployment
- **Possible for us:** Include ourselves as a reward recipient (e.g., 1% of 1% = 0.01 bps)

#### 3. **Team Fee Recipient (Factory-level)**
- Factory has `teamFeeRecipient` address
- Method: `claimTeamFees(address token)` by owner/admin
- **Not usable by us:** This is set by Liquid Protocol owner, not customizable per deployment

#### 4. **Extension Fees (if used)**
- Presale extensions can charge in ETH
- Extensions can implement custom fee logic
- **Blocked for us:** New extensions require 3rd-party audits + multisig approval

### 3.3 How Our Platform Could Capture Fees

#### Option A: Custom Reward Recipient (Recommended)
```
Deployment flow:
1. User deploys token via our platform
2. We set rewardRecipients to include our platform address
3. We allocate 1-2% of fees to ourselves

Example:
- rewardRecipients: [creator, platformAddress]
- rewardBps: [9800, 200]  // Creator gets 98%, we get 2%
- When LPs accrue fees, 2% goes to us

Pros:
- Simple, no new contracts needed
- Automatic via existing fee system
- Transparent to users

Cons:
- Permanent share of all fees from that token
- Requires user trust
- Could be seen as platform rent-extraction
```

#### Option B: Fee-at-Deployment (Custom Extension)
```
Charge a one-time deployment fee in ETH
- ETH collected at deployment time
- Sent to our treasury
- Added to platform cost model

Pros:
- Clear one-time cost
- Doesn't affect ongoing fees

Cons:
- Requires new extension contract
- Requires 3rd-party audit ($10K-50K)
- Requires Uniswap alignment approval
- Requires multisig approval from Liquid Protocol admin
- 6-12 month approval process
```

#### Option C: Presale Extension Wrapper
```
Integrate with LiquidPresaleEthToCreator extension
- We host presale for users
- Platform collects small % of ETH
- Works within existing extension

Pros:
- Reuses existing, audited extension
- Flexible fee capture

Cons:
- Only applies to tokens using presale
- Still need to get us whitelisted as extension caller
```

---

## 4. Extension System

### 4.1 How Extensions Work

Extensions are optional smart contracts that execute custom logic during token deployment. They receive a portion of token supply and/or ETH msg.value.

#### Extension Interface
```solidity
interface ILiquidExtension {
  function supportsInterface(bytes4 interfaceId) external pure returns (bool);
  
  function receiveTokens(
    DeploymentConfig deploymentConfig,
    PoolKey poolKey,
    address token,
    uint256 extensionSupply,
    uint256 extensionIndex
  ) external payable;
}
```

#### Extension Lifecycle
```
1. Deployer calls deployToken() with extensions array
2. Factory validates extensions:
   - Total supply % for extensions ≤ 90%
   - Each extension is whitelisted (enabledExtensions[address])
   - msg.value matches sum of extension msgValue
   
3. Factory calls extension.receiveTokens():
   - extensionSupply = tokens allocated to this extension
   - msg.value = ETH sent to extension
   - extension has access to pool config & deployment context
   
4. Extension executes custom logic:
   - Dev buy: swap ETH for tokens
   - Vault: lock tokens with vesting schedule
   - Airdrop: set merkle root
   - Presale: configure presale params
```

### 4.2 Current Allowlisted Extensions

| Extension | Address | Purpose | Audited |
|-----------|---------|---------|---------|
| LiquidAirdropV2 | `0x1423974d...` | Merkle-based token distribution | ✓ 0xMacro + Cantina |
| LiquidVault | `0xdFCCC93...` | Lockup + linear vesting | ✓ |
| LiquidUniv4EthDevBuy | `0x5934097...` | Buy tokens at launch (V4) | ✓ |
| LiquidUniv3EthDevBuy | `0x376028...` | Buy tokens at launch (V3) | ✓ |
| LiquidPresaleEthToCreator | `0x3bca63...` | Presale → ETH to creator | ✓ |
| LiquidPresaleAllowlist | `0xCBb4cc...` | Allowlist-gated presale | ✓ |

**Status:** No new extensions planned. Current stance: "rare exceptions, not a standard pathway."

### 4.3 Can We Hook In as an Extension? (Analysis)

**Short Answer:** Not easily, and not recommended.

#### Extension Approval Requirements (from EXTENSION-ALLOWLIST.md)

```
To be approved, ALL of:
1. ✓ Full 3rd-party audit (recognized firm: 0xMacro, Cantina, OpenZeppelin)
   Cost: $15K-50K
   Time: 4-8 weeks

2. ✓ Uniswap alignment (Uniswap Foundation approval)
   - Must demonstrate Uniswap V4 hook alignment
   - Or approval from Uniswap core contributor
   - Time: 2-4 weeks

3. ✓ Internal review (Liquid Protocol engineering lead)
   - Code review + security analysis
   - Time: 1-2 weeks

4. ✓ Multisig approval (Gnosis Safe: 0x872c561f)
   - Minimum 2-3 signatures from admins
   - Governance: Could be blocked indefinitely

Contact: slaterg@mog.capital + admin@mog.capital
```

#### Why It's Not Feasible

1. **Governance Resistance:** Liquid Protocol explicitly states: *"No plans to approve additional extensions at this time."*

2. **Audit Cost & Time:** $15K-50K + 4-8 weeks for external audit.

3. **Uniswap Dependency:** Requires Uniswap Foundation sign-off, adding external approval layer.

4. **Multisig Veto Power:** Even with all approvals, multisig could block (3+ signatures required).

5. **No Clear Value:** Unless our extension provides unique value (e.g., novel MEV protection, cross-chain bridging), approval is unlikely.

### 4.4 Alternative: Custom Presale Strategy

Instead of a new extension, we could:

1. **Integrate with existing `LiquidPresaleEthToCreator` extension**
2. **Offer a hosted presale service** that uses this extension
3. **Capture fees through custom reward recipient** in the pool

This requires **zero new contracts** and works within the existing extension system.

---

## 5. Existing Launchers & UI Implementations

### 5.1 Official Implementations

**SDK:**
- TypeScript SDK (npm: `liquid-sdk`)
- Agent skills for programmatic deployment
- Command-line usage via tools like `viem`

**No Official UI:**
- No official web interface documented
- Only documented interface is the SDK
- Likely used by various community projects

### 5.2 Integration Points for UI

Users can deploy via:

1. **Direct SDK** (TypeScript/Node)
   ```typescript
   const liquid = new LiquidSDK({ walletClient });
   const result = await liquid.deployToken({ name, symbol });
   ```

2. **Web Frontend + Backend**
   - Frontend: Form for token params + image upload
   - Backend: Runs deployment via SDK, signs tx
   - Already what Liquid Social Launcher does

3. **Agent/CLI**
   - AI agents can load `.md` skill files
   - Full deployment autonomy

### 5.3 Fee Capture in Our UI

Our platform (Liquid Social Launcher) can capture fees by:

1. **Custom reward recipient** at deployment
   - Include our address in `rewardRecipients`
   - Set our `rewardBps` to 1-2% of fees
   - Transparent to user

2. **Deployment fee**
   - Charge ETH before deployment
   - Send tx from our backend
   - Deduct fee first

3. **Presale hosting**
   - Use `LiquidPresaleEthToCreator`
   - Host presale on our platform
   - We handle ETH distribution

---

## 6. Documentation on Correct Deployment Parameters

### 6.1 Hook Configuration

**Static Fee Hook (Default)**
```typescript
import { encodeStaticFeePoolData } from "liquid-sdk";

const poolData = encodeStaticFeePoolData(100, 100); // (liquidBps, pairedBps)
// 100 bps = 1% fee
// First param: fee on liquid token side
// Second param: fee on WETH side
```

**Dynamic Fee Hook (Alternative)**
```typescript
import { encodeDynamicFeePoolData, ADDRESSES } from "liquid-sdk";

const poolData = encodeDynamicFeePoolData({
  baseFeeBps: 30,              // 0.3% base
  maxFeeBps: 500,              // 5% max
  referenceTickFilterPeriod: 30,
  resetPeriod: 120,
  resetTickFilter: 200,
  feeControlNumerator: 500000000n,
  decayFilterBps: 7500,
});

const result = await liquid.deployToken({
  name: "Dynamic Token",
  symbol: "DYN",
  hook: ADDRESSES.HOOK_DYNAMIC_FEE_V2,
  poolData,
});
```

### 6.2 Locker Configuration

**Default: LP Locker Fee Conversion**

```typescript
// Default locker automatically:
// 1. Locks all LP positions
// 2. Converts all fees to ETH (from paired token)
// 3. Distributes to reward recipients

// No configuration needed — handled by SDK
```

**Locker Parameters (LiquidLpLockerFeeConversion):**
- Reward recipients: `rewardRecipients[]`
- Reward splits: `rewardBps[]`
- All fees converted to WETH before distribution
- No other locker options available

### 6.3 Pool Configuration (Complete)

| Parameter | Valid Range | Default | Notes |
|-----------|-------------|---------|-------|
| `tickIfToken0IsLiquid` | -230400 to -10000 | -230400 | Lower = lower market cap |
| `tickSpacing` | 1, 10, 60, 200, 3000 | 200 | Higher = fewer possible ticks |
| `poolData` (static) | Hex encoded | 0x64_64 (1% both) | Encoded fee configuration |
| `poolData` (dynamic) | Hex encoded | varies | Volatility-responsive fees |
| `hook` | Enabled addresses | STATIC_V2 | Must be whitelisted |

### 6.4 MEV Module Configuration

**Sniper Auction V2 (Default)**

```typescript
import { encodeSniperAuctionData } from "liquid-sdk";

// Default parameters (already encoded):
// - Initial fee: 80% (very high, discourages early trading)
// - Final fee: 40% (after 20 seconds)
// - Rounds: 5
// - Interval: 2 blocks
// - Duration: ~20 seconds

// To customize (if needed):
const mevData = encodeSniperAuctionData({
  initialFeeBps: 8000,  // 80%
  finalFeeBps: 4000,    // 40%
  rounds: 5,
  interval: 2,
});
```

**What it does:**
- Early traders pay 80% fee → incentivizes waiting
- Fee decays to 40% over 20 seconds
- Protects launch from MEV extraction
- Fees go to LP providers (reward recipients)

### 6.5 Validation Rules (Must Pass)

```typescript
// Position validation
- 1-7 positions allowed
- tickLower[] must be in ascending order
- All ticks must align to tickSpacing
- All tickLower ≥ tickIfToken0IsLiquid
- At least one position with tickLower == tickIfToken0IsLiquid
- positionBps[] must sum to 10000 (100%)

// Reward validation
- rewardRecipients[], rewardAdmins[], rewardBps[] same length
- rewardBps[] must sum to 10000 (100%)
- At least 1 recipient

// Extension validation
- extensions.length ≤ 10
- Total extensionBps ≤ 9000 (90% max)
- All extensions must be enabledExtensions
- msg.value must equal sum of extension msgValue
```

### 6.6 Correct Deployment Checklist

```
✓ Token Identity
  - name: Required, descriptive
  - symbol: Required, 3-6 chars recommended
  - image: IPFS URL recommended (ipfs://Qm...)
  - metadata: Include description + social links

✓ Pool Configuration
  - hook: Default (HOOK_STATIC_FEE_V2) recommended
  - pairedToken: Always WETH on Base
  - tickIfToken0IsLiquid: Default -230400 recommended
  - tickSpacing: Default 200 recommended
  - poolData: Default 1% fee recommended

✓ Liquidity Positions
  - Use createDefaultPositions() or createPositionsUSD()
  - Don't manually calculate ticks
  - Verify positionBps sum to 10000
  - Verify tickLower ≤ tickUpper

✓ Reward Configuration
  - rewardRecipients: Include creator + platform
  - rewardBps: Sum to 10000
  - rewardAdmins: Can include multiple addresses

✓ MEV & Extensions
  - mevModule: Default SNIPER_AUCTION_V2 recommended
  - extensions: Only use whitelisted extensions
  - devBuy: Optional, requires ETH msg.value

✓ Funding
  - ETH balance: gas + devBuy ethAmount + extension msgValue
  - Token supply: Automatically 100 billion
```

---

## 7. Protocol Addresses (Base Mainnet)

### 7.1 Core Contracts

| Contract | Address |
|----------|---------|
| **Factory** | `0x04F1a284168743759BE6554f607a10CEBdB77760` |
| **Fee Locker** | `0xF7d3BE3FC0de76fA5550C29A8F6fa53667B876FF` |
| **LP Locker (Fee Conversion)** | `0x77247fCD1d5e34A3703AcA898A591Dc7422435f3` |
| **Extension Allowlist** | `0xb614167d79aDBaA9BA35d05fE1d5542d7316Ccaa` |

### 7.2 Hooks

| Hook | Address | Purpose |
|------|---------|---------|
| Static Fee V2 | `0x9811f10Cd549c754Fa9E5785989c422A762c28cc` | 1% default |
| Dynamic Fee V2 | `0x80E2F7dC8C2C880BbC4BDF80A5Fb0eB8B1DB68CC` | 1%-5% variable |

### 7.3 MEV Modules

| Module | Address | Purpose |
|--------|---------|---------|
| Sniper Auction V2 | `0x187e8627c02c58F31831953C1268e157d3BfCefd` | MEV protection |
| MEV Descending Fees | `0x8D6B080e48756A99F3893491D556B5d6907b6910` | Fee decay logic |
| Sniper Util V2 | `0x2B6cd5Be183c388Dd0074d53c52317df1414cd9f` | Auction helpers |

### 7.4 Extensions (Whitelisted)

| Extension | Address |
|-----------|---------|
| Airdrop V2 | `0x1423974d48f525462f1c087cBFdCC20BDBc33CdD` |
| Vault | `0xdFCCC93257c20519A9005A2281CFBdF84836d50E` |
| Univ4 Dev Buy | `0x5934097864dC487D21A7B4e4EEe201A39ceF728D` |
| Univ3 Dev Buy | `0x376028cfb6b9A120E24Aa14c3FAc4205179c0025` |
| Presale ETH to Creator | `0x3bca63EcB49d5f917092d10fA879Fdb422740163` |
| Presale Allowlist | `0xCBb4ccC4B94E23233c14759f4F9629F7dD01f10B` |

### 7.5 External Dependencies

| Contract | Address | Purpose |
|----------|---------|---------|
| Uniswap V4 Pool Manager | `0x498581fF718922c3f8e6A244956aF099B2652b2b` | Core V4 infrastructure |
| WETH | `0x4200000000000000000000000000000000000006` | Base WETH token |
| Universal Router | `0x6fF5693b99212Da76ad316178A184AB56D299b43` | Uniswap routing |
| Permit2 | `0x000000000022D473030F116dDEE9F6B43aC78BA3` | Signature-based approvals |

### 7.6 Admin Safe

**Gnosis Safe:** `0x872c561f699B42977c093F0eD8b4C9a431280c6c`

Owned by Liquid Protocol Ops team. Controls:
- Extension allowlisting
- Hook enablement
- MEV module enablement
- Factory upgrades

---

## 8. Fee Capture Strategy Recommendations

### 8.1 Recommended Approach: Custom Reward Recipient

**Implementation:**

```typescript
// In our deployment backend
const deployer = new LiquidSDK({ walletClient });

const PLATFORM_ADDRESS = "0x..."; // Our platform treasury
const PLATFORM_FEE_BPS = 200;     // 2% of LP fees

const result = await deployer.deployToken({
  name: tokenName,
  symbol: tokenSymbol,
  image: tokenImage,
  // ... other params ...
  
  // Add our platform as fee recipient
  rewardRecipients: [
    userAddress,         // Token creator
    PLATFORM_ADDRESS,    // Our platform
  ],
  rewardAdmins: [
    userAddress,
    PLATFORM_ADDRESS,    // We can update our own address
  ],
  rewardBps: [
    10000 - PLATFORM_FEE_BPS,  // e.g., 9800 (98%)
    PLATFORM_FEE_BPS,          // e.g., 200 (2%)
  ],
});
```

**Fee Flow:**
```
User swaps 1 WETH for tokens
│
├─ 1% LP fee = 0.01 WETH
│
├─ Fee distributed per rewardBps:
│   ├─ 0.0098 WETH → user (98%)
│   └─ 0.0002 WETH → platform (2%)
│
└─ Platform claims fees periodically via sdk.claimFees()
```

**Pros:**
- ✓ Simple, no new contracts
- ✓ Automatic via existing mechanism
- ✓ Recurring revenue from all tokens
- ✓ Transparent to users
- ✓ User can verify on-chain

**Cons:**
- ✗ Depends on token trading volume
- ✗ Could reduce user appeal if seen as platform rent
- ✗ Users might fork Liquid Protocol to avoid fees

### 8.2 Alternative: Deployment Fee

**Implementation:**

```typescript
// In our frontend
const deploymentFee = parseEther("0.01"); // 0.01 ETH fixed fee

// 1. User sends ETH (tx gas + deploymentFee)
// 2. Our backend sends tx from contract
// 3. Fee goes to our treasury
// 4. Excess returned if gas < expected

async function deployToken(params, deploymentFeeWei) {
  const { walletClient, publicClient } = getClients();
  
  // Collect fee first
  await walletClient.sendTransaction({
    account: userAddress,
    to: PLATFORM_TREASURY,
    value: deploymentFeeWei,
  });
  
  // Deploy token
  const sdk = new LiquidSDK({ walletClient, publicClient });
  return sdk.deployToken(params);
}
```

**Pros:**
- ✓ One-time, transparent cost
- ✓ Clearer business model
- ✓ Doesn't require modifying reward splits

**Cons:**
- ✗ Requires user to pay upfront
- ✗ Reduces affordability perception
- ✗ Users might avoid if too high

### 8.3 Hybrid Approach (Recommended)

```
Small upfront fee (0.01-0.05 ETH) +
Small ongoing fee share (0.5-1% of LP fees)

= Sustainable revenue + low user friction
```

---

## 9. Comparison: Our Current Approach vs. Best Practice

### 9.1 What We Should Be Doing

Based on Liquid Protocol design:

| Aspect | Best Practice | Our Current Status |
|--------|-------|---------|
| **Fee capture** | Include self as reward recipient | Need to verify |
| **Extensions** | Use existing whitelisted | Need to check our ext. usage |
| **Pool config** | Use defaults (1% fee, 5 positions) | Need to verify |
| **Starting tick** | -230400 (10 ETH market cap) | Need to verify |
| **MEV module** | Sniper Auction V2 | Need to verify |
| **Locker** | LP Fee Conversion | Need to verify |
| **Validation** | Enforce tick alignment | Need to verify |
| **Metadata** | Include platform context | Need to verify |

### 9.2 Key Deployment Parameters to Verify

Locate in your codebase:

```typescript
// Should find these in your deployment logic
const deploymentConfig = {
  // Hook setup
  hook: ADDRESSES.HOOK_STATIC_FEE_V2,
  
  // Locker setup
  locker: ADDRESSES.LP_LOCKER_FEE_CONVERSION,
  
  // Reward split
  rewardRecipients: [creatorAddress, platformAddress?],
  rewardBps: [9800, 200], // 98% creator, 2% platform
  
  // Position setup
  tickIfToken0IsLiquid: -230400,
  tickLower: [...default positions...],
  tickUpper: [...default positions...],
  positionBps: [1000, 5000, 1500, 2000, 500],
  
  // MEV setup
  mevModule: ADDRESSES.SNIPER_AUCTION_V2,
  
  // Extensions (if any)
  extensions: [],
};
```

---

## 10. Key Findings & Recommendations

### 10.1 Extension System: Closed Ecosystem

**Finding:** Liquid Protocol is intentionally **closed to new extensions**.

**Evidence:**
- EXTENSION-ALLOWLIST.md: *"No new extensions planned at this time"*
- Requires full audit ($15K-50K) + Uniswap approval + multisig consensus
- Only 6 extensions approved; no new applications discussed

**Implication for us:**
- ❌ Cannot create custom extension for fee capture
- ✓ Can use existing extensions (presale, dev buy, etc.)
- ✓ Can leverage reward recipient mechanism instead

### 10.2 Fee Capture: Reward Recipient Strategy

**Recommendation:** Add platform as a **reward recipient** for LP fees.

**Implementation:**
```typescript
rewardRecipients: [creatorAddress, PLATFORM_ADDRESS]
rewardBps: [9800, 200]  // 2% platform fee
```

**Revenue Model:**
- Every token deployed earns us 2% of LP fees
- Scales with token trading volume
- No new contracts needed
- Works within existing protocol

**Estimated Impact:**
- If 100 tokens deployed, trading $100M/year
- Average LP fee: 1%
- Our share: 2% of 1% = 0.02% = $20K/year

### 10.3 Deployment Best Practices

**Ensure our platform enforces:**

1. ✓ Tick alignment to tickSpacing (200)
2. ✓ Valid tick ranges (no negative positions)
3. ✓ positionBps sum to 10000
4. ✓ rewardBps sum to 10000
5. ✓ Platform included in rewardRecipients
6. ✓ Sufficient ETH balance for gas + extensions
7. ✓ Valid image URL (IPFS preferred)
8. ✓ Metadata JSON well-formed

### 10.4 Documentation Gaps

**Missing from Liquid Protocol docs:**
- Exact gas costs for typical deployment
- Fee distribution timing (when are fees claimable?)
- MEV auction bidding mechanics (incomplete in SDK)
- Pool creation event structure
- Extension approval timeline

### 10.5 SDK Integration Checklist

Our backend should verify:

```typescript
// ✓ SDK installed and latest version
npm list liquid-sdk  // should be latest

// ✓ Contract addresses hardcoded correctly
import { ADDRESSES } from "liquid-sdk";
assert(ADDRESSES.FACTORY === "0x04F1a284...");

// ✓ Deployment parameters validated
validateDeploymentConfig(config);

// ✓ Fee recipient included
assert(config.rewardRecipients.includes(PLATFORM_ADDRESS));

// ✓ Error handling for common failures
try {
  await sdk.deployToken(config);
} catch (e) {
  if (e.message.includes("TickRangeLowerThanStartingTick")) {
    // Handle tick validation error
  }
}
```

---

## 11. Summary Table

| Component | Status | Details |
|-----------|--------|---------|
| **Protocol** | Live | Base mainnet, audited |
| **SDK** | Production | TypeScript, npm: `liquid-sdk` |
| **Factory** | Active | 0x04F1a284... |
| **Hooks** | 2 options | Static (1%) + Dynamic (1%-5%) |
| **Lockers** | 1 main | LP Fee Conversion (converts to ETH) |
| **MEV** | Enabled | Sniper Auction V2 (80%→40% decay) |
| **Extensions** | 6 approved | No new extensions accepted |
| **Fee capture (us)** | Recommended | Custom reward recipient (2% of LP fees) |
| **Alternative revenue** | Possible | Deployment fee (0.01-0.1 ETH) |
| **Extension approval** | Not feasible | Requires $15K+ audit + multisig consensus |

---

## Appendix: Glossary

- **LP Fee:** Commission on swaps collected by liquidity providers (1% default)
- **Tick:** Unit of price in Uniswap V4 (log-based)
- **Position:** A liquidity range defined by tickLower and tickUpper
- **Hook:** Contract that intercepts Uniswap V4 callbacks (fee logic)
- **Locker:** Contract that holds LP positions and manages rewards
- **MEV:** Maximal Extractable Value; used here for MEV protection
- **Sniper Auction:** Mechanism to prevent early trader MEV extraction
- **Reward Recipient:** Address that receives a share of LP fees
- **Extension:** Optional module (airdrop, vault, presale, etc.)
- **Base:** Coinbase's layer-2 blockchain (chain ID 8453)
- **WETH:** Wrapped Ether (ERC-20 representation of ETH)

---

**Document prepared:** April 9, 2026  
**Last reviewed:** Liquid Protocol v4, SDK latest version
