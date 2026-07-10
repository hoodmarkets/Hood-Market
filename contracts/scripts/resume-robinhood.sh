#!/usr/bin/env bash
# Resume Robinhood deploy after partial success (runs LP locker + allowlists only).
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

ENV_FILE="${ENV_FILE:-$ROOT/.env.robinhood}"
set -a
# shellcheck disable=SC1090
source "$ENV_FILE"
set +a

if [[ "$DEPLOYER_PRIVATE_KEY" != 0x* && "$DEPLOYER_PRIVATE_KEY" != 0X* ]]; then
  export DEPLOYER_PRIVATE_KEY="0x${DEPLOYER_PRIVATE_KEY}"
fi

RPC="$ROBINHOOD_RPC_URL"
CHAIN_ID=4663

extract_phase() {
  local phase="$1"
  local broadcast="$ROOT/broadcast/${phase}.s.sol/$CHAIN_ID"
  local latest
  latest=$(ls -t "$broadcast"/run-*.json 2>/dev/null | head -1 || true)
  [[ -n "$latest" ]] || return 0
  case "$phase" in
    00_DeployCore)
      HOODMARKETS_FACTORY=$(jq -r '.transactions[] | select(.contractName=="HoodMarkets") | .contractAddress' "$latest" | head -1)
      LIQUID_FEE_LOCKER=$(jq -r '.transactions[] | select(.contractName=="HoodMarketsFeeLocker") | .contractAddress' "$latest" | head -1)
      POOL_EXTENSION_ALLOWLIST=$(jq -r '.transactions[] | select(.contractName=="HoodMarketsPoolExtensionAllowlist") | .contractAddress' "$latest" | head -1)
      ;;
    01_DeployHooks)
      LIQUID_HOOK_DYNAMIC_FEE_V2=$(jq -r '.transactions[] | select(.contractName=="HoodMarketsHookDynamicFeeV2") | .contractAddress' "$latest" | head -1)
      LIQUID_HOOK_STATIC_FEE_V2=$(jq -r '.transactions[] | select(.contractName=="HoodMarketsHookStaticFeeV2") | .contractAddress' "$latest" | head -1)
      ;;
    02_DeployExtensions)
      LIQUID_UNIV4_ETH_DEV_BUY=$(jq -r '.transactions[] | select(.contractName=="HoodMarketsUniv4EthDevBuy") | .contractAddress' "$latest" | head -1)
      ;;
    03a_DeployMev)
      LIQUID_SNIPER_AUCTION_V2=$(jq -r '.transactions[] | select(.contractName=="HoodMarketsSniperAuctionV2") | .contractAddress' "$latest" | head -1)
      LIQUID_MEV_DESCENDING_FEES=$(jq -r '.transactions[] | select(.contractName=="HoodMarketsMevDescendingFees") | .contractAddress' "$latest" | head -1)
      ;;
  esac
}

for p in 00_DeployCore 01_DeployHooks 02_DeployExtensions 03a_DeployMev; do
  extract_phase "$p"
done

export HOODMARKETS_FACTORY LIQUID_FEE_LOCKER POOL_EXTENSION_ALLOWLIST
export LIQUID_HOOK_DYNAMIC_FEE_V2 LIQUID_HOOK_STATIC_FEE_V2
export LIQUID_UNIV4_ETH_DEV_BUY LIQUID_SNIPER_AUCTION_V2 LIQUID_MEV_DESCENDING_FEES

: "${HOODMARKETS_FACTORY:?Run phase 00 first}"
echo "Resuming from factory=$HOODMARKETS_FACTORY"

echo "========== 03b_DeployLpLocker.s.sol (lplocker profile) =========="
FOUNDRY_PROFILE=lplocker forge script script/robinhood/03b_DeployLpLocker.s.sol \
  --rpc-url "$RPC" --chain-id "$CHAIN_ID" --broadcast --slow -vvv

latest=$(ls -t "$ROOT/broadcast/03b_DeployLpLocker.s.sol/$CHAIN_ID"/run-*.json | head -1)
LIQUID_LP_LOCKER_FEE_CONVERSION=$(jq -r '.transactions[] | select(.contractName=="HoodMarketsLpLockerFeeConversion") | .contractAddress' "$latest" | head -1)
export LIQUID_LP_LOCKER_FEE_CONVERSION

echo "========== 04_ConfigureAllowlists.s.sol =========="
forge script script/robinhood/04_ConfigureAllowlists.s.sol \
  --rpc-url "$RPC" --chain-id "$CHAIN_ID" --broadcast --slow -vvv

OUT="$ROOT/deployed-robinhood-mainnet.json"
jq -n \
  --arg chainId "$CHAIN_ID" \
  --arg factory "$HOODMARKETS_FACTORY" \
  --arg feeLocker "$LIQUID_FEE_LOCKER" \
  --arg hookDynamic "$LIQUID_HOOK_DYNAMIC_FEE_V2" \
  --arg hookStatic "$LIQUID_HOOK_STATIC_FEE_V2" \
  --arg lpLocker "$LIQUID_LP_LOCKER_FEE_CONVERSION" \
  --arg devBuy "$LIQUID_UNIV4_ETH_DEV_BUY" \
  --arg mev "$LIQUID_SNIPER_AUCTION_V2" \
  '{
    chainId: ($chainId | tonumber),
    factory: $factory,
    feeLocker: $feeLocker,
    hookDynamic: $hookDynamic,
    hookStatic: $hookStatic,
    lpLocker: $lpLocker,
    univ4EthDevBuy: $devBuy,
    mevModule: $mev
  }' > "$OUT"

echo "Done. Addresses written to $OUT"
cat "$OUT"
