import { config } from '../config.js';
import type { DeploymentCatalogRow } from './deploymentCatalog.js';
import { isV3CatalogDeployment } from './hoodmarketsV3Fees.js';

/** Production HoodMarkets V3 factories on Robinhood — keep in sync with web `launchType.ts`. */
const HOODMARKETS_V3_FACTORIES = new Set(
  [
    '0x9BDdC8ddf28f5629C989A36Eb5bb6C73cBA60Df5',
    '0xf65536Eb3354Ad7e77E1b0d0F7bEBFa1C88885C9',
    '0x3a94FD3422F50ed6cC08e547c6C697E4bb3e76c8',
    '0xC2A604fF131dDE9201838007A129ea28b85d00e8',
    '0x45A3820A9A563e78A4cF7F355F7Be10fA6B706B3',
    '0x7E2905ddF3Dca96117A9e9d50F2924C1E7FE7Be1',
    '0x4c18e43F8B8b63f42a944b98b8af29f576c7Ffa8',
    config.hoodmarketsV3.factory,
  ]
    .map((a) => a?.trim().toLowerCase())
    .filter(Boolean),
);

export type DeploymentFactoryInfo = {
  /** Stable slug for bots — e.g. `hoodmarkets`. */
  name: string;
  /** Display label — e.g. `hood.markets`. */
  label: string;
  address?: string;
  launchType: 'simple' | 'pro';
  /** Protocol generation when known. */
  variant?: 'v3' | 'v4';
};

function isHoodMarketsV3Factory(address: string | undefined): boolean {
  const key = address?.trim().toLowerCase();
  if (!key) return false;
  return HOODMARKETS_V3_FACTORIES.has(key);
}

export function resolveDeploymentFactoryInfo(
  row: Pick<DeploymentCatalogRow, 'poolId' | 'factoryAddress'>,
): DeploymentFactoryInfo {
  const address = row.factoryAddress?.trim() || undefined;
  const simple = isV3CatalogDeployment(row);

  if (simple || isHoodMarketsV3Factory(address)) {
    return {
      name: 'hoodmarkets',
      label: 'hood.markets',
      address,
      launchType: 'simple',
      variant: 'v3',
    };
  }

  return {
    name: 'hoodmarkets',
    label: 'hood.markets',
    address,
    launchType: 'pro',
    variant: 'v4',
  };
}
