// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {Script, console} from "forge-std/Script.sol";
import {HoodMarketsSniperAuctionV2} from "../../src/mev-modules/HoodMarketsSniperAuctionV2.sol";
import {HoodMarketsMevDescendingFees} from "../../src/mev-modules/HoodMarketsMevDescendingFees.sol";
import {HoodMarketsSniperUtilV2} from "../../src/mev-modules/sniper-utils/HoodMarketsSniperUtilV2.sol";

contract DeployMev is Script {
    function run() external {
        uint256 deployerKey = vm.envUint("DEPLOYER_PRIVATE_KEY");
        address deployer = vm.addr(deployerKey);
        address hoodMarketsFactory = vm.envAddress("HOODMARKETS_FACTORY");
        address feeLocker = vm.envAddress("LIQUID_FEE_LOCKER");
        address universalRouter = vm.envAddress("UNISWAP_UNIVERSAL_ROUTER");
        address permit2 = vm.envAddress("PERMIT2");
        address weth = vm.envAddress("WETH");

        vm.startBroadcast(deployerKey);

        HoodMarketsSniperAuctionV2 sniperAuction =
            new HoodMarketsSniperAuctionV2(deployer, hoodMarketsFactory, feeLocker, weth);
        console.log("HoodMarketsSniperAuctionV2:", address(sniperAuction));

        HoodMarketsMevDescendingFees descendingFees = new HoodMarketsMevDescendingFees();
        console.log("HoodMarketsMevDescendingFees:", address(descendingFees));

        HoodMarketsSniperUtilV2 sniperUtil =
            new HoodMarketsSniperUtilV2(address(sniperAuction), universalRouter, permit2, weth);
        console.log("HoodMarketsSniperUtilV2:", address(sniperUtil));

        vm.stopBroadcast();
    }
}
