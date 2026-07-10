import { encodeAbiParameters, getAddress, zeroAddress, type Address, type Hex } from 'viem';
import { config } from '../config.js';

/**
 * Univ4EthDevBuy extension — same encoding as `liquid-sdk` `LiquidSDK.buildDevBuyExtension`.
 * Swaps `ethAmount` of ETH for tokens in the new pool; purchased tokens go to `recipient`.
 */
export function buildLiquidDevBuyExtension(
  ethAmount: bigint,
  recipient: Address
): {
  extension: Address;
  msgValue: bigint;
  extensionBps: number;
  extensionData: Hex;
} {
  const extension = getAddress(config.liquid.univ4EthDevBuy);
  if (!extension || extension === zeroAddress) {
    throw new Error(
      'LIQUID_UNIV4_ETH_DEV_BUY is not set — deploy Liquid Protocol on Robinhood first.',
    );
  }
  const extensionData = encodeAbiParameters(
    [
      {
        type: 'tuple',
        components: [
          {
            type: 'tuple',
            name: 'pairedTokenPoolKey',
            components: [
              { type: 'address', name: 'currency0' },
              { type: 'address', name: 'currency1' },
              { type: 'uint24', name: 'fee' },
              { type: 'int24', name: 'tickSpacing' },
              { type: 'address', name: 'hooks' },
            ],
          },
          { type: 'uint128', name: 'pairedTokenAmountOutMinimum' },
          { type: 'address', name: 'recipient' },
        ],
      },
    ],
    [
      {
        pairedTokenPoolKey: {
          currency0: zeroAddress,
          currency1: zeroAddress,
          fee: 0,
          tickSpacing: 0,
          hooks: zeroAddress,
        },
        pairedTokenAmountOutMinimum: 0n,
        recipient,
      },
    ]
  );

  return {
    extension,
    msgValue: ethAmount,
    extensionBps: 0,
    extensionData,
  };
}
