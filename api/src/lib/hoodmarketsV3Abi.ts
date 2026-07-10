export const HOODMARKETS_V3_ABI = [
  {
    "type": "constructor",
    "inputs": [
      {
        "name": "owner_",
        "type": "address",
        "internalType": "address"
      }
    ],
    "stateMutability": "nonpayable"
  },
  {
    "type": "function",
    "name": "FRACTION_COUNT",
    "inputs": [],
    "outputs": [
      {
        "name": "",
        "type": "uint256",
        "internalType": "uint256"
      }
    ],
    "stateMutability": "view"
  },
  {
    "type": "function",
    "name": "FRACTION_VAULT_PERCENTAGE",
    "inputs": [],
    "outputs": [
      {
        "name": "",
        "type": "uint8",
        "internalType": "uint8"
      }
    ],
    "stateMutability": "view"
  },
  {
    "type": "function",
    "name": "MAX_CREATOR_REWARD",
    "inputs": [],
    "outputs": [
      {
        "name": "",
        "type": "uint256",
        "internalType": "uint256"
      }
    ],
    "stateMutability": "view"
  },
  {
    "type": "function",
    "name": "MAX_TICK",
    "inputs": [],
    "outputs": [
      {
        "name": "",
        "type": "int24",
        "internalType": "int24"
      }
    ],
    "stateMutability": "view"
  },
  {
    "type": "function",
    "name": "MAX_VAULT_PERCENTAGE",
    "inputs": [],
    "outputs": [
      {
        "name": "",
        "type": "uint256",
        "internalType": "uint256"
      }
    ],
    "stateMutability": "view"
  },
  {
    "type": "function",
    "name": "POOL_FEE",
    "inputs": [],
    "outputs": [
      {
        "name": "",
        "type": "uint24",
        "internalType": "uint24"
      }
    ],
    "stateMutability": "view"
  },
  {
    "type": "function",
    "name": "TICK_SPACING",
    "inputs": [],
    "outputs": [
      {
        "name": "",
        "type": "int24",
        "internalType": "int24"
      }
    ],
    "stateMutability": "view"
  },
  {
    "type": "function",
    "name": "TOKEN_SUPPLY",
    "inputs": [],
    "outputs": [
      {
        "name": "",
        "type": "uint256",
        "internalType": "uint256"
      }
    ],
    "stateMutability": "view"
  },
  {
    "type": "function",
    "name": "admins",
    "inputs": [
      {
        "name": "",
        "type": "address",
        "internalType": "address"
      }
    ],
    "outputs": [
      {
        "name": "",
        "type": "bool",
        "internalType": "bool"
      }
    ],
    "stateMutability": "view"
  },
  {
    "type": "function",
    "name": "buyerRewardRelay",
    "inputs": [],
    "outputs": [
      {
        "name": "",
        "type": "address",
        "internalType": "address"
      }
    ],
    "stateMutability": "view"
  },
  {
    "type": "function",
    "name": "claimRewards",
    "inputs": [
      {
        "name": "token",
        "type": "address",
        "internalType": "address"
      }
    ],
    "outputs": [],
    "stateMutability": "nonpayable"
  },
  {
    "type": "function",
    "name": "deployToken",
    "inputs": [
      {
        "name": "deploymentConfig",
        "type": "tuple",
        "internalType": "struct IHoodMarketsV3.DeploymentConfig",
        "components": [
          {
            "name": "tokenConfig",
            "type": "tuple",
            "internalType": "struct IHoodMarketsV3.TokenConfig",
            "components": [
              {
                "name": "name",
                "type": "string",
                "internalType": "string"
              },
              {
                "name": "symbol",
                "type": "string",
                "internalType": "string"
              },
              {
                "name": "salt",
                "type": "bytes32",
                "internalType": "bytes32"
              },
              {
                "name": "image",
                "type": "string",
                "internalType": "string"
              },
              {
                "name": "metadata",
                "type": "string",
                "internalType": "string"
              },
              {
                "name": "context",
                "type": "string",
                "internalType": "string"
              },
              {
                "name": "originatingChainId",
                "type": "uint256",
                "internalType": "uint256"
              }
            ]
          },
          {
            "name": "vaultConfig",
            "type": "tuple",
            "internalType": "struct IHoodMarketsV3.VaultConfig",
            "components": [
              {
                "name": "vaultPercentage",
                "type": "uint8",
                "internalType": "uint8"
              },
              {
                "name": "vaultDuration",
                "type": "uint256",
                "internalType": "uint256"
              }
            ]
          },
          {
            "name": "poolConfig",
            "type": "tuple",
            "internalType": "struct IHoodMarketsV3.PoolConfig",
            "components": [
              {
                "name": "pairedToken",
                "type": "address",
                "internalType": "address"
              },
              {
                "name": "tickIfToken0IsNewToken",
                "type": "int24",
                "internalType": "int24"
              }
            ]
          },
          {
            "name": "initialBuyConfig",
            "type": "tuple",
            "internalType": "struct IHoodMarketsV3.InitialBuyConfig",
            "components": [
              {
                "name": "pairedTokenPoolFee",
                "type": "uint24",
                "internalType": "uint24"
              },
              {
                "name": "pairedTokenSwapAmountOutMinimum",
                "type": "uint256",
                "internalType": "uint256"
              }
            ]
          },
          {
            "name": "rewardsConfig",
            "type": "tuple",
            "internalType": "struct IHoodMarketsV3.RewardsConfig",
            "components": [
              {
                "name": "creatorReward",
                "type": "uint256",
                "internalType": "uint256"
              },
              {
                "name": "creatorAdmin",
                "type": "address",
                "internalType": "address"
              },
              {
                "name": "creatorRewardRecipient",
                "type": "address",
                "internalType": "address"
              },
              {
                "name": "interfaceAdmin",
                "type": "address",
                "internalType": "address"
              },
              {
                "name": "interfaceRewardRecipient",
                "type": "address",
                "internalType": "address"
              }
            ]
          },
          {
            "name": "fractionConfig",
            "type": "tuple",
            "internalType": "struct IHoodMarketsV3.FractionConfig",
            "components": [
              {
                "name": "buyerRewardShareCount",
                "type": "uint16",
                "internalType": "uint16"
              }
            ]
          }
        ]
      }
    ],
    "outputs": [
      {
        "name": "tokenAddress",
        "type": "address",
        "internalType": "address"
      },
      {
        "name": "positionId",
        "type": "uint256",
        "internalType": "uint256"
      }
    ],
    "stateMutability": "payable"
  },
  {
    "type": "function",
    "name": "deployTokenWithCustomTeamRewardRecipient",
    "inputs": [
      {
        "name": "deploymentConfig",
        "type": "tuple",
        "internalType": "struct IHoodMarketsV3.DeploymentConfig",
        "components": [
          {
            "name": "tokenConfig",
            "type": "tuple",
            "internalType": "struct IHoodMarketsV3.TokenConfig",
            "components": [
              {
                "name": "name",
                "type": "string",
                "internalType": "string"
              },
              {
                "name": "symbol",
                "type": "string",
                "internalType": "string"
              },
              {
                "name": "salt",
                "type": "bytes32",
                "internalType": "bytes32"
              },
              {
                "name": "image",
                "type": "string",
                "internalType": "string"
              },
              {
                "name": "metadata",
                "type": "string",
                "internalType": "string"
              },
              {
                "name": "context",
                "type": "string",
                "internalType": "string"
              },
              {
                "name": "originatingChainId",
                "type": "uint256",
                "internalType": "uint256"
              }
            ]
          },
          {
            "name": "vaultConfig",
            "type": "tuple",
            "internalType": "struct IHoodMarketsV3.VaultConfig",
            "components": [
              {
                "name": "vaultPercentage",
                "type": "uint8",
                "internalType": "uint8"
              },
              {
                "name": "vaultDuration",
                "type": "uint256",
                "internalType": "uint256"
              }
            ]
          },
          {
            "name": "poolConfig",
            "type": "tuple",
            "internalType": "struct IHoodMarketsV3.PoolConfig",
            "components": [
              {
                "name": "pairedToken",
                "type": "address",
                "internalType": "address"
              },
              {
                "name": "tickIfToken0IsNewToken",
                "type": "int24",
                "internalType": "int24"
              }
            ]
          },
          {
            "name": "initialBuyConfig",
            "type": "tuple",
            "internalType": "struct IHoodMarketsV3.InitialBuyConfig",
            "components": [
              {
                "name": "pairedTokenPoolFee",
                "type": "uint24",
                "internalType": "uint24"
              },
              {
                "name": "pairedTokenSwapAmountOutMinimum",
                "type": "uint256",
                "internalType": "uint256"
              }
            ]
          },
          {
            "name": "rewardsConfig",
            "type": "tuple",
            "internalType": "struct IHoodMarketsV3.RewardsConfig",
            "components": [
              {
                "name": "creatorReward",
                "type": "uint256",
                "internalType": "uint256"
              },
              {
                "name": "creatorAdmin",
                "type": "address",
                "internalType": "address"
              },
              {
                "name": "creatorRewardRecipient",
                "type": "address",
                "internalType": "address"
              },
              {
                "name": "interfaceAdmin",
                "type": "address",
                "internalType": "address"
              },
              {
                "name": "interfaceRewardRecipient",
                "type": "address",
                "internalType": "address"
              }
            ]
          },
          {
            "name": "fractionConfig",
            "type": "tuple",
            "internalType": "struct IHoodMarketsV3.FractionConfig",
            "components": [
              {
                "name": "buyerRewardShareCount",
                "type": "uint16",
                "internalType": "uint16"
              }
            ]
          }
        ]
      },
      {
        "name": "teamRewardRecipient",
        "type": "address",
        "internalType": "address"
      }
    ],
    "outputs": [
      {
        "name": "tokenAddress",
        "type": "address",
        "internalType": "address"
      },
      {
        "name": "positionId",
        "type": "uint256",
        "internalType": "uint256"
      }
    ],
    "stateMutability": "payable"
  },
  {
    "type": "function",
    "name": "deployTokenZeroSupply",
    "inputs": [
      {
        "name": "tokenConfig",
        "type": "tuple",
        "internalType": "struct IHoodMarketsV3.TokenConfig",
        "components": [
          {
            "name": "name",
            "type": "string",
            "internalType": "string"
          },
          {
            "name": "symbol",
            "type": "string",
            "internalType": "string"
          },
          {
            "name": "salt",
            "type": "bytes32",
            "internalType": "bytes32"
          },
          {
            "name": "image",
            "type": "string",
            "internalType": "string"
          },
          {
            "name": "metadata",
            "type": "string",
            "internalType": "string"
          },
          {
            "name": "context",
            "type": "string",
            "internalType": "string"
          },
          {
            "name": "originatingChainId",
            "type": "uint256",
            "internalType": "uint256"
          }
        ]
      },
      {
        "name": "tokenAdmin",
        "type": "address",
        "internalType": "address"
      }
    ],
    "outputs": [
      {
        "name": "tokenAddress",
        "type": "address",
        "internalType": "address"
      }
    ],
    "stateMutability": "nonpayable"
  },
  {
    "type": "function",
    "name": "deploymentInfoForToken",
    "inputs": [
      {
        "name": "",
        "type": "address",
        "internalType": "address"
      }
    ],
    "outputs": [
      {
        "name": "token",
        "type": "address",
        "internalType": "address"
      },
      {
        "name": "positionId",
        "type": "uint256",
        "internalType": "uint256"
      },
      {
        "name": "locker",
        "type": "address",
        "internalType": "address"
      },
      {
        "name": "fractionCollection",
        "type": "address",
        "internalType": "address"
      }
    ],
    "stateMutability": "view"
  },
  {
    "type": "function",
    "name": "deprecated",
    "inputs": [],
    "outputs": [
      {
        "name": "",
        "type": "bool",
        "internalType": "bool"
      }
    ],
    "stateMutability": "view"
  },
  {
    "type": "function",
    "name": "fractionCollectionForToken",
    "inputs": [
      {
        "name": "",
        "type": "address",
        "internalType": "address"
      }
    ],
    "outputs": [
      {
        "name": "",
        "type": "address",
        "internalType": "address"
      }
    ],
    "stateMutability": "view"
  },
  {
    "type": "function",
    "name": "fractionDeployer",
    "inputs": [],
    "outputs": [
      {
        "name": "",
        "type": "address",
        "internalType": "contract HoodMarketsV3FractionDeployer"
      }
    ],
    "stateMutability": "view"
  },
  {
    "type": "function",
    "name": "getTokensDeployedByUser",
    "inputs": [
      {
        "name": "user",
        "type": "address",
        "internalType": "address"
      }
    ],
    "outputs": [
      {
        "name": "",
        "type": "tuple[]",
        "internalType": "struct IHoodMarketsV3.DeploymentInfo[]",
        "components": [
          {
            "name": "token",
            "type": "address",
            "internalType": "address"
          },
          {
            "name": "positionId",
            "type": "uint256",
            "internalType": "uint256"
          },
          {
            "name": "locker",
            "type": "address",
            "internalType": "address"
          },
          {
            "name": "fractionCollection",
            "type": "address",
            "internalType": "address"
          }
        ]
      }
    ],
    "stateMutability": "view"
  },
  {
    "type": "function",
    "name": "initialize",
    "inputs": [
      {
        "name": "uniswapV3Factory_",
        "type": "address",
        "internalType": "address"
      },
      {
        "name": "positionManager_",
        "type": "address",
        "internalType": "address"
      },
      {
        "name": "swapRouter_",
        "type": "address",
        "internalType": "address"
      },
      {
        "name": "weth_",
        "type": "address",
        "internalType": "address"
      },
      {
        "name": "liquidityLocker_",
        "type": "address",
        "internalType": "address"
      },
      {
        "name": "vault_",
        "type": "address",
        "internalType": "address"
      },
      {
        "name": "fractionDeployer_",
        "type": "address",
        "internalType": "address"
      }
    ],
    "outputs": [],
    "stateMutability": "nonpayable"
  },
  {
    "type": "function",
    "name": "issueBuyerShare",
    "inputs": [
      {
        "name": "token",
        "type": "address",
        "internalType": "address"
      },
      {
        "name": "buyer",
        "type": "address",
        "internalType": "address"
      }
    ],
    "outputs": [],
    "stateMutability": "nonpayable"
  },
  {
    "type": "function",
    "name": "liquidityLocker",
    "inputs": [],
    "outputs": [
      {
        "name": "",
        "type": "address",
        "internalType": "contract IHoodMarketsV3LpLocker"
      }
    ],
    "stateMutability": "view"
  },
  {
    "type": "function",
    "name": "owner",
    "inputs": [],
    "outputs": [
      {
        "name": "",
        "type": "address",
        "internalType": "address"
      }
    ],
    "stateMutability": "view"
  },
  {
    "type": "function",
    "name": "positionManager",
    "inputs": [],
    "outputs": [
      {
        "name": "",
        "type": "address",
        "internalType": "contract INonfungiblePositionManager"
      }
    ],
    "stateMutability": "view"
  },
  {
    "type": "function",
    "name": "renounceOwnership",
    "inputs": [],
    "outputs": [],
    "stateMutability": "nonpayable"
  },
  {
    "type": "function",
    "name": "setAdmin",
    "inputs": [
      {
        "name": "admin",
        "type": "address",
        "internalType": "address"
      },
      {
        "name": "isAdmin",
        "type": "bool",
        "internalType": "bool"
      }
    ],
    "outputs": [],
    "stateMutability": "nonpayable"
  },
  {
    "type": "function",
    "name": "setBuyerRewardRelay",
    "inputs": [
      {
        "name": "relay",
        "type": "address",
        "internalType": "address"
      }
    ],
    "outputs": [],
    "stateMutability": "nonpayable"
  },
  {
    "type": "function",
    "name": "setDeprecated",
    "inputs": [
      {
        "name": "deprecated_",
        "type": "bool",
        "internalType": "bool"
      }
    ],
    "outputs": [],
    "stateMutability": "nonpayable"
  },
  {
    "type": "function",
    "name": "swapRouter",
    "inputs": [],
    "outputs": [
      {
        "name": "",
        "type": "address",
        "internalType": "contract ISwapRouter"
      }
    ],
    "stateMutability": "view"
  },
  {
    "type": "function",
    "name": "tokensDeployedByUsers",
    "inputs": [
      {
        "name": "",
        "type": "address",
        "internalType": "address"
      },
      {
        "name": "",
        "type": "uint256",
        "internalType": "uint256"
      }
    ],
    "outputs": [
      {
        "name": "token",
        "type": "address",
        "internalType": "address"
      },
      {
        "name": "positionId",
        "type": "uint256",
        "internalType": "uint256"
      },
      {
        "name": "locker",
        "type": "address",
        "internalType": "address"
      },
      {
        "name": "fractionCollection",
        "type": "address",
        "internalType": "address"
      }
    ],
    "stateMutability": "view"
  },
  {
    "type": "function",
    "name": "transferOwnership",
    "inputs": [
      {
        "name": "newOwner",
        "type": "address",
        "internalType": "address"
      }
    ],
    "outputs": [],
    "stateMutability": "nonpayable"
  },
  {
    "type": "function",
    "name": "uniswapV3Factory",
    "inputs": [],
    "outputs": [
      {
        "name": "",
        "type": "address",
        "internalType": "contract IUniswapV3Factory"
      }
    ],
    "stateMutability": "view"
  },
  {
    "type": "function",
    "name": "updateLiquidityLocker",
    "inputs": [
      {
        "name": "newLocker",
        "type": "address",
        "internalType": "address"
      }
    ],
    "outputs": [],
    "stateMutability": "nonpayable"
  },
  {
    "type": "function",
    "name": "updateVault",
    "inputs": [
      {
        "name": "newVault",
        "type": "address",
        "internalType": "address"
      }
    ],
    "outputs": [],
    "stateMutability": "nonpayable"
  },
  {
    "type": "function",
    "name": "vault",
    "inputs": [],
    "outputs": [
      {
        "name": "",
        "type": "address",
        "internalType": "contract IHoodMarketsV3Vault"
      }
    ],
    "stateMutability": "view"
  },
  {
    "type": "function",
    "name": "weth",
    "inputs": [],
    "outputs": [
      {
        "name": "",
        "type": "address",
        "internalType": "address"
      }
    ],
    "stateMutability": "view"
  },
  {
    "type": "event",
    "name": "BuyerRewardRelayUpdated",
    "inputs": [
      {
        "name": "oldRelay",
        "type": "address",
        "indexed": false,
        "internalType": "address"
      },
      {
        "name": "newRelay",
        "type": "address",
        "indexed": false,
        "internalType": "address"
      }
    ],
    "anonymous": false
  },
  {
    "type": "event",
    "name": "BuyerShareIssued",
    "inputs": [
      {
        "name": "token",
        "type": "address",
        "indexed": true,
        "internalType": "address"
      },
      {
        "name": "buyer",
        "type": "address",
        "indexed": true,
        "internalType": "address"
      },
      {
        "name": "fractionCollection",
        "type": "address",
        "indexed": true,
        "internalType": "address"
      }
    ],
    "anonymous": false
  },
  {
    "type": "event",
    "name": "HoodMarketsV3DeployerUpdated",
    "inputs": [
      {
        "name": "oldHoodMarketsV3Deployer",
        "type": "address",
        "indexed": false,
        "internalType": "address"
      },
      {
        "name": "newHoodMarketsV3Deployer",
        "type": "address",
        "indexed": false,
        "internalType": "address"
      }
    ],
    "anonymous": false
  },
  {
    "type": "event",
    "name": "LiquidityLockerUpdated",
    "inputs": [
      {
        "name": "oldLocker",
        "type": "address",
        "indexed": false,
        "internalType": "address"
      },
      {
        "name": "newLocker",
        "type": "address",
        "indexed": false,
        "internalType": "address"
      }
    ],
    "anonymous": false
  },
  {
    "type": "event",
    "name": "OwnershipTransferred",
    "inputs": [
      {
        "name": "previousOwner",
        "type": "address",
        "indexed": true,
        "internalType": "address"
      },
      {
        "name": "newOwner",
        "type": "address",
        "indexed": true,
        "internalType": "address"
      }
    ],
    "anonymous": false
  },
  {
    "type": "event",
    "name": "SetAdmin",
    "inputs": [
      {
        "name": "admin",
        "type": "address",
        "indexed": false,
        "internalType": "address"
      },
      {
        "name": "isAdmin",
        "type": "bool",
        "indexed": false,
        "internalType": "bool"
      }
    ],
    "anonymous": false
  },
  {
    "type": "event",
    "name": "SetDeprecated",
    "inputs": [
      {
        "name": "deprecated",
        "type": "bool",
        "indexed": false,
        "internalType": "bool"
      }
    ],
    "anonymous": false
  },
  {
    "type": "event",
    "name": "TokenCreated",
    "inputs": [
      {
        "name": "tokenAddress",
        "type": "address",
        "indexed": true,
        "internalType": "address"
      },
      {
        "name": "creatorAdmin",
        "type": "address",
        "indexed": true,
        "internalType": "address"
      },
      {
        "name": "interfaceAdmin",
        "type": "address",
        "indexed": true,
        "internalType": "address"
      },
      {
        "name": "creatorRewardRecipient",
        "type": "address",
        "indexed": false,
        "internalType": "address"
      },
      {
        "name": "interfaceRewardRecipient",
        "type": "address",
        "indexed": false,
        "internalType": "address"
      },
      {
        "name": "positionId",
        "type": "uint256",
        "indexed": false,
        "internalType": "uint256"
      },
      {
        "name": "name",
        "type": "string",
        "indexed": false,
        "internalType": "string"
      },
      {
        "name": "symbol",
        "type": "string",
        "indexed": false,
        "internalType": "string"
      },
      {
        "name": "startingTickIfToken0IsNewToken",
        "type": "int24",
        "indexed": false,
        "internalType": "int24"
      },
      {
        "name": "metadata",
        "type": "string",
        "indexed": false,
        "internalType": "string"
      },
      {
        "name": "amountTokensBought",
        "type": "uint256",
        "indexed": false,
        "internalType": "uint256"
      },
      {
        "name": "vaultDuration",
        "type": "uint256",
        "indexed": false,
        "internalType": "uint256"
      },
      {
        "name": "vaultPercentage",
        "type": "uint8",
        "indexed": false,
        "internalType": "uint8"
      },
      {
        "name": "fractionCollection",
        "type": "address",
        "indexed": false,
        "internalType": "address"
      },
      {
        "name": "fractionVaultAmount",
        "type": "uint256",
        "indexed": false,
        "internalType": "uint256"
      },
      {
        "name": "msgSender",
        "type": "address",
        "indexed": false,
        "internalType": "address"
      }
    ],
    "anonymous": false
  },
  {
    "type": "event",
    "name": "VaultUpdated",
    "inputs": [
      {
        "name": "oldVault",
        "type": "address",
        "indexed": false,
        "internalType": "address"
      },
      {
        "name": "newVault",
        "type": "address",
        "indexed": false,
        "internalType": "address"
      }
    ],
    "anonymous": false
  },
  {
    "type": "error",
    "name": "Deprecated",
    "inputs": []
  },
  {
    "type": "error",
    "name": "InvalidBuyerRewardShareCount",
    "inputs": []
  },
  {
    "type": "error",
    "name": "InvalidCreatorInfo",
    "inputs": []
  },
  {
    "type": "error",
    "name": "InvalidCreatorReward",
    "inputs": []
  },
  {
    "type": "error",
    "name": "InvalidInterfaceInfo",
    "inputs": []
  },
  {
    "type": "error",
    "name": "InvalidTick",
    "inputs": []
  },
  {
    "type": "error",
    "name": "InvalidVaultConfiguration",
    "inputs": []
  },
  {
    "type": "error",
    "name": "LegacyVaultDisabled",
    "inputs": []
  },
  {
    "type": "error",
    "name": "NotFound",
    "inputs": []
  },
  {
    "type": "error",
    "name": "OnlyNonOriginatingChains",
    "inputs": []
  },
  {
    "type": "error",
    "name": "OnlyOriginatingChain",
    "inputs": []
  },
  {
    "type": "error",
    "name": "OwnableInvalidOwner",
    "inputs": [
      {
        "name": "owner",
        "type": "address",
        "internalType": "address"
      }
    ]
  },
  {
    "type": "error",
    "name": "OwnableUnauthorizedAccount",
    "inputs": [
      {
        "name": "account",
        "type": "address",
        "internalType": "address"
      }
    ]
  },
  {
    "type": "error",
    "name": "ReentrancyGuardReentrantCall",
    "inputs": []
  },
  {
    "type": "error",
    "name": "Unauthorized",
    "inputs": []
  },
  {
    "type": "error",
    "name": "ZeroTeamRewardRecipient",
    "inputs": []
  }
] as const;
