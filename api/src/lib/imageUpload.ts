import { writeFile, unlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createClient } from '@supabase/supabase-js';
import lighthouse from '@lighthouse-web3/sdk';
import sharp from 'sharp';
import { config } from '../config.js';
import { logger } from '../logger.js';
import { uploadBufferToPinata } from './pinataUpload.js';

export class ImageUploadService {
  private supabase: ReturnType<typeof createClient> | null;

  constructor() {
    if (config.pinata.jwt) {
      this.supabase = null;
      logger.info('Pinata IPFS image upload enabled (PINATA_JWT set; Supabase not used for images)');
      if (config.lighthouse.apiKey) {
        logger.info('LIGHTHOUSE_API_KEY is set but ignored while PINATA_JWT is configured.');
      }
      if (config.supabase.url && config.supabase.anonKey) {
        logger.info('Supabase env vars are present but ignored for token images while PINATA_JWT is set.');
      }
    } else if (config.lighthouse.apiKey) {
      this.supabase = null;
      logger.info('Lighthouse IPFS image upload enabled (LIGHTHOUSE_API_KEY set; Supabase not used for images)');
      if (config.supabase.url && config.supabase.anonKey) {
        logger.info(
          'Supabase env vars are present but ignored for token images while LIGHTHOUSE_API_KEY is set.',
        );
      }
    } else if (!config.supabase.url || !config.supabase.anonKey) {
      this.supabase = null;
      logger.warn(
        'No Supabase credentials for images — set PINATA_JWT (recommended), LIGHTHOUSE_API_KEY, or SUPABASE_URL + SUPABASE_ANON_KEY.',
      );
    } else {
      this.supabase = createClient(config.supabase.url, config.supabase.anonKey);
    }

    if (!config.pinata.jwt && !config.lighthouse.apiKey && !this.supabase) {
      logger.warn(
        'No image upload backend: set PINATA_JWT, LIGHTHOUSE_API_KEY, and/or Supabase storage env vars (https image URLs in deploys still work).',
      );
    }
    logger.info('Image upload backends', {
      pinata: !!config.pinata.jwt,
      lighthouse: !!config.lighthouse.apiKey,
      supabase: !!this.supabase,
    });
  }

  private async optimizeTokenPngWithName(
    imageData: Buffer | string,
    tokenName: string,
  ): Promise<{ buffer: Buffer; filename: string }> {
    let processedBuffer: Buffer;

    if (typeof imageData === 'string') {
      if (imageData.startsWith('http')) {
        const response = await fetch(imageData);
        if (!response.ok) throw new Error(`Failed to fetch image: ${response.status}`);
        const arrayBuffer = await response.arrayBuffer();
        processedBuffer = Buffer.from(arrayBuffer);
      } else {
        let b64 = imageData;
        const dataUrl = /^data:image\/[a-zA-Z+.-]+;base64,([\s\S]+)$/.exec(imageData);
        if (dataUrl) {
          b64 = dataUrl[1].replace(/\s/g, '');
        }
        processedBuffer = Buffer.from(b64, 'base64');
      }
    } else {
      processedBuffer = imageData;
    }

    const optimizedImage = await sharp(processedBuffer)
      .resize(256, 256, {
        fit: 'cover',
        position: 'center',
      })
      .png({ quality: 90 })
      .toBuffer();

    const timestamp = Date.now();
    const sanitizedName = tokenName.replace(/[^a-z0-9]/gi, '_').toLowerCase();
    const filename = `${sanitizedName}-${timestamp}.png`;
    return { buffer: optimizedImage, filename };
  }

