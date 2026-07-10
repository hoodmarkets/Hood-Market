import { config } from '../config.js';

/** Active deployment chain — Robinhood only. Legacy values kept for catalog rows. */
export type DeployChain = 'robinhood' | 'base' | 'ethereum';

export function normalizeDeployChainInput(_raw: unknown): DeployChain {
  return 'robinhood';
}

export function inferDeployChainFromText(_text: string | undefined): DeployChain | null {
  return null;
}

export function inferExplicitDeployChainFromText(
  _text: string | undefined,
): DeployChain | null {
  return null;
}

/** Resolve chain: Robinhood only. */
export function resolveDeployChain(_opts?: {
  explicit?: unknown;
  messageText?: string;
}): DeployChain {
  return config.deployDefaultChain;
}

export function assertEthereumDeployConfigured(): void {
  throw new Error(
    'Ethereum deployments are disabled — this launcher runs on Robinhood Chain (4663) only.',
  );
}

export function deployChainLabel(chain: DeployChain): string {
  if (chain === 'ethereum') return 'Ethereum';
  if (chain === 'base') return 'Base';
  return 'Robinhood';
}
