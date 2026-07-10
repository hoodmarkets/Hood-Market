import { resolveAgentDeployImageUrlAsync } from './agentDeployImage.js';
import type { PetitionRow } from './petitionDb.js';
import { updatePetitionImageUrl } from './petitionDb.js';
import { normalizeLaunchImageInput, resolveLaunchImageForStorage } from './webDeployArtifacts.js';

/** Resolve logo for create: explicit URL/data, else first image from tweetUrl. */
export async function resolvePetitionLogoForCreate(opts: {
  imageUrl?: unknown;
  tweetUrl?: unknown;
  tokenName: string;
}): Promise<string> {
  const explicit = normalizeLaunchImageInput(opts.imageUrl);
  let source = explicit;
  if (!source && opts.tweetUrl) {
    const fromTweet = await resolveAgentDeployImageUrlAsync({
      imageUrl: explicit,
      tweetUrl: opts.tweetUrl,
    });
    source = fromTweet.imageUrl;
  }
  if (!source) return '';
  return resolveLaunchImageForStorage(source, opts.tokenName);
}

/** Fill missing petition logos from tweetUrl (lazy backfill + persist). */
export async function enrichPetitionImage(petition: PetitionRow): Promise<PetitionRow> {
  if (petition.image_url?.trim()) return petition;
  const tweetUrl = petition.tweet_url?.trim();
  if (!tweetUrl) return petition;

  try {
    const resolved = await resolvePetitionLogoForCreate({
      tweetUrl,
      tokenName: petition.token_name,
    });
    if (!resolved) return petition;
    await updatePetitionImageUrl(petition.id, resolved);
    return { ...petition, image_url: resolved };
  } catch {
    return petition;
  }
}
