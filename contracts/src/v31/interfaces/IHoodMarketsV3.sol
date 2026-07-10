// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

interface IHoodMarketsV3 {
    /// @notice When an unauthorized user calls a function
    error Unauthorized();
    /// @notice When the factory is deprecated
    error Deprecated();
    /// @notice When a tokenId is not found
    error NotFound();
    /// @notice When the tick spacing is invalid
    error InvalidTick();
    /// @notice When the vault percentage is invalid
    error InvalidVaultConfiguration();
    /// @notice When optional legacy vault config is supplied (v0.4+ uses embedded fractions)
    error LegacyVaultDisabled();
    /// @notice When the function is only valid on the originating chain
    error OnlyOriginatingChain();
    /// @notice When the function is only valid on a non-originating chain
    error OnlyNonOriginatingChains();
    /// @notice When the creator reward is invalid (greater than 95%)
    error InvalidCreatorReward();
    /// @notice When the creator information is invalid
    error InvalidCreatorInfo();
    /// @notice When the interface information is invalid
    error InvalidInterfaceInfo();
    /// @notice When buyer reward share count exceeds 1000
    error InvalidBuyerRewardShareCount();
    /// @notice When the team reward recipient is invalid
    error ZeroTeamRewardRecipient();

    struct TokenConfig {
        string name;
        string symbol;
        bytes32 salt;
        string image;
        string metadata;
        string context;
        uint256 originatingChainId;
    }

    struct VaultConfig {
        uint8 vaultPercentage;
        uint256 vaultDuration;
    }

    struct PoolConfig {
        address pairedToken;
        int24 tickIfToken0IsNewToken;
    }

    struct InitialBuyConfig {
        uint24 pairedTokenPoolFee;
        uint256 pairedTokenSwapAmountOutMinimum;
    }

    struct RewardsConfig {
        uint256 creatorReward;
        address creatorAdmin;
        address creatorRewardRecipient;
        address interfaceAdmin;
        address interfaceRewardRecipient;
    }

    struct FractionConfig {
        /// @notice Shares reserved for the first unique pool buyers (0–1000).
        uint16 buyerRewardShareCount;
    }

    struct DeploymentConfig {
        TokenConfig tokenConfig;
        VaultConfig vaultConfig;
        PoolConfig poolConfig;
        InitialBuyConfig initialBuyConfig;
        RewardsConfig rewardsConfig;
        FractionConfig fractionConfig;
    }

    struct DeploymentInfo {
        address token;
        uint256 positionId;
        address locker;
        address fractionCollection;
    }

    event TokenCreated(
        address indexed tokenAddress,
        address indexed creatorAdmin,
        address indexed interfaceAdmin,
        address creatorRewardRecipient,
        address interfaceRewardRecipient,
        uint256 positionId,
        string name,
        string symbol,
        int24 startingTickIfToken0IsNewToken,
        string metadata,
        uint256 amountTokensBought,
        uint256 vaultDuration,
        uint8 vaultPercentage,
        address fractionCollection,
        uint256 fractionVaultAmount,
        address msgSender
    );

    event VaultUpdated(address oldVault, address newVault);
    event LiquidityLockerUpdated(address oldLocker, address newLocker);
    event FractionDeployerUpdated(address oldDeployer, address newDeployer);
    event HoodMarketsV3DeployerUpdated(address oldHoodMarketsV3Deployer, address newHoodMarketsV3Deployer);
    event SetDeprecated(bool deprecated);
    event SetAdmin(address admin, bool isAdmin);
    event BuyerRewardRelayUpdated(address oldRelay, address newRelay);
    event BuyerShareIssued(address indexed token, address indexed buyer, address indexed fractionCollection);

    function MAX_CREATOR_REWARD() external pure returns (uint256);
    function TOKEN_SUPPLY() external pure returns (uint256);
    function FRACTION_COUNT() external pure returns (uint256);
    function FRACTION_VAULT_PERCENTAGE() external pure returns (uint8);
    function fractionCollectionForToken(address token) external view returns (address);

    function deprecated() external view returns (bool);
    function admins(address) external view returns (bool);

    function getTokensDeployedByUser(address user)
        external
        view
        returns (DeploymentInfo[] memory);

    function updateLiquidityLocker(address newLocker) external;
    function updateVault(address newVault) external;
    function setDeprecated(bool deprecated_) external;
    function setAdmin(address admin, bool isAdmin) external;
    function setBuyerRewardRelay(address relay) external;
    function issueBuyerShare(address token, address buyer) external;
    function claimRewards(address token) external;

    function deployTokenZeroSupply(TokenConfig memory tokenConfig, address tokenAdmin)
        external
        returns (address tokenAddress);

    function deployTokenWithCustomTeamRewardRecipient(
        DeploymentConfig memory deploymentConfig,
        address teamRewardRecipient
    ) external payable returns (address tokenAddress, uint256 positionId);

    function deployToken(DeploymentConfig memory deploymentConfig)
        external
        payable
        returns (address tokenAddress, uint256 positionId);
}
