/**
 * LiquidToken.sol — token admin can update image + metadata strings on-chain.
 * @see https://github.com/Liquid-Protocol-Ops/liquid-protocol-v0/blob/main/src/LiquidToken.sol
 */
export const LIQUID_TOKEN_ABI = [
  {
    type: 'function',
    name: 'admin',
    inputs: [],
    outputs: [{ name: '', type: 'address' }],
    stateMutability: 'view',
  },
  {
    type: 'function',
    name: 'imageUrl',
    inputs: [],
    outputs: [{ name: '', type: 'string' }],
    stateMutability: 'view',
  },
  {
    type: 'function',
    name: 'metadata',
    inputs: [],
    outputs: [{ name: '', type: 'string' }],
    stateMutability: 'view',
  },
  {
    type: 'function',
    name: 'updateImage',
    inputs: [{ name: 'image_', type: 'string' }],
    outputs: [],
    stateMutability: 'nonpayable',
  },
  {
    type: 'function',
    name: 'updateMetadata',
    inputs: [{ name: 'metadata_', type: 'string' }],
    outputs: [],
    stateMutability: 'nonpayable',
  },
] as const;
