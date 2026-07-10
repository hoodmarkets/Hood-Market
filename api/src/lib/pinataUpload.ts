import { config } from '../config.js';
import { logger } from '../logger.js';

export interface PinataUploadResult {
  cid: string;
  url: string;
}

/** Upload a PNG buffer to Pinata public IPFS (v3 API). */
export async function uploadBufferToPinata(
  buffer: Buffer,
  filename: string,
  tokenName: string,
): Promise<PinataUploadResult | undefined> {
  const jwt = config.pinata.jwt;
  if (!jwt) return undefined;

  const formData = new FormData();
  formData.append('file', new Blob([new Uint8Array(buffer)], { type: 'image/png' }), filename);
  formData.append('network', 'public');
  formData.append('name', filename);

  const res = await fetch('https://uploads.pinata.cloud/v3/files', {
    method: 'POST',
    headers: { Authorization: `Bearer ${jwt}` },
    body: formData,
  });

  if (!res.ok) {
    const body = await res.text();
    throw new Error(`Pinata upload failed (${res.status}): ${body.slice(0, 400)}`);
  }

  const json = (await res.json()) as { data?: { cid?: string } };
  const cid = json.data?.cid?.trim();
  if (!cid) {
    logger.warn('Pinata upload: missing cid in response', { token: tokenName, json });
    return undefined;
  }

  const base = config.pinata.gatewayBase.replace(/\/$/, '');
  const url = `${base}/${cid}`;
  logger.info('Image uploaded to Pinata (IPFS)', { token: tokenName, cid, url });
  return { cid, url };
}
