#!/usr/bin/env bash
# Verify all Robinhood mainnet hoodmarkets protocol contracts on Blockscout.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

CHAIN_ID=4663
RPC="${ROBINHOOD_RPC_URL:-https://rpc.mainnet.chain.robinhood.com}"
VERIFIER_URL="https://robinhoodchain.blockscout.com/api"
export ETHERSCAN_API_KEY="${ETHERSCAN_API_KEY:-empty}"

lookup_spec() {
  case "$1" in
    HoodMarkets) echo "src/HoodMarkets.sol:HoodMarkets||constructor(address)" ;;
    Liquid) echo "src/Liquid.sol:Liquid||constructor(address)" ;;
    HoodMarketsDeployer) echo "src/utils/HoodMarketsDeployer.sol:HoodMarketsDeployer||" ;;
    HoodMarketsFeeLocker) echo "src/HoodMarketsFeeLocker.sol:HoodMarketsFeeLocker||constructor(address)" ;;
    HoodMarketsPoolExtensionAllowlist) echo "src/hooks/HoodMarketsPoolExtensionAllowlist.sol:HoodMarketsPoolExtensionAllowlist||constructor(address)" ;;
    HoodMarketsHookDynamicFeeV2) echo "src/hooks/HoodMarketsHookDynamicFeeV2.sol:HoodMarketsHookDynamicFeeV2||constructor(address,address,address,address)" ;;
    HoodMarketsHookStaticFeeV2) echo "src/hooks/HoodMarketsHookStaticFeeV2.sol:HoodMarketsHookStaticFeeV2||constructor(address,address,address,address)" ;;
    HoodMarketsUniv4EthDevBuy) echo "src/extensions/HoodMarketsUniv4EthDevBuy.sol:HoodMarketsUniv4EthDevBuy||constructor(address,address,address,address)" ;;
    HoodMarketsSniperAuctionV2) echo "src/mev-modules/HoodMarketsSniperAuctionV2.sol:HoodMarketsSniperAuctionV2||constructor(address,address,address,address)" ;;
    HoodMarketsMevDescendingFees) echo "src/mev-modules/HoodMarketsMevDescendingFees.sol:HoodMarketsMevDescendingFees||" ;;
    HoodMarketsSniperUtilV2) echo "src/mev-modules/sniper-utils/HoodMarketsSniperUtilV2.sol:HoodMarketsSniperUtilV2||constructor(address,address,address,address)" ;;
    HoodMarketsLpLockerFeeConversion) echo "src/lp-lockers/HoodMarketsLpLockerFeeConversion.sol:HoodMarketsLpLockerFeeConversion|lplocker|constructor(address,address,address,address,address,address,address)" ;;
    HoodMarketsV3) echo "src/v31/HoodMarketsV3.sol:HoodMarketsV3||constructor(address)" ;;
    HoodMarketsV3FractionDeployer) echo "src/v31/HoodMarketsV3FractionDeployer.sol:HoodMarketsV3FractionDeployer||constructor(address)" ;;
    HoodMarketsV3Vault) echo "src/v31/HoodMarketsV3Vault.sol:HoodMarketsV3Vault||constructor(address,address,uint256)" ;;
    HoodMarketsV3LpLocker) echo "src/v31/HoodMarketsV3LpLocker.sol:HoodMarketsV3LpLocker||constructor(address,address,address,address)" ;;
    HoodMarketsSwapHelper) echo "src/extensions/HoodMarketsSwapHelper.sol:HoodMarketsSwapHelper||constructor(address,address,address,address)" ;;
    # Legacy names from pre-rename deploy broadcasts (same bytecode paths)
    LiquidFeeLocker) echo "src/HoodMarketsFeeLocker.sol:HoodMarketsFeeLocker||constructor(address)" ;;
    LiquidPoolExtensionAllowlist) echo "src/hooks/HoodMarketsPoolExtensionAllowlist.sol:HoodMarketsPoolExtensionAllowlist||constructor(address)" ;;
    LiquidHookDynamicFeeV2) echo "src/hooks/HoodMarketsHookDynamicFeeV2.sol:HoodMarketsHookDynamicFeeV2||constructor(address,address,address,address)" ;;
    LiquidHookStaticFeeV2) echo "src/hooks/HoodMarketsHookStaticFeeV2.sol:HoodMarketsHookStaticFeeV2||constructor(address,address,address,address)" ;;
    LiquidUniv4EthDevBuy) echo "src/extensions/HoodMarketsUniv4EthDevBuy.sol:HoodMarketsUniv4EthDevBuy||constructor(address,address,address,address)" ;;
    LiquidSniperAuctionV2) echo "src/mev-modules/HoodMarketsSniperAuctionV2.sol:HoodMarketsSniperAuctionV2||constructor(address,address,address,address)" ;;
    LiquidMevDescendingFees) echo "src/mev-modules/HoodMarketsMevDescendingFees.sol:HoodMarketsMevDescendingFees||" ;;
    LiquidSniperUtilV2) echo "src/mev-modules/sniper-utils/HoodMarketsSniperUtilV2.sol:HoodMarketsSniperUtilV2||constructor(address,address,address,address)" ;;
    LiquidLpLockerFeeConversion) echo "src/lp-lockers/HoodMarketsLpLockerFeeConversion.sol:HoodMarketsLpLockerFeeConversion|lplocker|constructor(address,address,address,address,address,address,address)" ;;
    *) echo "" ;;
  esac
}

