import { config } from '../config.js';

const IPFS_PATH = /\/ipfs\/([^/?#]+)/i;
const IPFS_PROTO = /^ipfs:\/\/([^/?#]+)/i;
const LIGHTHOUSE_VIEW_FILE = /\/viewFile\/([^/?#]+)/i;
const RAW_CID = /^(bafkrei[a-z0-9]{52,}|Qm[1-9A-HJ-NP-Za-km-z]{44,})$/i;

const PUBLIC_IPFS_GATEWAY = 'https://ipfs.io/ipfs';

function defaultGatewayBase(): string {
  const pinata = config.pinata.gatewayBase.replace(/\/$/, '');
  if (pinata) return pinata;
  const fromEnv = config.lighthouse.ipfsGatewayBase.replace(/\/$/, '');
  if (fromEnv && !fromEnv.includes('gateway.lighthouse.storage')) return fromEnv;
  return PUBLIC_IPFS_GATEWAY;
}

/** Extract a CID from common IPFS / Lighthouse URL shapes. */
export function extractIpfsCid(url: string): string | undefined {
  const t = url.trim();
  const proto = IPFS_PROTO.exec(t);
  if (proto?.[1]) return proto[1];
  const path = IPFS_PATH.exec(t);
  if (path?.[1]) return path[1];
  const view = LIGHTHOUSE_VIEW_FILE.exec(t);
  if (view?.[1]) return view[1];
  if (RAW_CID.test(t)) return t;
  return undefined;
}

/**
 * Rewrite IPFS image URLs to a working public gateway.
 * Fixes legacy `gateway.lighthouse.storage` and `files.lighthouse.storage/viewFile/…` links.
 */
export function resolveTokenImageUrl(
  imageUrl: string | undefined | null,
  gatewayBase?: string,
): string | undefined {
  const raw = imageUrl?.trim();
  if (!raw) return undefined;

  const gateway = (gatewayBase ?? defaultGatewayBase()).replace(/\/$/, '');
  const cid = extractIpfsCid(raw);
  if (cid) return `${gateway}/${cid}`;

  return raw;
}