  private async uploadToLighthouse(
    optimizedImage: Buffer,
    tokenName: string,
    filename: string,
  ): Promise<string | undefined> {
    if (!config.lighthouse.apiKey) return undefined;

    const tmpPath = join(tmpdir(), filename);
    await writeFile(tmpPath, optimizedImage);

    let res: { data?: unknown };
    try {
      res = await lighthouse.upload(tmpPath, config.lighthouse.apiKey, { cidVersion: 1 });
    } finally {
      await unlink(tmpPath).catch(() => undefined);
    }

    const d = res?.data as Record<string, unknown> | string | undefined;
    let hash: string | undefined;
    if (d && typeof d === 'object' && !Array.isArray(d)) {
      const h = (d as { Hash?: string; hash?: string }).Hash ?? (d as { hash?: string }).hash;
      hash = typeof h === 'string' ? h : undefined;
    }
    if (!hash && Array.isArray(d) && d[0] && typeof d[0] === 'object') {
      const row = d[0] as { Hash?: string; hash?: string };
      hash = row.Hash ?? row.hash;
    }
    if (!hash) {
      logger.warn('Lighthouse upload: unexpected response shape', {
        token: tokenName,
        data: typeof d === 'string' ? d.slice(0, 200) : d,
      });
      return undefined;
    }

    const publicGateway = config.lighthouse.ipfsGatewayBase;
    const base = publicGateway.replace(/\/$/, '');
    const url = `${base}/${hash}`;
    logger.info('Image uploaded to Lighthouse (IPFS)', { token: tokenName, cid: hash, url });
    return url;
  }

  /**
   * Upload image and return a public HTTPS URL (256×256 PNG).
   * Priority: Pinata → Lighthouse → Supabase.
   */
  async uploadTokenImage(
    imageData: Buffer | string,
    tokenName: string,
  ): Promise<string | undefined> {
    try {
      const { buffer: optimizedImage, filename } = await this.optimizeTokenPngWithName(
        imageData,
        tokenName,
      );

      if (config.pinata.jwt) {
        try {
          const uploaded = await uploadBufferToPinata(optimizedImage, filename, tokenName);
          if (uploaded?.url) return uploaded.url;
          logger.error('Pinata image upload returned no IPFS URL', { token: tokenName });
          return undefined;
        } catch (e: unknown) {
          const msg = e instanceof Error ? e.message : String(e);
          logger.error('Pinata image upload failed', { token: tokenName, error: msg });
          return undefined;
        }
      }

      if (config.lighthouse.apiKey) {
        try {
          const ipfsUrl = await this.uploadToLighthouse(optimizedImage, tokenName, filename);
          if (ipfsUrl) return ipfsUrl;
          logger.error('Lighthouse image upload returned no IPFS URL', { token: tokenName });
          return undefined;
        } catch (e: unknown) {
          const msg = e instanceof Error ? e.message : String(e);
          logger.error('Lighthouse image upload failed', { token: tokenName, error: msg });
          return undefined;
        }
      }

      if (!this.supabase) {
        logger.warn('No image upload backend configured');
        return undefined;
      }

      const { error } = await this.supabase.storage
        .from(config.supabase.bucket)
        .upload(filename, optimizedImage, {
          contentType: 'image/png',
          upsert: false,
        });

      if (error) {
        const base = `Supabase upload failed: ${error.message}`;
        const hint = /fetch failed/i.test(error.message)
          ? ' Outbound HTTPS to Supabase failed (check network / DNS), or set PINATA_JWT for IPFS uploads.'
          : '';
        throw new Error(base + hint);
      }

      const { data: publicData } = this.supabase.storage
        .from(config.supabase.bucket)
        .getPublicUrl(filename);

      logger.info('Image uploaded to Supabase', {
        token: tokenName,
        url: publicData.publicUrl,
      });

      return publicData.publicUrl;
    } catch (error: unknown) {
      const err = error instanceof Error ? error : new Error(String(error));
      const cause = err.cause instanceof Error ? err.cause.message : err.cause;
      logger.error('Image upload failed:', {
        token: tokenName,
        error: err.message,
        ...(cause ? { cause } : {}),
        pinataConfigured: !!config.pinata.jwt,
        lighthouseConfigured: !!config.lighthouse.apiKey,
        supabaseConfigured: !!this.supabase,
      });
      return undefined;
    }
  }

  /** True if Pinata, Lighthouse, or Supabase can accept uploads. */
  isConfigured(): boolean {
    return !!(config.pinata.jwt || config.lighthouse.apiKey || this.supabase);
  }
}

export const imageUploadService = new ImageUploadService();
