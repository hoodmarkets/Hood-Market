/** Minimal ABI to decode Clanker v4 `TokenCreated` for pool id + token address (matches on-chain layout). */
export const CLANKER_V4_TOKEN_CREATED_ABI = [
  {
    anonymous: false,
    inputs: [
      { indexed: false, internalType: 'address', name: 'msgSender', type: 'address' },
      { indexed: true, internalType: 'address', name: 'tokenAddress', type: 'address' },
      { indexed: true, internalType: 'address', name: 'tokenAdmin', type: 'address' },
      { indexed: false, internalType: 'string', name: 'tokenImage', type: 'string' },
      { indexed: false, internalType: 'string', name: 'tokenName', type: 'string' },
      { indexed: false, internalType: 'string', name: 'tokenSymbol', type: 'string' },
      { indexed: false, internalType: 'string', name: 'tokenMetadata', type: 'string' },
      { indexed: false, internalType: 'string', name: 'tokenContext', type: 'string' },
      { indexed: false, internalType: 'int24', name: 'startingTick', type: 'int24' },
      { indexed: false, internalType: 'address', name: 'poolHook', type: 'address' },
      { indexed: false, internalType: 'bytes32', name: 'poolId', type: 'bytes32' },
      { indexed: false, internalType: 'address', name: 'pairedToken', type: 'address' },
      { indexed: false, internalType: 'address', name: 'locker', type: 'address' },
      { indexed: false, internalType: 'address', name: 'mevModule', type: 'address' },
      { indexed: false, internalType: 'uint256', name: 'extensionsSupply', type: 'uint256' },
      { indexed: false, internalType: 'address[]', name: 'extensions', type: 'address[]' },
    ],
    name: 'TokenCreated',
    type: 'event',
  },
] as const;
