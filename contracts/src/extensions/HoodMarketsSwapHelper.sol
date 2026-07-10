// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {IHoodMarketsHookV2} from "../hooks/interfaces/IHoodMarketsHookV2.sol";
import {HoodMarketsAsciiBanner} from "../HoodMarketsAsciiBanner.sol";

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {IPermit2} from "@uniswap/permit2/src/interfaces/IPermit2.sol";
import {
    IUniversalRouter
} from "@uniswap/universal-router/contracts/interfaces/IUniversalRouter.sol";
import {Commands} from "@uniswap/universal-router/contracts/libraries/Commands.sol";
import {IHooks} from "@uniswap/v4-core/src/interfaces/IHooks.sol";
import {Currency} from "@uniswap/v4-core/src/types/Currency.sol";
import {PoolKey} from "@uniswap/v4-core/src/types/PoolKey.sol";
import {IV4Router} from "@uniswap/v4-periphery/src/interfaces/IV4Router.sol";
import {IWETH9} from "@uniswap/v4-periphery/src/interfaces/external/IWETH9.sol";
import {Actions} from "@uniswap/v4-periphery/src/libraries/Actions.sol";

/// @notice One-tx ETH ↔ hoodmarkets token swaps via Universal Router (wrap/approve hidden).
contract HoodMarketsSwapHelper is ReentrancyGuard {
    using SafeERC20 for IERC20;

    string public constant PROTOCOL = "hoodmarkets";

    uint24 public constant DYNAMIC_FEE_FLAG = 0x800000;
    int24 public constant TICK_SPACING = 200;

    IWETH9 public immutable weth;
    IUniversalRouter public immutable universalRouter;
    IPermit2 public immutable permit2;
    address public immutable hook;

    event Bought(address indexed buyer, address indexed token, uint256 ethIn, uint256 tokensOut);
    event Sold(address indexed seller, address indexed token, uint256 tokensIn, uint256 ethOut);

    error ZeroAmount();
    error EthTransferFailed();

    constructor(address weth_, address universalRouter_, address permit2_, address hook_) {
        weth = IWETH9(weth_);
        universalRouter = IUniversalRouter(universalRouter_);
        permit2 = IPermit2(permit2_);
        hook = hook_;
    }

    /// @notice Swap msg.value ETH for `token` (sent to caller).
    function buy(address token, uint128 amountOutMinimum) external payable nonReentrant {
        if (msg.value == 0) revert ZeroAmount();
        PoolKey memory poolKey = _poolKey(token);
        weth.deposit{value: msg.value}();
        uint256 out = _swap(
            poolKey, address(weth), token, uint128(msg.value), amountOutMinimum
        );
        IERC20(token).safeTransfer(msg.sender, out);
        emit Bought(msg.sender, token, msg.value, out);
    }

    /// @notice Swap `amountIn` of `token` for ETH (sent to caller). Approve this contract first.
    function sell(address token, uint256 amountIn, uint128 amountOutMinimum)
        external
        nonReentrant
    {
        if (amountIn == 0) revert ZeroAmount();
        PoolKey memory poolKey = _poolKey(token);
        IERC20(token).safeTransferFrom(msg.sender, address(this), amountIn);
        uint256 wethOut = _swap(poolKey, token, address(weth), uint128(amountIn), amountOutMinimum);
        weth.withdraw(wethOut);
        (bool ok,) = msg.sender.call{value: wethOut}("");
        if (!ok) revert EthTransferFailed();
        emit Sold(msg.sender, token, amountIn, wethOut);
    }

    receive() external payable {}

    function _poolKey(address token) internal view returns (PoolKey memory) {
        address w = address(weth);
        if (token < w) {
            return PoolKey({
                currency0: Currency.wrap(token),
                currency1: Currency.wrap(w),
                fee: DYNAMIC_FEE_FLAG,
                tickSpacing: TICK_SPACING,
                hooks: IHooks(hook)
            });
        }
        return PoolKey({
            currency0: Currency.wrap(w),
            currency1: Currency.wrap(token),
            fee: DYNAMIC_FEE_FLAG,
            tickSpacing: TICK_SPACING,
            hooks: IHooks(hook)
        });
    }

    function _hookData() internal pure returns (bytes memory) {
        return abi.encode(
            IHoodMarketsHookV2.PoolSwapData({
                mevModuleSwapData: bytes(""),
                poolExtensionSwapData: bytes("")
            })
        );
    }

    function _swap(
        PoolKey memory poolKey,
        address tokenIn,
        address tokenOut,
        uint128 amountIn,
        uint128 amountOutMinimum
    ) internal returns (uint256) {
        IERC20(tokenIn).approve(address(permit2), amountIn);
        permit2.approve(tokenIn, address(universalRouter), amountIn, uint48(block.timestamp));

        bytes memory commands = abi.encodePacked(uint8(Commands.V4_SWAP));
        bytes memory actions = abi.encodePacked(
            uint8(Actions.SWAP_EXACT_IN_SINGLE),
            uint8(Actions.SETTLE_ALL),
            uint8(Actions.TAKE_ALL)
        );
        bytes[] memory params = new bytes[](3);

        bool tokenInIsToken0 = Currency.unwrap(poolKey.currency0) == tokenIn;
        params[0] = abi.encode(
            IV4Router.ExactInputSingleParams({
                poolKey: poolKey,
                zeroForOne: tokenInIsToken0,
                amountIn: amountIn,
                amountOutMinimum: amountOutMinimum,
                hookData: _hookData()
            })
        );
        params[1] = abi.encode(tokenIn, uint256(amountIn));
        params[2] = abi.encode(tokenOut, amountOutMinimum);

        bytes[] memory inputs = new bytes[](1);
        inputs[0] = abi.encode(actions, params);

        uint256 tokenOutBefore = IERC20(tokenOut).balanceOf(address(this));
        universalRouter.execute(commands, inputs, block.timestamp);
        return IERC20(tokenOut).balanceOf(address(this)) - tokenOutBefore;
    }
}
