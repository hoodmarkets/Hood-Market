import { config } from '../config.js';
import { imageUploadService } from './imageUpload.js';
import { resolveTokenImageUrl } from './tokenImageUrl.js';

export type WebDeployArtifactsInput = {
  name: string;
  symbol: string;
  description?: string;
  imageUrl?: string;
  websiteUrl?: string;
  xUrl?: string;
  platform?: string;
  clientKind?: 'web' | 'agent';
};

export type WebDeployArtifacts = {
  image: string;
  metadata: string;
  context: string;
};

/** HTTP(S) image URL or data:image/*;base64 (for client uploads; max ~2MB). */
export function normalizeLaunchImageInput(raw: unknown): string | undefined {
  if (typeof raw !== 'string') return undefined;
  const t = raw.trim();
  if (!t) return undefined;
  if (t.startsWith('https://') || t.startsWith('http://')) return t;
  if (t.startsWith('data:image/') && t.includes(';base64,')) {
    const maxChars = 2_800_000;
    if (t.length > maxChars) return undefined;
    return t;
  }
  return undefined;
}

/** Upload or normalize a launch logo for DB/catalog storage (HTTPS/IPFS URL). */
export async function resolveLaunchImageForStorage(
  raw: unknown,
  tokenName: string,
): Promise<string> {
  const image = normalizeLaunchImageInput(raw);
  if (!image) return '';

  if (imageUploadService.isConfigured()) {
    const lower = image.trim().toLowerCase();
    const alreadyHosted =
      image.startsWith('http') &&
      !image.startsWith('data:') &&
      (lower.includes('ipfs') || lower.includes('pinata'));
    if (!alreadyHosted) {
      const uploadedUrl = await imageUploadService.uploadTokenImage(image, tokenName);
      if (uploadedUrl) return uploadedUrl.slice(0, 1024);
    }
  }

  if (image.startsWith('data:')) {
    throw new Error(
      'Token image could not be stored. Use a public HTTPS image URL, or set PINATA_JWT on the server for logo uploads.',
    );
  }

  return (resolveTokenImageUrl(image) ?? image).slice(0, 1024);
}

function liquidDeployContextInterface(
  params: Pick<WebDeployArtifactsInput, 'platform' | 'clientKind'>,
): string {
  if (params.platform === 'web' && params.clientKind === 'agent') {
    return 'agent';
  }
  const p = params.platform?.trim().toLowerCase();
  if (!p) return config.liquidDeployContextInterfaceFallback;
  switch (p) {
    case 'x':
    case 'telegram':
    case 'discord':
    case 'farcaster':
    case 'web':
      return p;
    default:
      return config.liquidDeployContextInterfaceFallback;
  }
}

/** Resolve logo URL, build on-chain metadata + context JSON (shared by server and wallet deploy). */
export async function buildWebDeployArtifacts(
  params: WebDeployArtifactsInput,
): Promise<WebDeployArtifacts> {
  const image = params.imageUrl
    ? await resolveLaunchImageForStorage(params.imageUrl, params.name)
    : '';

  const metadataPayload: Record<string, string | number> = {
    name: params.name,
    symbol: params.symbol,
  };
  if (params.description?.trim()) {
    metadataPayload.description = params.description.trim();
  }
  if (image) {
    metadataPayload.image = image;
  }
  if (params.websiteUrl?.trim()) {
    metadataPayload.external_url = params.websiteUrl.trim();
  }
  if (params.xUrl?.trim()) {
    metadataPayload.twitter = params.xUrl.trim();
  }
  if (config.platformFeeBps > 0) {
    metadataPayload.platformFeeBps = config.platformFeeBps;
    metadataPayload.platformFeePercent = Number((config.platformFeeBps / 100).toFixed(2));
  }

  const contextPayload: Record<string, string | number> = {
    interface: liquidDeployContextInterface(params),
    platform: config.liquidDeployContextPlatform,
  };
  if (config.platformFeeBps > 0) {
    contextPayload.platformFeeBps = config.platformFeeBps;
  }
  if (config.platformFeeRecipient) {
    contextPayload.platformFeeRecipient = config.platformFeeRecipient;
  }

  return {
    image,
    metadata: JSON.stringify(metadataPayload),
    context: JSON.stringify(contextPayload),
  };
}
