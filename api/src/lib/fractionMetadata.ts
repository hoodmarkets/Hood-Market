import { createPublicClient, getAddress, http, zeroAddress, type Address } from 'viem';
import { getDeploymentByTokenAddress } from './deploymentCatalog.js';
import { HOODMARKETS_V3_FRACTION_ABI } from './hoodmarketsV3FractionAbi.js';
import { config } from '../config.js';
import { robinhood } from './robinhoodChain.js';
import { resolveTokenImageUrl } from './tokenImageUrl.js';

const LAUNCH_TOKEN_ABI = [
  { type: 'function', name: 'name', stateMutability: 'view', inputs: [], outputs: [{ type: 'string' }] },
  { type: 'function', name: 'symbol', stateMutability: 'view', inputs: [], outputs: [{ type: 'string' }] },
  { type: 'function', name: 'imageUrl', stateMutability: 'view', inputs: [], outputs: [{ type: 'string' }] },
] as const;

function publicClient() {
  return createPublicClient({
    chain: robinhood,
    transport: http(config.chainRpcUrl),
  });
}

async function resolveLaunchToken(raw: string): Promise<Address | null> {
  const addr = getAddress(raw.trim());
  const client = publicClient();
  try {
    const launchToken = await client.readContract({
      address: addr,
      abi: HOODMARKETS_V3_FRACTION_ABI,
      functionName: 'launchToken',
    });
    if (launchToken && launchToken !== zeroAddress) {
      return getAddress(launchToken as Address);
    }
  } catch {
    /* not a fraction collection — treat as launch token */
  }
  return addr;
}

async function readLaunchTokenFields(token: Address): Promise<{
  name: string;
  symbol: string;
  image?: string;
}> {
  const catalog = await getDeploymentByTokenAddress(token);
  if (catalog?.tokenName && catalog?.tokenSymbol) {
    const image = resolveTokenImageUrl(catalog.tokenImageUrl);
    return {
      name: catalog.tokenName,
      symbol: catalog.tokenSymbol.replace(/^\$/, ''),
      ...(image ? { image } : {}),
    };
  }

  const client = publicClient();
  try {
    const [name, symbol, imageRaw] = await Promise.all([
      client.readContract({ address: token, abi: LAUNCH_TOKEN_ABI, functionName: 'name' }),
      client.readContract({ address: token, abi: LAUNCH_TOKEN_ABI, functionName: 'symbol' }),
      client.readContract({ address: token, abi: LAUNCH_TOKEN_ABI, functionName: 'imageUrl' }),
    ]);
    const image = resolveTokenImageUrl(String(imageRaw));
    return {
      name: String(name),
      symbol: String(symbol).replace(/^\$/, ''),
      ...(image ? { image } : {}),
    };
  } catch {
    return { name: 'Token', symbol: 'TOKEN' };
  }
}

export type FractionMetadataJson = {
  name: string;
  description: string;
  image?: string;
  external_url: string;
};

export async function buildFractionMetadataJson(
  addressRaw: string,
  opts?: { legacyGeneric?: boolean },
): Promise<FractionMetadataJson> {
  if (opts?.legacyGeneric) {
    return {
      name: 'hood.markets Holder Share',
      description:
        'ERC-1155 vault share for a hood.markets launch. Open the parent token on hood.markets for details.',
      external_url: 'https://hood.markets',
    };
  }

  const launchToken = await resolveLaunchToken(addressRaw);
  if (!launchToken) {
    return {
      name: 'hood.markets Holder Share',
      description: 'Fractional vault share (ERC-1155 id #0).',
      external_url: 'https://hood.markets',
    };
  }

  const { name, symbol, image } = await readLaunchTokenFields(launchToken);
  const sym = symbol.startsWith('$') ? symbol : `$${symbol}`;

  return {
    name: `${name} Holder Share`,
    description: `1 of 1,000 vaulted shares for ${sym} on hood.markets. Holders earn a pro-rata slice of trading fees and may redeem for underlying tokens.`,
    ...(image ? { image } : {}),
    external_url: `https://hood.markets/?token=${launchToken}`,
  };
}
