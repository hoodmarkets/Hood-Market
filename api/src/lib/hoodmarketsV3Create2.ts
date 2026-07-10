import { randomBytes } from 'node:crypto';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  encodeAbiParameters,
  encodeDeployData,
  getAddress,
  getCreate2Address,
  keccak256,
  toHex,
  type Address,
  type Hex,
} from 'viem';
import { ROBINHOOD_CHAIN_ID } from './robinhoodChain.js';
import type { HoodMarketsV3DeploymentConfig } from './hoodmarketsV3Deploy.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

/** HoodMarkets V3 fixed max supply (100b × 10^18). */
export const HOODMARKETS_V3_TOKEN_SUPPLY = 100_000_000_000_000_000_000_000_000_000n;

type TokenArtifact = {
  abi: readonly unknown[];
  bytecode: { object: string };
};

let cachedArtifact: TokenArtifact | null = null;

function loadTokenArtifact(): TokenArtifact {
  if (cachedArtifact) return cachedArtifact;
  const artifactPath = path.join(__dirname, 'artifacts', 'HoodMarketsV3Token.json');
  cachedArtifact = JSON.parse(readFileSync(artifactPath, 'utf8')) as TokenArtifact;
  return cachedArtifact;
}

/** CREATE2 salt used by HoodMarketsV3Deployer: keccak256(abi.encode(admin, tokenConfig.salt)). */
export function hoodMarketsV3Create2Salt(admin: Address, tokenSalt: Hex): Hex {
  return keccak256(
    encodeAbiParameters(
      [{ type: 'address' }, { type: 'bytes32' }],
      [admin, tokenSalt],
    ),
  );
}

export type HoodMarketsV3TokenDeployParams = {
  factory: Address;
  admin: Address;
  name: string;
  symbol: string;
  image: string;
  metadata: string;
  context: string;
  tokenSalt: Hex;
  originatingChainId?: bigint;
};

export function predictHoodMarketsV3TokenAddress(params: HoodMarketsV3TokenDeployParams): Address {
  const artifact = loadTokenArtifact();
  const chainId = params.originatingChainId ?? BigInt(ROBINHOOD_CHAIN_ID);
  const deployBytecode = encodeDeployData({
    abi: artifact.abi,
    bytecode: artifact.bytecode.object as Hex,
    args: [
      params.name,
      params.symbol,
      HOODMARKETS_V3_TOKEN_SUPPLY,
      params.admin,
      params.image,
      params.metadata,
      params.context,
      chainId,
    ],
  });
  return getCreate2Address({
    from: params.factory,
    salt: hoodMarketsV3Create2Salt(params.admin, params.tokenSalt),
    bytecode: deployBytecode,
  });
}

/** Cached init bytecode for repeated vanity mining on the same launch params. */
export function buildHoodMarketsV3DeployBytecode(params: Omit<HoodMarketsV3TokenDeployParams, 'tokenSalt'>): Hex {
  const artifact = loadTokenArtifact();
  const chainId = params.originatingChainId ?? BigInt(ROBINHOOD_CHAIN_ID);
  return encodeDeployData({
    abi: artifact.abi,
    bytecode: artifact.bytecode.object as Hex,
    args: [
      params.name,
      params.symbol,
      HOODMARKETS_V3_TOKEN_SUPPLY,
      params.admin,
      params.image,
      params.metadata,
      params.context,
      chainId,
    ],
  });
}

export function predictHoodMarketsV3TokenAddressWithBytecode(
  factory: Address,
  admin: Address,
  tokenSalt: Hex,
  deployBytecode: Hex,
): Address {
  return getCreate2Address({
    from: factory,
    salt: hoodMarketsV3Create2Salt(admin, tokenSalt),
    bytecode: deployBytecode,
  });
}

export function predictHoodMarketsV3TokenAddressWithBytecodeHash(
  factory: Address,
  admin: Address,
  tokenSalt: Hex,
  deployBytecodeHash: Hex,
): Address {
  return getCreate2Address({
    from: factory,
    salt: hoodMarketsV3Create2Salt(admin, tokenSalt),
    bytecodeHash: deployBytecodeHash,
  });
}

