#!/usr/bin/env bash
# Deploy hoodmarkets factory + hoodmarkets protocol v4 modules on Robinhood Chain (4663).
# Usage: copy .env.robinhood.example → .env.robinhood, set DEPLOYER_PRIVATE_KEY, then:
#   ./scripts/deploy-robinhood.sh
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

ENV_FILE="${ENV_FILE:-$ROOT/.env.robinhood}"
if [[ ! -f "$ENV_FILE" ]]; then
  echo "Missing $ENV_FILE — copy .env.robinhood.example and set DEPLOYER_PRIVATE_KEY"
  exit 1
fi

set -a
# shellcheck disable=SC1090
source "$ENV_FILE"
set +a

: "${DEPLOYER_PRIVATE_KEY:?Set DEPLOYER_PRIVATE_KEY in $ENV_FILE}"
: "${ROBINHOOD_RPC_URL:?Set ROBINHOOD_RPC_URL}"

# Foundry vm.envUint requires 0x-prefixed hex
if [[ "$DEPLOYER_PRIVATE_KEY" != 0x* && "$DEPLOYER_PRIVATE_KEY" != 0X* ]]; then
  export DEPLOYER_PRIVATE_KEY="0x${DEPLOYER_PRIVATE_KEY}"
fi

RPC="$ROBINHOOD_RPC_URL"
CHAIN_ID=4663
BROADCAST="--broadcast --slow"

run_phase() {
  local script="$1"
  local profile="${2:-}"
  echo ""
  echo "========== $script =========="
  if [[ -n "$profile" ]]; then
    FOUNDRY_PROFILE="$profile" forge script "script/robinhood/$script" \
      --rpc-url "$RPC" \
      --chain-id "$CHAIN_ID" \
      $BROADCAST \
      -vvv
  else
    forge script "script/robinhood/$script" \
      --rpc-url "$RPC" \
      --chain-id "$CHAIN_ID" \
      $BROADCAST \
      -vvv
  fi
}

# Phase 0 — core (writes addresses to broadcast; export manually or from logs)
run_phase "00_DeployCore.s.sol"

# Parse addresses from latest broadcast if env not preset
BROADCAST_DIR="$ROOT/broadcast/00_DeployCore.s.sol/$CHAIN_ID"
LATEST=$(ls -t "$BROADCAST_DIR"/run-*.json 2>/dev/null | head -1 || true)
if [[ -n "$LATEST" && -z "${HOODMARKETS_FACTORY:-}" ]]; then
  echo "Extracting Phase 0 addresses from $LATEST"
  HOODMARKETS_FACTORY=$(jq -r '.transactions[] | select(.contractName=="HoodMarkets") | .contractAddress' "$LATEST" | head -1)
  HOODMARKETS_FEE_LOCKER=$(jq -r '.transactions[] | select(.contractName=="HoodMarketsFeeLocker" or .contractName=="LiquidFeeLocker") | .contractAddress' "$LATEST" | head -1)
  POOL_EXTENSION_ALLOWLIST=$(jq -r '.transactions[] | select(.contractName=="HoodMarketsPoolExtensionAllowlist" or .contractName=="LiquidPoolExtensionAllowlist") | .contractAddress' "$LATEST" | head -1)
  export HOODMARKETS_FACTORY HOODMARKETS_FEE_LOCKER POOL_EXTENSION_ALLOWLIST
  export LIQUID_FEE_LOCKER="$HOODMARKETS_FEE_LOCKER"
fi

: "${HOODMARKETS_FACTORY:?HOODMARKETS_FACTORY required after Phase 0}"
: "${HOODMARKETS_FEE_LOCKER:?HOODMARKETS_FEE_LOCKER required after Phase 0}"
: "${POOL_EXTENSION_ALLOWLIST:?POOL_EXTENSION_ALLOWLIST required after Phase 0}"
export LIQUID_FEE_LOCKER="${LIQUID_FEE_LOCKER:-$HOODMARKETS_FEE_LOCKER}"

