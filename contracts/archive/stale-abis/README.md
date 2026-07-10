# Stale ABIs

These ABIs correspond to contracts that have been renamed or removed from the codebase. They are preserved here for reference.

| Archived ABI | Reason |
|-------------|--------|
| `LiquidAirdrop.sol/` | Renamed to `LiquidAirdropV2` |
| `LiquidHook.sol/` | Replaced by `HoodMarketsHookV2` base + V2 fee variants |
| `LiquidHookDynamicFee.sol/` | Renamed to `HoodMarketsHookDynamicFeeV2` |
| `LiquidHookStaticFee.sol/` | Renamed to `HoodMarketsHookStaticFeeV2` |
| `LiquidLpLockerMultiple.sol/` | Replaced by `HoodMarketsLpLockerFeeConversion` |
| `LiquidMevBlockDelay.sol/` | Removed — no longer deployed |
| `LiquidSniperAuctionV0.sol/` | Renamed to `HoodMarketsSniperAuctionV2` |
| `LiquidSniperUtilV0.sol/` | Renamed to `HoodMarketsSniperUtilV2` |
| `ILiquidSniperAuctionV0.sol/` | Interface ABI — the V0 interface name is still in use by V2 contracts |
