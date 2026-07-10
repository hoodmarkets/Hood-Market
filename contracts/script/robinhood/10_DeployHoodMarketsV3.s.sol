// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {Script, console} from "forge-std/Script.sol";
import {HoodMarketsV3} from "../../src/v31/HoodMarketsV3.sol";
import {HoodMarketsV3Vault} from "../../src/v31/HoodMarketsV3Vault.sol";
import {HoodMarketsV3LpLocker} from "../../src/v31/HoodMarketsV3LpLocker.sol";
import {HoodMarketsV3FractionDeployer} from "../../src/v31/HoodMarketsV3FractionDeployer.sol";

/// @notice Deploy hood.markets V3 simple launcher (Uniswap V3 pools, DexScreener-friendly).
/// Fee split embedded in HoodMarketsV3LpLocker: 5% hoodmarkets platform / up to 95% creator (+ interface).
/// v0.6.0+: fee recipient sets buyer reward pool; first X unique buyers get 1 share each.
contract DeployHoodMarketsV3 is Script {
    function run() external {
        uint256 deployerKey = vm.envUint("DEPLOYER_PRIVATE_KEY");
        address deployer = vm.addr(deployerKey);
        // Defaults to deployer; set HOODMARKETS_OWNER when owner should differ from broadcaster.
        address owner = vm.envOr("HOODMARKETS_OWNER", deployer);

        address weth = vm.envAddress("WETH");
        address v3Factory = vm.envAddress("UNISWAP_V3_FACTORY");
        address positionManager = vm.envAddress("UNISWAP_V3_POSITION_MANAGER");
        address swapRouter = vm.envAddress("UNISWAP_V3_SWAP_ROUTER");
        address platformFeeRecipient = vm.envAddress("HOODMARKETS_PLATFORM_FEE_RECIPIENT");

        console.log("Broadcast deployer:", deployer);
        console.log("Contract owner:", owner);
        console.log("Platform fee recipient (5%):", platformFeeRecipient);

        vm.startBroadcast(deployerKey);

        HoodMarketsV3 factory = new HoodMarketsV3(owner);
        HoodMarketsV3Vault vault = new HoodMarketsV3Vault(owner, address(factory), 30 days);
        HoodMarketsV3LpLocker locker = new HoodMarketsV3LpLocker(
            owner, address(factory), positionManager, platformFeeRecipient
        );
        HoodMarketsV3FractionDeployer fractionDeployer =
            new HoodMarketsV3FractionDeployer(address(factory));

        factory.initialize(
            v3Factory,
            positionManager,
            swapRouter,
            weth,
            address(locker),
            address(vault),
            address(fractionDeployer)
        );

        factory.setBuyerRewardRelay(deployer);

        vm.stopBroadcast();

        console.log("HoodMarketsV3 factory:", address(factory));
        console.log("HoodMarketsV3Vault:", address(vault));
        console.log("HoodMarketsV3LpLocker:", address(locker));
        console.log("HoodMarketsV3FractionDeployer:", address(fractionDeployer));
        console.log("Owner:", owner);
        console.log("Platform fee recipient (5% of swap fees):", platformFeeRecipient);
    }
}
