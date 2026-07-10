import { createRemoteJWKSet } from 'jose';
import { verifyAccessToken } from '@privy-io/node';
import { config } from '../config.js';
import { logger } from '../logger.js';

/** JWKS for validating Privy-issued access tokens (same app as the web client). */
const jwks = config.privy.appId
  ? createRemoteJWKSet(
      new URL(`https://auth.privy.io/api/v1/apps/${config.privy.appId}/jwks.json`),
    )
  : null;

export async function verifyPrivyBearerToken(authHeader: string | undefined): Promise<{
  userId: string;
}> {
  if (!config.privy.enabled || !jwks) {
    throw new Error('Privy is not configured on the server');
  }
  if (!authHeader?.startsWith('Bearer ')) {
    throw new Error('Missing or invalid Authorization header');
  }
  const access_token = authHeader.slice('Bearer '.length).trim();
  if (!access_token) {
    throw new Error('Empty access token');
  }
  const verified = await verifyAccessToken({
    access_token,
    app_id: config.privy.appId,
    verification_key: jwks,
  });
  return { userId: verified.user_id };
}
