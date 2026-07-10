// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {Test} from "forge-std/Test.sol";
import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import {HoodMarketsV3TokenFraction} from "../../src/v31/HoodMarketsV3TokenFraction.sol";
import {IHoodMarketsV3TokenFraction} from "../../src/v31/interfaces/IHoodMarketsV3TokenFraction.sol";
import {HoodMarketsV3FractionDeployer} from "../../src/v31/HoodMarketsV3FractionDeployer.sol";

contract MockLaunchToken is ERC20 {
    constructor() ERC20("Mock", "MOCK") {
        _mint(msg.sender, 100_000_000_000_000_000_000_000_000_000);
    }

    function mint(address to, uint256 amount) external {
        _mint(to, amount);
    }
}

contract MockWeth is ERC20 {
    constructor() ERC20("WETH", "WETH") {}

    function mint(address to, uint256 amount) external {
        _mint(to, amount);
    }
}

contract MockLpLocker {
    address public teamRecipient;

    mapping(uint256 => address) public teamOverrideRewardRecipientForToken;

    constructor(address teamRecipient_) {
        teamRecipient = teamRecipient_;
    }
}

contract MockHoodFactory {
    address public liquidityLocker;

    constructor(address liquidityLocker_) {
        liquidityLocker = liquidityLocker_;
    }

    function claimRewards(address) external pure {}
}

