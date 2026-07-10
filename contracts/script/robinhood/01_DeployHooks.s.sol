// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {Script, console} from "forge-std/Script.sol";
import {Hooks} from "@uniswap/v4-core/src/libraries/Hooks.sol";
import {HoodMarketsHookDynamicFeeV2} from "../../src/hooks/HoodMarketsHookDynamicFeeV2.sol";
import {HoodMarketsHookStaticFeeV2} from "../../src/hooks/HoodMarketsHookStaticFeeV2.sol";

contract DeployHooks is Script {
    address constant CREATE2_DEPLOYER = 0x4e59b44847b379578588920cA78FbF26c0B4956C;

    uint160 constant HOOK_FLAGS = uint160(
        Hooks.BEFORE_INITIALIZE_FLAG | Hooks.BEFORE_ADD_LIQUIDITY_FLAG | Hooks.BEFORE_SWAP_FLAG
            | Hooks.AFTER_SWAP_FLAG | Hooks.BEFORE_SWAP_RETURNS_DELTA_FLAG
            | Hooks.AFTER_SWAP_RETURNS_DELTA_FLAG
    );

    uint160 constant FLAG_MASK = uint160((1 << 14) - 1);

    function run() external {
        uint256 deployerKey = vm.envUint("DEPLOYER_PRIVATE_KEY");
        address hoodMarketsFactory = vm.envAddress("HOODMARKETS_FACTORY");
        address poolExtAllowlist = vm.envAddress("POOL_EXTENSION_ALLOWLIST");
        address poolManager = vm.envAddress("UNISWAP_V4_POOL_MANAGER");
        address weth = vm.envAddress("WETH");

        bytes memory constructorArgs = abi.encode(poolManager, hoodMarketsFactory, poolExtAllowlist, weth);

        bytes memory dynamicCreationCode =
            abi.encodePacked(type(HoodMarketsHookDynamicFeeV2).creationCode, constructorArgs);
        bytes32 dynamicSalt = _mineSalt(dynamicCreationCode, HOOK_FLAGS);
        address dynamicAddr = _computeAddress(dynamicSalt, dynamicCreationCode);
        console.log("Mined HoodMarketsHookDynamicFeeV2:", dynamicAddr);

        bytes memory staticCreationCode =
            abi.encodePacked(type(HoodMarketsHookStaticFeeV2).creationCode, constructorArgs);
        bytes32 staticSalt = _mineSalt(staticCreationCode, HOOK_FLAGS);
        address staticAddr = _computeAddress(staticSalt, staticCreationCode);
        console.log("Mined HoodMarketsHookStaticFeeV2:", staticAddr);

        vm.startBroadcast(deployerKey);

        {
            (bool success,) = CREATE2_DEPLOYER.call(abi.encodePacked(dynamicSalt, dynamicCreationCode));
            require(success, "Dynamic hook CREATE2 deploy failed");
            require(dynamicAddr.code.length > 0, "Dynamic hook not deployed");
        }
        console.log("HoodMarketsHookDynamicFeeV2:", dynamicAddr);

        {
            (bool success,) = CREATE2_DEPLOYER.call(abi.encodePacked(staticSalt, staticCreationCode));
            require(success, "Static hook CREATE2 deploy failed");
            require(staticAddr.code.length > 0, "Static hook not deployed");
        }
        console.log("HoodMarketsHookStaticFeeV2:", staticAddr);

        vm.stopBroadcast();
    }

    function _mineSalt(bytes memory creationCode, uint160 flags) internal view returns (bytes32) {
        flags = flags & FLAG_MASK;
        for (uint256 salt; salt < 500_000; salt++) {
            address addr = _computeAddress(bytes32(salt), creationCode);
            if (uint160(addr) & FLAG_MASK == flags && addr.code.length == 0) {
                return bytes32(salt);
            }
        }
        revert("Could not find valid hook salt");
    }

    function _computeAddress(bytes32 salt, bytes memory creationCode) internal pure returns (address) {
        return address(
            uint160(
                uint256(
                    keccak256(abi.encodePacked(bytes1(0xFF), CREATE2_DEPLOYER, salt, keccak256(creationCode)))
                )
            )
        );
    }
}
