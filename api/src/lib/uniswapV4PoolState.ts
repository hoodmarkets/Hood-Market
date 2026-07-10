/**
 * Uniswap v4 pool state via Base PoolManager `extsload` (same layout as Uniswap StateLibrary).
 * No paid indexer — uses `config.baseRpcUrl` only.
 *
 * @see https://github.com/Uniswap/v4-core/blob/main/src/libraries/StateLibrary.sol
 */
import { createPublicClient, http, keccak256, encodePacked, type Hex } from 'viem';
import { base } from 'viem/chains';
import { config } from '../config.js';

/** Canonical Uniswap v4 PoolManager on Base mainnet */
export const UNISWAP_V4_POOL_MANAGER_BASE = '0x498581fF718922c3f8e6A244956aF099B2652b2b' as const;

/** `bytes32(uint256(6))` — index of `pools` mapping in PoolManager */
const POOLS_SLOT =
  '0x0000000000000000000000000000000000000000000000000000000000000006' as const;
export const LIQUIDITY_WORD_OFFSET = 3n;

const poolManagerExtsloadAbi = [
  {
    name: 'extsload',
    type: 'function',
    stateMutability: 'view',
    inputs: [{ name: 'slot', type: 'bytes32' }],
    outputs: [{ name: 'value', type: 'bytes32' }],
  },
] as const;

function getPublicClient() {
  return createPublicClient({
    chain: base,
    transport: http(config.baseRpcUrl),
  });
}

export function isValidV4PoolId(hex: string): hex is `0x${string}` {
  return /^0x[a-fA-F0-9]{64}$/.test(hex);
}

/** pools[poolId] storage slot (StateLibrary._getPoolStateSlot) */
export function getPoolStateSlot(poolId: Hex): Hex {
  return keccak256(encodePacked(['bytes32', 'bytes32'], [poolId, POOLS_SLOT]));
}

export function addSlotOffset(stateSlot: Hex, offset: bigint): Hex {
  const n = BigInt(stateSlot) + offset;
  return `0x${n.toString(16).padStart(64, '0')}` as Hex;
}

/** Decode Pool.State.slot0 word (StateLibrary.getSlot0) */
export function decodeSlot0Word(data: Hex): {
  sqrtPriceX96: bigint;
  tick: number;
  protocolFee: number;
  lpFee: number;
} {
  const b = BigInt(data);
  const sqrtPriceX96 = b & ((1n << 160n) - 1n);
  const tickU = Number((b >> 160n) & 0xffffffn);
  const tick = tickU >= 0x800000 ? tickU - 0x1000000 : tickU;
  const protocolFee = Number((b >> 184n) & 0xffffffn);
  const lpFee = Number((b >> 208n) & 0xffffffn);
  return { sqrtPriceX96, tick, protocolFee, lpFee };
}

const Q96 = 1n << 96n;

/**
 * Rough constant-product style impact on **virtual** reserves implied by (L, sqrtP).
 * Not a full v4 swap simulation (no tick traversal). Good for order-of-magnitude only.
 */
export function roughPriceImpactBpsForPctOfVirtualX(
  liquidity: bigint,
  sqrtPriceX96: bigint,
  tradePctOfVirtualX: number,
): bigint {
  if (liquidity <= 0n || sqrtPriceX96 <= 0n || tradePctOfVirtualX <= 0) return 0n;
  const virtX = (liquidity * Q96) / sqrtPriceX96;
  if (virtX <= 0n) return 0n;
  const dx = (virtX * BigInt(tradePctOfVirtualX)) / 100n;
  if (dx <= 0n) return 0n;
  return (dx * 10000n) / (virtX + dx);
}

export type V4PoolReadResult = {
  poolId: Hex;
  sqrtPriceX96: string;
  tick: number;
  protocolFee: number;
  lpFee: number;
  /** Active liquidity at current tick (uint128) */
  liquidity: string;
  /** tickSpacing is not stored in Pool.State — only in PoolKey / Initialize event */
  tickSpacingNote: string;
  /** CP-style rough impact (bps) for trades of 1–5% of virtual token0 depth */
  roughImpactBps1to5PctVirtualX: Array<{ tradePct: number; estImpactBps: string }>;
  notes: string[];
};

