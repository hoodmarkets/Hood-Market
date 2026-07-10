// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {Script, console} from "forge-std/Script.sol";
import {HoodMarkets} from "../../src/HoodMarkets.sol";

contract ConfigureAllowlists is Script {
    function run() external {
        uint256 deployerKey = vm.envUint("DEPLOYER_PRIVATE_KEY");
        HoodMarkets hoodMarkets = HoodMarkets(vm.envAddress("HOODMARKETS_FACTORY"));

        address dynamicHook = vm.envAddress("LIQUID_HOOK_DYNAMIC_FEE_V2");
        address staticHook = vm.envAddress("LIQUID_HOOK_STATIC_FEE_V2");
        address lpLocker = vm.envAddress("LIQUID_LP_LOCKER_FEE_CONVERSION");
        address devBuyV4 = vm.envAddress("LIQUID_UNIV4_ETH_DEV_BUY");
        address sniperAuction = vm.envAddress("LIQUID_SNIPER_AUCTION_V2");
        address descendingFees = vm.envAddress("LIQUID_MEV_DESCENDING_FEES");

        vm.startBroadcast(deployerKey);

        hoodMarkets.setDeprecated(false);
        console.log("Factory enabled (setDeprecated false)");

        hoodMarkets.setHook(dynamicHook, true);
        hoodMarkets.setHook(staticHook, true);
        hoodMarkets.setLocker(lpLocker, dynamicHook, true);
        hoodMarkets.setLocker(lpLocker, staticHook, true);
        hoodMarkets.setExtension(devBuyV4, true);
        hoodMarkets.setMevModule(sniperAuction, true);
        hoodMarkets.setMevModule(descendingFees, true);

        vm.stopBroadcast();
        console.log("Allowlists configured.");
    }
}
