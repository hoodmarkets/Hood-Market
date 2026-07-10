// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";

/// @title HoodMarketsCommunityLaunchEscrow
/// @notice Trustless ETH escrow for hood.markets Community Launch on Robinhood Chain (4663).
/// @dev Round metadata lives in api.hood.markets (SQLite); on-chain stores backer orders only.
contract HoodMarketsPetitionEscrow is Ownable, ReentrancyGuard {
    uint256 public constant GOAL_UNITS = 1000;
    uint256 public immutable unitPriceWei;

    struct Order {
        uint16 units;
        uint256 launchBuyWei;
        bool active;
    }

    mapping(uint256 petitionId => uint256 soldUnits) public soldUnits;
    mapping(uint256 petitionId => mapping(address buyer => Order)) public orders;

    event Deposited(
        uint256 indexed petitionId, address indexed buyer, uint16 units, uint256 launchBuyWei, uint256 totalWei
    );
    event Refunded(uint256 indexed petitionId, address indexed buyer, uint256 amountWei);
    event Finalized(uint256 indexed petitionId, address indexed operator, uint256 totalWei);

    error ZeroUnits();
    error LaunchBuyRequiresUnits();
    error AlreadyActive();
    error NotActive();
    error SoldOut();
    error NotSoldOut();
    error NothingToRefund();

    constructor(address admin_, uint256 unitPriceWei_) Ownable(admin_) {
        unitPriceWei = unitPriceWei_;
    }

    function requiredWei(uint16 units, uint256 launchBuyWei) public view returns (uint256) {
        return uint256(units) * unitPriceWei + launchBuyWei;
    }

    /// @notice Deposit units + optional launch buy (launch buy requires units >= 1).
    function deposit(uint256 petitionId, uint16 units, uint256 launchBuyWei) external payable nonReentrant {
        if (units == 0) revert ZeroUnits();
        if (launchBuyWei > 0 && units < 1) revert LaunchBuyRequiresUnits();
        Order storage order = orders[petitionId][msg.sender];
        if (order.active) revert AlreadyActive();

        uint256 sold = soldUnits[petitionId];
        if (sold + units > GOAL_UNITS) revert SoldOut();
        uint256 needed = requiredWei(units, launchBuyWei);
        if (msg.value < needed) revert NothingToRefund();

        order.units = units;
        order.launchBuyWei = launchBuyWei;
        order.active = true;
        soldUnits[petitionId] = sold + units;

        emit Deposited(petitionId, msg.sender, units, launchBuyWei, msg.value);
    }

    /// @notice Refund active order while petition is open/expired (off-chain gate).
    function refund(uint256 petitionId) external nonReentrant {
        Order storage order = orders[petitionId][msg.sender];
        if (!order.active) revert NotActive();

        uint16 refundedUnits = order.units;
        uint256 amount = requiredWei(order.units, order.launchBuyWei);
        order.active = false;
        order.units = 0;
        order.launchBuyWei = 0;
        soldUnits[petitionId] -= refundedUnits;

        (bool ok,) = msg.sender.call{value: amount}("");
        require(ok, "refund failed");
        emit Refunded(petitionId, msg.sender, amount);
    }

    /// @notice Operator sweeps sold-out petition funds for HoodMarketsV3 launch (no buyer refund after this).
    function finalize(uint256 petitionId) external onlyOwner nonReentrant {
        if (soldUnits[petitionId] != GOAL_UNITS) revert NotSoldOut();
        uint256 bal = address(this).balance;
        (bool ok,) = msg.sender.call{value: bal}("");
        require(ok, "finalize transfer failed");
        emit Finalized(petitionId, msg.sender, bal);
    }

    function getOrder(uint256 petitionId, address buyer)
        external
        view
        returns (uint16 units, uint256 launchBuyWei, bool active)
    {
        Order storage order = orders[petitionId][buyer];
        return (order.units, order.launchBuyWei, order.active);
    }
}