export function vanityParamsFromDeploymentConfig(
  factory: Address,
  deploymentConfig: HoodMarketsV3DeploymentConfig,
): HoodMarketsV3TokenDeployParams {
  const admin = getAddress(deploymentConfig.rewardsConfig.creatorAdmin);
  return {
    factory,
    admin,
    name: deploymentConfig.tokenConfig.name,
    symbol: deploymentConfig.tokenConfig.symbol,
    image: deploymentConfig.tokenConfig.image,
    metadata: deploymentConfig.tokenConfig.metadata,
    context: deploymentConfig.tokenConfig.context,
    tokenSalt: deploymentConfig.tokenConfig.salt,
    originatingChainId: deploymentConfig.tokenConfig.originatingChainId,
  };
}

export function predictHoodMarketsV3TokenAddressFromConfig(
  factory: Address,
  deploymentConfig: HoodMarketsV3DeploymentConfig,
): Address {
  const params = vanityParamsFromDeploymentConfig(factory, deploymentConfig);
  return predictHoodMarketsV3TokenAddress({ ...params, tokenSalt: deploymentConfig.tokenConfig.salt });
}

/** Hash launch params — banked salts only apply to the same token metadata + admin. */
export function hashVanityLaunchConfig(
  deploymentConfig: HoodMarketsV3DeploymentConfig,
): string {
  const tc = deploymentConfig.tokenConfig;
  const admin = deploymentConfig.rewardsConfig.creatorAdmin.toLowerCase();
  const payload = [
    admin,
    tc.name,
    tc.symbol,
    tc.image,
    tc.metadata,
    tc.context,
    tc.originatingChainId.toString(),
    deploymentConfig.fractionConfig.buyerRewardShareCount.toString(),
    deploymentConfig.rewardsConfig.creatorRewardRecipient.toLowerCase(),
  ].join('\0');
  return createHash('sha256').update(payload).digest('hex');
}

export type FastVanityMineResult = {
  primary: Hex;
  extras: Hex[];
  attempts: number;
};

/**
 * Mine CREATE2 salts locally (no RPC). For a 3-char suffix (~4096 avg attempts) this
 * typically finishes in under a second.
 */
export function mineVanitySaltsLocal(
  predict: (tokenSalt: Hex) => Address,
  suffix: string,
  opts?: { count?: number; maxAttempts?: number },
): FastVanityMineResult {
  const target = suffix.trim().toLowerCase();
  const count = Math.max(1, opts?.count ?? 1);
  const maxAttempts = Math.max(count, opts?.maxAttempts ?? 250_000);
  const found: Hex[] = [];
  let attempts = 0;
  const batchSize = 512;

  while (found.length < count && attempts < maxAttempts) {
    for (let i = 0; i < batchSize && found.length < count && attempts < maxAttempts; i++) {
      const candidate = toHex(randomBytes(32)) as Hex;
      attempts += 1;
      const addr = predict(candidate);
      if (addr.toLowerCase().endsWith(target)) {
        found.push(candidate);
      }
    }
  }

  if (found.length === 0) {
    throw new Error(
      `Vanity salt not found after ${attempts} local attempts (suffix …${target}). ` +
        'Increase VANITY_SALT_MAX_ATTEMPTS or use a shorter suffix.',
    );
  }

  return {
    primary: found[0]!,
    extras: found.slice(1),
    attempts,
  };
}

export function mineVanitySaltsForLaunch(
  params: Omit<HoodMarketsV3TokenDeployParams, 'tokenSalt'>,
  suffix: string,
  opts?: { count?: number; maxAttempts?: number },
): FastVanityMineResult {
  const deployBytecode = buildHoodMarketsV3DeployBytecode(params);
  const deployBytecodeHash = keccak256(deployBytecode);
  return mineVanitySaltsLocal(
    (tokenSalt) =>
      predictHoodMarketsV3TokenAddressWithBytecodeHash(
        params.factory,
        params.admin,
        tokenSalt,
        deployBytecodeHash,
      ),
    suffix,
    opts,
  );
}