run_phase "01_DeployHooks.s.sol"
BROADCAST_DIR="$ROOT/broadcast/01_DeployHooks.s.sol/$CHAIN_ID"
LATEST=$(ls -t "$BROADCAST_DIR"/run-*.json 2>/dev/null | head -1 || true)
if [[ -n "$LATEST" ]]; then
  HOODMARKETS_HOOK_DYNAMIC_FEE_V2=$(jq -r '.transactions[] | select(.contractName=="HoodMarketsHookDynamicFeeV2" or .contractName=="LiquidHookDynamicFeeV2") | .contractAddress' "$LATEST" | head -1)
  HOODMARKETS_HOOK_STATIC_FEE_V2=$(jq -r '.transactions[] | select(.contractName=="HoodMarketsHookStaticFeeV2" or .contractName=="LiquidHookStaticFeeV2") | .contractAddress' "$LATEST" | head -1)
  export HOODMARKETS_HOOK_DYNAMIC_FEE_V2 HOODMARKETS_HOOK_STATIC_FEE_V2
  export LIQUID_HOOK_DYNAMIC_FEE_V2="$HOODMARKETS_HOOK_DYNAMIC_FEE_V2"
  export LIQUID_HOOK_STATIC_FEE_V2="$HOODMARKETS_HOOK_STATIC_FEE_V2"
fi

run_phase "02_DeployExtensions.s.sol"
BROADCAST_DIR="$ROOT/broadcast/02_DeployExtensions.s.sol/$CHAIN_ID"
LATEST=$(ls -t "$BROADCAST_DIR"/run-*.json 2>/dev/null | head -1 || true)
if [[ -n "$LATEST" ]]; then
  HOODMARKETS_UNIV4_ETH_DEV_BUY=$(jq -r '.transactions[] | select(.contractName=="HoodMarketsUniv4EthDevBuy" or .contractName=="LiquidUniv4EthDevBuy") | .contractAddress' "$LATEST" | head -1)
  export HOODMARKETS_UNIV4_ETH_DEV_BUY
  export LIQUID_UNIV4_ETH_DEV_BUY="$HOODMARKETS_UNIV4_ETH_DEV_BUY"
fi

run_phase "03a_DeployMev.s.sol"
BROADCAST_DIR="$ROOT/broadcast/03a_DeployMev.s.sol/$CHAIN_ID"
LATEST=$(ls -t "$BROADCAST_DIR"/run-*.json 2>/dev/null | head -1 || true)
if [[ -n "$LATEST" ]]; then
  HOODMARKETS_SNIPER_AUCTION_V2=$(jq -r '.transactions[] | select(.contractName=="HoodMarketsSniperAuctionV2" or .contractName=="LiquidSniperAuctionV2") | .contractAddress' "$LATEST" | head -1)
  HOODMARKETS_MEV_DESCENDING_FEES=$(jq -r '.transactions[] | select(.contractName=="HoodMarketsMevDescendingFees" or .contractName=="LiquidMevDescendingFees") | .contractAddress' "$LATEST" | head -1)
  export HOODMARKETS_SNIPER_AUCTION_V2 HOODMARKETS_MEV_DESCENDING_FEES
  export LIQUID_SNIPER_AUCTION_V2="$HOODMARKETS_SNIPER_AUCTION_V2"
  export LIQUID_MEV_DESCENDING_FEES="$HOODMARKETS_MEV_DESCENDING_FEES"
fi

run_phase "03b_DeployLpLocker.s.sol" "lplocker"
BROADCAST_DIR="$ROOT/broadcast/03b_DeployLpLocker.s.sol/$CHAIN_ID"
LATEST=$(ls -t "$BROADCAST_DIR"/run-*.json 2>/dev/null | head -1 || true)
if [[ -n "$LATEST" ]]; then
  HOODMARKETS_LP_LOCKER_FEE_CONVERSION=$(jq -r '.transactions[] | select(.contractName=="HoodMarketsLpLockerFeeConversion" or .contractName=="LiquidLpLockerFeeConversion") | .contractAddress' "$LATEST" | head -1)
  export HOODMARKETS_LP_LOCKER_FEE_CONVERSION
  export LIQUID_LP_LOCKER_FEE_CONVERSION="$HOODMARKETS_LP_LOCKER_FEE_CONVERSION"
fi

run_phase "04_ConfigureAllowlists.s.sol"

OUT="$ROOT/deployed-robinhood-mainnet.json"
jq -n \
  --arg chainId "$CHAIN_ID" \
  --arg factory "$HOODMARKETS_FACTORY" \
  --arg feeLocker "$HOODMARKETS_FEE_LOCKER" \
  --arg hookDynamic "$HOODMARKETS_HOOK_DYNAMIC_FEE_V2" \
  --arg hookStatic "$HOODMARKETS_HOOK_STATIC_FEE_V2" \
  --arg lpLocker "$HOODMARKETS_LP_LOCKER_FEE_CONVERSION" \
  --arg devBuy "$HOODMARKETS_UNIV4_ETH_DEV_BUY" \
  --arg mev "$HOODMARKETS_SNIPER_AUCTION_V2" \
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

echo ""
echo "Done. Addresses written to $OUT"
cat "$OUT"
