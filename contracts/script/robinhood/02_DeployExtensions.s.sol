// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {Script, console} from "forge-std/Script.sol";
import {HoodMarketsUniv4EthDevBuy} from "../../src/extensions/HoodMarketsUniv4EthDevBuy.sol";

/// @notice Minimal extensions for the social launcher (launch buy only).
contract DeployExtensions is Script {
    function run() external {
        uint256 deployerKey = vm.envUint("DEPLOYER_PRIVATE_KEY");
        address hoodMarketsFactory = vm.envAddress("HOODMARKETS_FACTORY");
        address weth = vm.envAddress("WETH");
        address universalRouter = vm.envAddress("UNISWAP_UNIVERSAL_ROUTER");
        address permit2 = vm.envAddress("PERMIT2");

        vm.startBroadcast(deployerKey);

        HoodMarketsUniv4EthDevBuy devBuyV4 =
            new HoodMarketsUniv4EthDevBuy(hoodMarketsFactory, weth, universalRouter, permit2);
        console.log("HoodMarketsUniv4EthDevBuy:", address(devBuyV4));

        vm.stopBroadcast();
    }
}
