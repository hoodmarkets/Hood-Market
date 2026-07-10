import { normalizeXUsername } from './requesterXUsername.js';

function normalizeAgentXUsername(raw: unknown): string | undefined {
  return normalizeXUsername(raw);
}

/**
 * Optional fields for `feeTarget: agent_wallet` deploys (Bankr, custom agents, etc.).
 * Serialized to JSON in `deployment_catalog.agent_metadata`.
 */

export interface AgentDeployMetadataBody {
  agentProvider?: unknown;
  agentRuntime?: unknown;
  walletKind?: unknown;
  agentId?: unknown;
  /** `signature` (EIP-191), `payment` (treasury ETH), `captcha` (haiku JWT), or `x_confirm` (X in-thread confirm). */
  auth?: unknown;
  /** X @handle of the user who requested the launch (Bankr X agent). */
  xUsername?: unknown;
  /** Original X launch request (status URL). Stored in catalog `source_url` when set. */
  tweetUrl?: unknown;
  tweet_url?: unknown;
  launchTweetUrl?: unknown;
  /** Extra key/value hints; keys [a-zA-Z0-9_-], values trimmed. */
  agentMetadata?: unknown;
}

/** Returns JSON string or undefined if nothing to store (max 1024 chars). */
export function serializeAgentDeployMetadata(body: AgentDeployMetadataBody): string | undefined {
  const out: Record<string, string> = {};

  const set = (key: string, raw: unknown, max: number) => {
    if (typeof raw !== 'string') return;
    const t = raw.trim();
    if (t) out[key] = t.slice(0, max);
  };

  set('agentProvider', body.agentProvider, 64);
  set('agentRuntime', body.agentRuntime, 128);
  set('walletKind', body.walletKind, 64);
  set('agentId', body.agentId, 64);
  set('auth', body.auth, 16);
  set('xUsername', normalizeAgentXUsername(body.xUsername), 16);
  set(
    'launchTweetUrl',
    body.launchTweetUrl ?? body.tweetUrl ?? body.tweet_url,
    512,
  );

  if (body.agentMetadata && typeof body.agentMetadata === 'object' && !Array.isArray(body.agentMetadata)) {
    for (const [k, v] of Object.entries(body.agentMetadata as Record<string, unknown>)) {
      if (!/^[a-zA-Z0-9_-]{1,64}$/.test(k)) continue;
      if (typeof v !== 'string') continue;
      const t = v.trim();
      if (t) out[k] = t.slice(0, 256);
    }
  }

  if (Object.keys(out).length === 0) return undefined;
  let json = JSON.stringify(out);
  if (json.length > 1024) {
    const minimal: Record<string, string> = {};
    if (out.agentProvider) minimal.agentProvider = out.agentProvider;
    if (out.agentRuntime) minimal.agentRuntime = out.agentRuntime;
    if (out.walletKind) minimal.walletKind = out.walletKind;
    if (out.agentId) minimal.agentId = out.agentId;
    json = JSON.stringify(minimal);
  }
  return json.length > 1024 ? json.slice(0, 1024) : json;
}

export function parseAgentMetadataJson(raw: string | null | undefined): Record<string, string> | undefined {
  const s = (raw ?? '').trim();
  if (!s) return undefined;
  try {
    const v = JSON.parse(s) as unknown;
    if (!v || typeof v !== 'object' || Array.isArray(v)) return undefined;
    const o: Record<string, string> = {};
    for (const [k, val] of Object.entries(v as Record<string, unknown>)) {
      if (typeof val === 'string' && val.trim()) o[k] = val.trim();
    }
    return Object.keys(o).length > 0 ? o : undefined;
  } catch {
    return undefined;
  }
}
