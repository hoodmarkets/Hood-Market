# Liquid Protocol — MEV Protection

> TODO: Document MEV protection mechanisms.

## Topics to Cover

- `HoodMarketsSniperAuctionV2` — auction-based sniper protection with descending fees
- `HoodMarketsMevDescendingFees` — parabolic fee decay (up to 80% initial, max 2 min duration)
- `HoodMarketsSniperUtilV2` — utility for interacting with sniper auctions
- How MEV modules are initialized via hooks after pool creation
- Comparison with V0 auction design (removed)
