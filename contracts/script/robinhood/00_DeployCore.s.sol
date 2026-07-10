// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {Script, console} from "forge-std/Script.sol";
import {HoodMarkets} from "../../src/HoodMarkets.sol";
import {HoodMarketsFeeLocker} from "../../src/HoodMarketsFeeLocker.sol";
import {HoodMarketsPoolExtensionAllowlist} from "../../src/hooks/HoodMarketsPoolExtensionAllowlist.sol";

/// @notice Phase 0: Deploy hoodmarkets core infrastructure on Robinhood Chain
contract DeployCore is Script {
    function run() external {
        uint256 deployerKey = vm.envUint("DEPLOYER_PRIVATE_KEY");
        address deployer = vm.addr(deployerKey);

        vm.startBroadcast(deployerKey);

        HoodMarkets hoodMarkets = new HoodMarkets(deployer);
        console.log("HoodMarkets factory:", address(hoodMarkets));

        HoodMarketsFeeLocker feeLocker = new HoodMarketsFeeLocker(deployer);
        console.log("HoodMarketsFeeLocker:", address(feeLocker));

        HoodMarketsPoolExtensionAllowlist poolExtAllowlist = new HoodMarketsPoolExtensionAllowlist(deployer);
        console.log("HoodMarketsPoolExtensionAllowlist:", address(poolExtAllowlist));

        vm.stopBroadcast();
    }
}
