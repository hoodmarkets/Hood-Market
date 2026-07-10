// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {Script, console} from "forge-std/Script.sol";
import {HoodMarketsLpLockerFeeConversion} from "../../src/lp-lockers/HoodMarketsLpLockerFeeConversion.sol";

contract DeployLpLocker is Script {
    function run() external {
        uint256 deployerKey = vm.envUint("DEPLOYER_PRIVATE_KEY");
        address deployer = vm.addr(deployerKey);
        address hoodMarketsFactory = vm.envAddress("HOODMARKETS_FACTORY");
        address feeLocker = vm.envAddress("LIQUID_FEE_LOCKER");
        address poolManager = vm.envAddress("UNISWAP_V4_POOL_MANAGER");
        address positionManager = vm.envAddress("UNISWAP_V4_POSITION_MANAGER");
        address universalRouter = vm.envAddress("UNISWAP_UNIVERSAL_ROUTER");
        address permit2 = vm.envAddress("PERMIT2");

        vm.startBroadcast(deployerKey);

        HoodMarketsLpLockerFeeConversion lpLocker = new HoodMarketsLpLockerFeeConversion(
            deployer, hoodMarketsFactory, feeLocker, positionManager, permit2, universalRouter, poolManager
        );
        console.log("HoodMarketsLpLockerFeeConversion:", address(lpLocker));

        vm.stopBroadcast();
    }
}