collect_deployments() {
  local tmp
  tmp=$(mktemp)
  for f in "$ROOT"/broadcast/*/4663/run-latest.json; do
    [[ -f "$f" ]] || continue
    jq -r '.transactions[] | select(.transactionType=="CREATE" or .transactionType=="CREATE2") | [.contractName, .contractAddress, (.arguments | @json)] | @tsv' "$f" >> "$tmp"
  done
  sort -u -t$'\t' -k1,1 "$tmp"
  rm -f "$tmp"
}

verify_one() {
  local name="$1" addr="$2" args_json="$3"
  local spec
  spec=$(lookup_spec "$name")
  if [[ -z "$spec" ]]; then
    echo "SKIP unknown contract: $name"
    return 0
  fi

  local fq profile ctor_sig
  fq=$(echo "$spec" | cut -d'|' -f1)
  profile=$(echo "$spec" | cut -d'|' -f2)
  ctor_sig=$(echo "$spec" | cut -d'|' -f3)

  echo ""
  echo "========== $name @ $addr =========="

  local -a forge_cmd=(forge verify-contract "$addr" "$fq"
    --chain-id "$CHAIN_ID"
    --rpc-url "$RPC"
    --verifier blockscout
    --verifier-url "$VERIFIER_URL"
    --watch
  )

  if [[ -n "$ctor_sig" && "$args_json" != "[]" && "$args_json" != "null" ]]; then
    local -a args=()
    while IFS= read -r arg; do
      args+=("$arg")
    done < <(jq -r '.[]' <<< "$args_json")
    local encoded
    encoded=$(cast abi-encode "$ctor_sig" "${args[@]}")
    forge_cmd+=(--constructor-args "$encoded")
  fi

  local rc=0
  if [[ "$profile" == "lplocker" ]]; then
    FOUNDRY_PROFILE=lplocker "${forge_cmd[@]}" || rc=$?
  else
    "${forge_cmd[@]}" || rc=$?
  fi
  return "$rc"
}

FAILED=0
while IFS=$'\t' read -r name addr args_json; do
  [[ -n "$name" ]] || continue
  if ! verify_one "$name" "$addr" "$args_json"; then
    echo "FAILED: $name"
    FAILED=$((FAILED + 1))
  fi
done < <(collect_deployments)

echo ""
if [[ "$FAILED" -gt 0 ]]; then
  echo "$FAILED contract(s) failed verification."
  exit 1
fi
echo "All contracts verified on https://robinhoodchain.blockscout.com"
