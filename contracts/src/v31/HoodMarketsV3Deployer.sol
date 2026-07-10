// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {HoodMarketsAsciiBanner} from "../HoodMarketsAsciiBanner.sol";
import {HoodMarketsV3Token} from "./HoodMarketsV3Token.sol";
import {IHoodMarketsV3} from "./interfaces/IHoodMarketsV3.sol";

/// @notice hood.markets V3 token deployer library
library HoodMarketsV3Deployer {
    function deployToken(IHoodMarketsV3.TokenConfig memory tokenConfig, address admin, uint256 supply)
        external
        returns (address tokenAddress)
    {
        HoodMarketsV3Token token = new HoodMarketsV3Token{salt: keccak256(abi.encode(admin, tokenConfig.salt))}(
            tokenConfig.name,
            tokenConfig.symbol,
            supply,
            admin,
            tokenConfig.image,
            tokenConfig.metadata,
            tokenConfig.context,
            tokenConfig.originatingChainId
        );
        tokenAddress = address(token);
    }
}
