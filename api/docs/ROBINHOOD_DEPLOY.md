# Robinhood mainnet deploy

Deploy Liquid Protocol v4 on **Robinhood Chain** (chain ID **4663**) and wire the launcher.

## 1. Fund deployer wallet

Send **ETH on Robinhood mainnet** to the wallet whose private key you will use. You need enough for:

- Core + hooks + extensions + MEV + locker deploys (several transactions)
- Hook CREATE2 salt mining (can take many simulations)
- One test token deploy from the launcher later

Bridge via [Robinhood Chain docs](https://docs.robinhood.com/chain/) if needed.

## 2. Contract deploy (do not paste keys in chat)

```bash
cd contracts-robinhood
cp .env.robinhood.example .env.robinhood
# Edit .env.robinhood — set DEPLOYER_PRIVATE_KEY only in this file (never commit)
chmod +x scripts/deploy-robinhood.sh
./scripts/deploy-robinhood.sh
```

On success you get `contracts-robinhood/deployed-robinhood-mainnet.json`.

**Hook mining** (phase 01) can take several minutes — let it run.

## 3. Launcher env (Railway / `.env`)

Copy addresses from `deployed-robinhood-mainnet.json`:

```env
ROBINHOOD_RPC_URL=https://rpc.mainnet.chain.robinhood.com
LIQUID_FACTORY=0x...
LIQUID_FEE_LOCKER=0x...
LIQUID_HOOK_DYNAMIC_FEE_V2=0x...
LIQUID_HOOK_STATIC_FEE_V2=0x...
LIQUID_LP_LOCKER_FEE_CONVERSION=0x...
LIQUID_SNIPER_AUCTION_V2=0x...
LIQUID_UNIV4_ETH_DEV_BUY=0x...
DEPLOYER_PRIVATE_KEY=0x...   # same wallet, funded on Robinhood
```

## 4. Privy / frontend

Add Robinhood Chain (**4663**) to your Privy app and web wallet config so users can sign on Robinhood.

## 5. Smoke test

1. Start launcher with env above
2. Deploy one token via web or bot
3. Confirm tx on [Blockscout](https://robinhoodchain.blockscout.com)
4. Claim fees / collect pool fees

## 6. Verify on Blockscout

```bash
chmod +x scripts/verify-robinhood.sh
./scripts/verify-robinhood.sh
```

View verified contracts at `https://robinhoodchain.blockscout.com/address/<address>`.


| Contract | Address |
|----------|---------|
| WETH | `0x0Bd7D308f8E1639FAb988df18A8011f41EAcAD73` |
| PoolManager | `0x8366a39CC670B4001A1121B8F6A443A643e40951` |
| PositionManager | `0x58daec3116aae6D93017bAAea7749052E8a04fA7` |
| Universal Router | `0x53BF6B0684Ec7eF91e1387Da3D1a1769bC5A6F77` |
| Permit2 | `0x000000000022D473030F116dDEE9F6B43aC78BA3` |
