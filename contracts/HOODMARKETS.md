# HoodMarkets protocol (Robinhood Chain)

Smart contracts for **[hood.markets](https://hood.markets)** — token factory on Robinhood Chain (4663), forked from Liquid Protocol v4 / Clanker v4.

Factory contract: **`HoodMarkets`** (`PROTOCOL = "hoodmarkets"`).

Supporting modules use the `HoodMarkets*` prefix (fee locker, hooks, LP locker, dev buy, MEV).

## Robinhood mainnet deploy

**Simple launches (V3):** [`deployed-hoodmarkets-v3-mainnet.json`](deployed-hoodmarkets-v3-mainnet.json) · [`../docs/HOODMARKETS_V3.md`](../docs/HOODMARKETS_V3.md)

Current factory **v0.11.0:** `0x9BDdC8ddf28f5629C989A36Eb5bb6C73cBA60Df5`

**Platform fees (only two):** swap trading fees 5%/95% to Holder NFT holders · share marketplace sales 5% on `buyShares`. No fee on sends or batch `airdropShares` (v0.11 bytecode).

**Pro launches (V4):** [`deployed-robinhood-mainnet.json`](deployed-robinhood-mainnet.json) and [`../README.md`](../README.md).

```bash
cp .env.robinhood.example .env.robinhood   # local only — never commit
./scripts/deploy-robinhood.sh
./scripts/verify-robinhood.sh
```

## Build

```bash
git submodule update --init --recursive
forge build
```

## Base mainnet

This tree also contains Liquid Protocol Base mainnet artifacts and vault code from upstream. **hood.markets production uses the Robinhood deploy only.**

See the original [`README.md`](README.md) body below for Base addresses and architecture.

---
