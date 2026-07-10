// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {Script, console} from "forge-std/Script.sol";
import {HoodMarketsSwapHelper} from "../../src/extensions/HoodMarketsSwapHelper.sol";

/// @notice Post-launch one-click buy/sell helper for hood.markets.
contract DeploySwapHelper is Script {
    function run() external {
        uint256 deployerKey = vm.envUint("DEPLOYER_PRIVATE_KEY");
        address weth = vm.envAddress("WETH");
        address universalRouter = vm.envAddress("UNISWAP_UNIVERSAL_ROUTER");
        address permit2 = vm.envAddress("PERMIT2");
        address hookStatic = vm.envAddress("HOODMARKETS_HOOK_STATIC_FEE_V2");

        vm.startBroadcast(deployerKey);

        HoodMarketsSwapHelper helper =
            new HoodMarketsSwapHelper(weth, universalRouter, permit2, hookStatic);
        console.log("HoodMarketsSwapHelper:", address(helper));

        vm.stopBroadcast();
    }
}