/**
 * Read slot0 + liquidity for a v4 pool id (bytes32) from PoolManager via `extsload`.
 * Uniswap v4 does **not** use a per-pool contract address — pass the **poolId** (e.g. from Liquid deploy).
 */
export async function readV4PoolState(poolIdInput: string): Promise<V4PoolReadResult | { error: string }> {
  const trimmed = poolIdInput.trim();
  if (!isValidV4PoolId(trimmed)) {
    return {
      error:
        'Invalid poolId. Uniswap v4 pools are identified by a bytes32 pool id (0x + 64 hex), not a 20-byte pool contract address. Use the poolId from a Liquid deployment or on-chain Initialize logs.',
    };
  }
  const poolId = trimmed as Hex;
  const client = getPublicClient();
  const stateSlot = getPoolStateSlot(poolId);

  try {
    const slot0Word = (await client.readContract({
      address: UNISWAP_V4_POOL_MANAGER_BASE,
      abi: poolManagerExtsloadAbi,
      functionName: 'extsload',
      args: [stateSlot],
    })) as Hex;

    const { sqrtPriceX96, tick, protocolFee, lpFee } = decodeSlot0Word(slot0Word);

    const liqSlot = addSlotOffset(stateSlot, LIQUIDITY_WORD_OFFSET);
    const liqWord = (await client.readContract({
      address: UNISWAP_V4_POOL_MANAGER_BASE,
      abi: poolManagerExtsloadAbi,
      functionName: 'extsload',
      args: [liqSlot],
    })) as Hex;
    const liquidity = BigInt(liqWord) & ((1n << 128n) - 1n);

    const roughImpactBps1to5PctVirtualX = [1, 2, 3, 4, 5].map((tradePct) => {
      const bps = roughPriceImpactBpsForPctOfVirtualX(liquidity, sqrtPriceX96, tradePct);
      return { tradePct, estImpactBps: bps.toString() };
    });

    const notes = [
      'Virtual-reserve impact is a constant-product approximation at the current sqrt price; v4 concentrated liquidity can differ materially from this, especially far from mid.',
      'tickSpacing lives in the pool key (Initialize event), not in Pool.State — Liquid defaults often use 200; verify from deployment if needed.',
    ];

    return {
      poolId,
      sqrtPriceX96: sqrtPriceX96.toString(),
      tick,
      protocolFee,
      lpFee,
      liquidity: liquidity.toString(),
      tickSpacingNote:
        'Not read from chain in this call — obtain from PoolKey / Initialize(poolId, …, tickSpacing, …) or deployment metadata.',
      roughImpactBps1to5PctVirtualX,
      notes,
    };
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : String(e);
    return { error: `PoolManager read failed: ${msg}` };
  }
}

export function formatV4PoolReadForAgent(r: V4PoolReadResult): string {
  const lines = [
    `Uniswap v4 pool (Base) poolId=${r.poolId}`,
    `sqrtPriceX96=${r.sqrtPriceX96}`,
    `tick=${r.tick}`,
    `protocolFee=${r.protocolFee} lpFee=${r.lpFee} (fee fields as returned by slot0; lp fee may include dynamic fee encoding per pool)`,
    `liquidity(active)=${r.liquidity}`,
    '',
    'Rough price impact (bps), trade size = % of virtual token0 depth at current price (CP approx; not exact swap simulation):',
    ...r.roughImpactBps1to5PctVirtualX.map(
      (x) => `  • ${x.tradePct}% of virtual token0 depth → ~${x.estImpactBps} bps (~${(Number(x.estImpactBps) / 100).toFixed(2)}%)`,
    ),
    '',
    ...r.notes.map((n) => `Note: ${n}`),
    r.tickSpacingNote,
  ];
  return lines.join('\n');
}
