// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {IHoodMarketsPoolExtensionAllowlist} from "./interfaces/IHoodMarketsPoolExtensionAllowlist.sol";
import {HoodMarketsAsciiBanner} from "../HoodMarketsAsciiBanner.sol";

import {OwnerAdmins} from "../utils/OwnerAdmins.sol";

contract HoodMarketsPoolExtensionAllowlist is IHoodMarketsPoolExtensionAllowlist, OwnerAdmins {
    string public constant PROTOCOL = "hoodmarkets";
    mapping(address extension => bool enabled) public enabledExtensions;

    constructor(address owner_) OwnerAdmins(owner_) {}

    function setPoolExtension(address extension, bool enabled) external onlyOwnerOrAdmin {
        enabledExtensions[extension] = enabled;
        emit SetPoolExtension(extension, enabled);
    }
}
