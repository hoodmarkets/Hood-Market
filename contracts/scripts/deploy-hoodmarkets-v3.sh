#!/usr/bin/env bash
# Deploy HoodMarkets V3 only (factory + vault + LP locker) on Robinhood Chain (4663).
# Usage:
#   cp .env.robinhood.example .env.robinhood
#   # Set DEPLOYER_PRIVATE_KEY (0xFA45… wallet) — never commit
#   ./scripts/deploy-hoodmarkets-v3.sh
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
: "${WETH:?Set WETH}"
: "${UNISWAP_V3_FACTORY:?Set UNISWAP_V3_FACTORY}"
: "${UNISWAP_V3_POSITION_MANAGER:?Set UNISWAP_V3_POSITION_MANAGER}"
: "${UNISWAP_V3_SWAP_ROUTER:?Set UNISWAP_V3_SWAP_ROUTER}"
: "${HOODMARKETS_PLATFORM_FEE_RECIPIENT:?Set HOODMARKETS_PLATFORM_FEE_RECIPIENT}"

if [[ "$DEPLOYER_PRIVATE_KEY" != 0x* && "$DEPLOYER_PRIVATE_KEY" != 0X* ]]; then
  export DEPLOYER_PRIVATE_KEY="0x${DEPLOYER_PRIVATE_KEY}"
fi

RPC="$ROBINHOOD_RPC_URL"
CHAIN_ID=4663

echo "Deployer: $(cast wallet address --private-key "$DEPLOYER_PRIVATE_KEY")"
echo "Owner: ${HOODMARKETS_OWNER:-<same as deployer>}"
echo "Platform fee (5%): $HOODMARKETS_PLATFORM_FEE_RECIPIENT"
echo ""

forge script script/robinhood/10_DeployHoodMarketsV3.s.sol:DeployHoodMarketsV3 \
  --rpc-url "$RPC" \
  --chain-id "$CHAIN_ID" \
  --broadcast \
  --slow \
  -vvv

BROADCAST_DIR="$ROOT/broadcast/10_DeployHoodMarketsV3.s.sol/$CHAIN_ID"
LATEST=$(ls -t "$BROADCAST_DIR"/run-*.json 2>/dev/null | head -1 || true)
if [[ -z "$LATEST" ]]; then
  echo "No broadcast file found — check forge output above."
  exit 1
fi

V3_FACTORY=$(jq -r '.transactions[] | select(.contractName=="HoodMarketsV3") | .contractAddress' "$LATEST" | head -1)
V3_VAULT=$(jq -r '.transactions[] | select(.contractName=="HoodMarketsV3Vault") | .contractAddress' "$LATEST" | head -1)
V3_LOCKER=$(jq -r '.transactions[] | select(.contractName=="HoodMarketsV3LpLocker") | .contractAddress' "$LATEST" | head -1)
V3_FRACTION=$(jq -r '.transactions[] | select(.contractName=="HoodMarketsV3FractionDeployer") | .contractAddress' "$LATEST" | head -1)

OUT="$ROOT/deployed-hoodmarkets-v3-mainnet.json"
jq -n \
  --arg chainId "$CHAIN_ID" \
  --arg version "0.11.0" \
  --arg factory "$V3_FACTORY" \
  --arg vault "$V3_VAULT" \
  --arg lpLocker "$V3_LOCKER" \
  --arg fractionDeployer "$V3_FRACTION" \
  --arg platformFeeRecipient "$HOODMARKETS_PLATFORM_FEE_RECIPIENT" \
  --arg owner "${HOODMARKETS_OWNER:-}" \
  --arg previousFactory "0xf65536Eb3354Ad7e77E1b0d0F7bEBFa1C88885C9" \
  '{
    chainId: ($chainId | tonumber),
    version: $version,
    hoodmarketsV3: {
      factory: $factory,
      vault: $vault,
      lpLocker: $lpLocker,
      fractionDeployer: $fractionDeployer,
      platformFeeRecipient: $platformFeeRecipient,
      owner: (if $owner == "" then null else $owner end),
      previousFactory: $previousFactory
    }
  }' > "$OUT"

echo ""
echo "Done. V3 addresses written to $OUT"
cat "$OUT"
echo ""
echo "Next: update Railway API env (HOODMARKETS_V3_*), redeploy API, deprecate old V3 factory."
