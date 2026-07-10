// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {Script, console} from "forge-std/Script.sol";
import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";

/// @notice Transfer HoodMarkets V3 factory, vault, and LP locker to a new owner (e.g. Gnosis Safe on Robinhood).
/// Run with the current owner's private key as DEPLOYER_PRIVATE_KEY.
contract TransferOwnershipV3 is Script {
    function run() external {
        uint256 deployerKey = vm.envUint("DEPLOYER_PRIVATE_KEY");
        address newOwner = vm.envAddress("HOODMARKETS_NEW_OWNER");

        address factory = vm.envAddress("HOODMARKETS_V3_FACTORY");
        address vault = vm.envAddress("HOODMARKETS_V3_VAULT");
        address locker = vm.envAddress("HOODMARKETS_V3_LP_LOCKER");

        vm.startBroadcast(deployerKey);

        Ownable(factory).transferOwnership(newOwner);
        console.log("HoodMarketsV3 owner ->", newOwner);

        Ownable(vault).transferOwnership(newOwner);
        console.log("HoodMarketsV3Vault owner ->", newOwner);

        Ownable(locker).transferOwnership(newOwner);
        console.log("HoodMarketsV3LpLocker owner ->", newOwner);

        vm.stopBroadcast();
    }
}