contract HoodMarketsV3TokenFractionTest is Test {
    MockLaunchToken internal token;
    MockWeth internal weth;
    HoodMarketsV3TokenFraction internal fraction;
    HoodMarketsV3FractionDeployer internal fractionDeployer;
    MockHoodFactory internal hoodFactory;

    address internal creator = makeAddr("creator");
    address internal buyer = makeAddr("buyer");
    address internal buyer2 = makeAddr("buyer2");
    address internal pool = makeAddr("pool");
    address internal platformFeeWallet = makeAddr("platformFeeWallet");

    MockLpLocker internal lpLocker;

    uint256 internal constant VAULT_AMOUNT = 10_000_000_000_000_000_000_000_000_000;
    uint256 internal constant BUYER_REWARD_COUNT = 300;

    function _deployFraction(uint256 buyerRewardCount) internal returns (HoodMarketsV3TokenFraction) {
        token.mint(address(hoodFactory), VAULT_AMOUNT);
        vm.startPrank(address(hoodFactory));
        token.approve(address(fractionDeployer), VAULT_AMOUNT);
        address fractionAddr = fractionDeployer.deployFraction(
            address(token), creator, VAULT_AMOUNT, buyerRewardCount
        );
        vm.stopPrank();

        HoodMarketsV3TokenFraction deployed = HoodMarketsV3TokenFraction(fractionAddr);
        vm.prank(address(hoodFactory));
        deployed.configureFeeRewards(1, address(weth), address(token), pool);
        return deployed;
    }

    function setUp() public {
        token = new MockLaunchToken();
        weth = new MockWeth();
        lpLocker = new MockLpLocker(platformFeeWallet);
        hoodFactory = new MockHoodFactory(address(lpLocker));
        fractionDeployer = new HoodMarketsV3FractionDeployer(address(hoodFactory));
        token.transfer(address(hoodFactory), VAULT_AMOUNT);

        fraction = _deployFraction(BUYER_REWARD_COUNT);
    }

    function test_initialize_splitsBuyerPoolAndCreatorShares() public view {
        assertEq(fraction.balanceOf(creator, 0), 1000 - BUYER_REWARD_COUNT);
        assertEq(fraction.balanceOf(address(fraction), 0), BUYER_REWARD_COUNT);
        assertEq(fraction.buyerRewardShareCap(), BUYER_REWARD_COUNT);
        assertEq(fraction.buyerRewardSharesRemaining(), BUYER_REWARD_COUNT);
        assertEq(token.balanceOf(address(fraction)), VAULT_AMOUNT);
    }

    function test_issueBuyerShare_fromFactory() public {
        vm.prank(address(hoodFactory));
        fraction.issueBuyerShare(buyer);

        assertEq(fraction.balanceOf(buyer, 0), 1);
        assertEq(fraction.balanceOf(address(fraction), 0), BUYER_REWARD_COUNT - 1);
        assertEq(fraction.buyerRewardSharesRemaining(), BUYER_REWARD_COUNT - 1);
        assertTrue(fraction.buyerShareIssued(buyer));
    }

    function test_issueBuyerShare_fromFeeAdmin() public {
        vm.prank(creator);
        fraction.issueBuyerShare(buyer);
        assertEq(fraction.balanceOf(buyer, 0), 1);
    }

    function test_revert_issueBuyerShareTwice() public {
        vm.startPrank(address(hoodFactory));
        fraction.issueBuyerShare(buyer);
        vm.expectRevert(IHoodMarketsV3TokenFraction.BuyerShareAlreadyIssued.selector);
        fraction.issueBuyerShare(buyer);
        vm.stopPrank();
    }

    function test_redeem_transfersUnderlyingAndBurnsShares() public {
        vm.prank(creator);
        fraction.redeem(1);

        assertEq(fraction.balanceOf(creator, 0), 1000 - BUYER_REWARD_COUNT - 1);
        assertEq(token.balanceOf(creator), VAULT_AMOUNT / 1000);
    }

    function test_transferThenRedeem() public {
        vm.prank(creator);
        fraction.safeTransferFrom(creator, buyer, 0, 250, "");

        assertEq(fraction.balanceOf(buyer, 0), 250);
        assertEq(fraction.balanceOf(platformFeeWallet, 0), 0);

        vm.prank(buyer);
        fraction.redeem(50);

        assertEq(fraction.balanceOf(buyer, 0), 200);
        assertEq(token.balanceOf(buyer), (VAULT_AMOUNT / 1000) * 50);
    }

    function test_transfer_noPlatformFeeSkim() public {
        vm.prank(creator);
        fraction.safeTransferFrom(creator, buyer, 0, 100, "");

        assertEq(fraction.balanceOf(creator, 0), 700 - 100);
        assertEq(fraction.balanceOf(buyer, 0), 100);
        assertEq(fraction.balanceOf(platformFeeWallet, 0), 0);
    }

    function test_claimTradingFees_proRataByShares() public {
        weth.mint(address(fraction), 1 ether);

        vm.prank(creator);
        fraction.claimTradingFees();
        assertApproxEqAbs(weth.balanceOf(creator), 1 ether, 1);
    }

    function test_claimTradingFees_splitAfterTransfer_oneTxPaysAll() public {
        vm.prank(creator);
        fraction.safeTransferFrom(creator, buyer, 0, 250, "");

        weth.mint(address(fraction), 1 ether);

        vm.prank(buyer2);
        fraction.claimTradingFees();

        uint256 creatorExpected = uint256(1 ether) * 450 / 700;
        uint256 buyerExpected = uint256(1 ether) * 250 / 700;
        assertApproxEqAbs(weth.balanceOf(creator), creatorExpected, 2);
        assertApproxEqAbs(weth.balanceOf(buyer), buyerExpected, 2);
        assertEq(weth.balanceOf(platformFeeWallet), 0);
        assertLt(weth.balanceOf(address(fraction)), 10);
    }

    function test_claimTradingFees_revertWhenNothingToClaim() public {
        vm.expectRevert(IHoodMarketsV3TokenFraction.NothingToClaim.selector);
        vm.prank(creator);
        fraction.claimTradingFees();
    }

    function test_claimTradingFees_secondClaimAfterNewFees() public {
        weth.mint(address(fraction), 1 ether);

        vm.prank(creator);
        fraction.claimTradingFees();
        assertApproxEqAbs(weth.balanceOf(creator), 1 ether, 1);

        // Previously, rewardTokenAccounted stayed high after payout and blocked the next claim
        // until new deposits exceeded the gap. New fees must be claimable immediately.
        weth.mint(address(fraction), 0.5 ether);
        uint256 before = weth.balanceOf(creator);

        vm.prank(creator);
        fraction.claimTradingFees();
        assertApproxEqAbs(weth.balanceOf(creator) - before, 0.5 ether, 1);
    }

    function test_syncRewardAccounting_unlocksStuckFees() public {
        weth.mint(address(fraction), 1 ether);
        vm.prank(creator);
        fraction.claimTradingFees();

        // Simulate legacy drift: accounted above balance after payout.
        // Force a second deposit that would be blocked without sync on old bytecode;
        // with fixed claimTradingFees this path already works — also cover sync helper.
        weth.mint(address(fraction), 0.25 ether);
        fraction.syncRewardAccounting();

        uint256 before = weth.balanceOf(creator);
        vm.prank(creator);
        fraction.claimTradingFees();
        assertApproxEqAbs(weth.balanceOf(creator) - before, 0.25 ether, 1);
    }

    function test_buyerShareHolder_claimsTradingFees() public {
        vm.prank(address(hoodFactory));
        fraction.issueBuyerShare(buyer);

        weth.mint(address(fraction), 1 ether);

        vm.prank(buyer);
        fraction.claimTradingFees();
        assertGt(weth.balanceOf(buyer), 0);
    }

    function test_listAndBuyShares_nativeEth() public {
        vm.prank(creator);
        fraction.safeTransferFrom(creator, buyer, 0, 100, "");

        assertEq(fraction.balanceOf(buyer, 0), 100);
        assertEq(fraction.balanceOf(platformFeeWallet, 0), 0);

        vm.deal(buyer2, 1 ether);
        uint256 price = 0.05 ether;

        vm.prank(buyer);
        uint256 listingId = fraction.listShares(50, address(0), price);
        assertEq(listingId, 1);
        assertEq(fraction.balanceOf(buyer, 0), 50);
        assertEq(fraction.balanceOf(address(fraction), 0), BUYER_REWARD_COUNT + 50);

        uint256 sellerBefore = buyer.balance;
        vm.prank(buyer2);
        fraction.buyShares{value: price}(listingId);

        uint256 platformFee = (price * 500) / 10_000;
        uint256 sellerProceeds = price - platformFee;

        assertEq(buyer2.balance, 1 ether - price);
        assertEq(buyer.balance, sellerBefore + sellerProceeds);
        assertEq(platformFeeWallet.balance, platformFee);
        assertEq(fraction.balanceOf(buyer2, 0), 50);
        assertEq(fraction.balanceOf(address(fraction), 0), BUYER_REWARD_COUNT);
    }

    function test_shareSalePlatformFeeRecipient_matchesLocker() public view {
        assertEq(fraction.shareSalePlatformFeeRecipient(), platformFeeWallet);
        assertEq(fraction.SHARE_SALE_PLATFORM_FEE_BPS(), 500);
    }

    function test_fundAndCancelBuyerRewardPool() public {
        HoodMarketsV3TokenFraction fresh = _deployFraction(0);

        vm.prank(creator);
        fresh.fundBuyerRewardPool(25);

        assertEq(fresh.buyerRewardShareCap(), 25);
        assertEq(fresh.buyerRewardSharesRemaining(), 25);
        assertEq(fresh.balanceOf(address(fresh), 0), 25);
        assertEq(fresh.balanceOf(creator, 0), 1000 - 25);

        vm.prank(creator);
        fresh.cancelBuyerRewardPool();

        assertEq(fresh.buyerRewardSharesRemaining(), 0);
        assertEq(fresh.buyerRewardShareCap(), 0);
        assertEq(fresh.balanceOf(creator, 0), 1000);
        assertEq(fresh.balanceOf(address(fresh), 0), 0);
    }

    function test_airdropShares_oneTx() public {
        address[] memory recipients = new address[](3);
        recipients[0] = buyer;
        recipients[1] = buyer2;
        recipients[2] = makeAddr("recipient3");

        uint256[] memory amounts = new uint256[](3);
        amounts[0] = 10;
        amounts[1] = 50;
        amounts[2] = 100;

        uint256 creatorBefore = fraction.balanceOf(creator, 0);
        uint256 platformBefore = fraction.balanceOf(platformFeeWallet, 0);

        vm.prank(creator);
        fraction.airdropShares(recipients, amounts);

        assertEq(fraction.balanceOf(creator, 0), creatorBefore - 160);
        assertEq(fraction.balanceOf(buyer, 0), 10);
        assertEq(fraction.balanceOf(buyer2, 0), 50);
        assertEq(fraction.balanceOf(recipients[2], 0), 100);
        assertEq(fraction.balanceOf(platformFeeWallet, 0), platformBefore);
    }

    function test_revert_airdropShares_insufficientBalance() public {
        address[] memory recipients = new address[](1);
        recipients[0] = buyer;
        uint256[] memory amounts = new uint256[](1);
        amounts[0] = 10_000;

        vm.prank(creator);
        vm.expectRevert(IHoodMarketsV3TokenFraction.InsufficientFractionBalance.selector);
        fraction.airdropShares(recipients, amounts);
    }

    function test_fundBuyerRewardPool_thenIssue() public {
        HoodMarketsV3TokenFraction fresh = _deployFraction(0);

        vm.prank(creator);
        fresh.fundBuyerRewardPool(5);

        vm.prank(creator);
        fresh.issueBuyerShare(buyer2);

        assertEq(fresh.balanceOf(buyer2, 0), 1);
        assertEq(fresh.buyerRewardSharesRemaining(), 4);
    }

    function test_cancelListing_returnsShares() public {
        vm.prank(creator);
        fraction.safeTransferFrom(creator, buyer, 0, 100, "");

        vm.prank(buyer);
        uint256 listingId = fraction.listShares(10, address(0), 1 ether);
        assertEq(fraction.balanceOf(buyer, 0), 90);

        vm.prank(buyer);
        fraction.cancelListing(listingId);
        assertEq(fraction.balanceOf(buyer, 0), 100);
    }

    function test_revert_buyShares_wrongPayment() public {
        vm.prank(creator);
        fraction.safeTransferFrom(creator, buyer, 0, 5, "");

        vm.prank(buyer);
        uint256 listingId = fraction.listShares(5, address(0), 1 ether);

        vm.deal(buyer2, 2 ether);
        vm.prank(buyer2);
        vm.expectRevert(IHoodMarketsV3TokenFraction.WrongPayment.selector);
        fraction.buyShares{value: 0.5 ether}(listingId);
    }
}
