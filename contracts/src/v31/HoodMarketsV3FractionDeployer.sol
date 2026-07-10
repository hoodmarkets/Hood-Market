// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {HoodMarketsV3TokenFraction} from "./HoodMarketsV3TokenFraction.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";

/// @notice Deploys per-token fractional vault collections for HoodMarkets V3.
contract HoodMarketsV3FractionDeployer {
    using SafeERC20 for IERC20;

    address public immutable hoodMarketsFactory;

    error UnauthorizedFactory();

    constructor(address hoodMarketsFactory_) {
        hoodMarketsFactory = hoodMarketsFactory_;
    }

    function deployFraction(
        address tokenAddress,
        address initialHolder,
        uint256 fractionVaultAmount,
        uint256 buyerRewardShareCount
    ) external returns (address fractionCollection) {
        if (msg.sender != hoodMarketsFactory) revert UnauthorizedFactory();

        HoodMarketsV3TokenFraction fraction = new HoodMarketsV3TokenFraction(
            hoodMarketsFactory,
            address(this),
            tokenAddress,
            "",
            fractionVaultAmount
        );
        IERC20(tokenAddress).safeTransferFrom(msg.sender, address(fraction), fractionVaultAmount);
        fraction.initialize(initialHolder, fractionVaultAmount, buyerRewardShareCount);

        return address(fraction);
    }
}
