import { hammingDistance, simhash64, tokenize } from '@/lib/evidence/simhash';

/**
 * Two ideas within this many bits of each other describe the same demand.
 * Tuned against `simhash64(title + problem)`: paraphrases reshape a handful of
 * bits, while a genuinely different workflow moves well over ten.
 */
export const DUPLICATE_DISTANCE = 8;

/** Stable fingerprint of a direction; stored as text because JSON has no BigInt. */
export function opportunityFingerprint(title: string, problem: string): bigint {
  return simhash64(`${title.trim()}\n${problem.trim()}`);
}

export function fingerprintToText(fingerprint: bigint): string {
  return fingerprint.toString();
}

export function fingerprintFromText(value: string): bigint | null {
  try {
    return BigInt(value);
  } catch {
    return null;
  }
}

/**
 * True when the direction is not a paraphrase of a recent one. Unreadable
 * stored fingerprints are ignored rather than treated as duplicates: losing a
 * memory row must not block the whole radar.
 */
export function isNovelFingerprint(
  fingerprint: bigint,
  prior: readonly string[],
  maxDistance = DUPLICATE_DISTANCE,
): boolean {
  return prior.every((stored) => {
    const parsed = fingerprintFromText(stored);
    return parsed === null || hammingDistance(fingerprint, parsed) > maxDistance;
  });
}


/**
 * Word/bigram set of a direction. SimHash is good at paraphrases with the same
 * shape, but two ideas built on the same workflow words ("客服", "排班") can
 * still hash far apart; the token set catches that overlap directly.
 */
export function ideaTokens(title: string, problem: string): Set<string> {
  return new Set(tokenize(`${title}\n${problem}`));
}

/** Shared tokens over the smaller set: a short idea inside a long one still counts. */
export function ideaOverlap(left: ReadonlySet<string>, right: ReadonlySet<string>): number {
  if (left.size === 0 || right.size === 0) return 0;
  let shared = 0;
  for (const token of left) {
    if (right.has(token)) shared += 1;
  }
  return shared / Math.min(left.size, right.size);
}

/** Above this share of shared tokens, two directions are the same lead. */
export const IDEA_REPEAT_THRESHOLD = 0.5;

export function isRepeatedIdea(
  tokens: ReadonlySet<string>,
  prior: readonly ReadonlySet<string>[],
  threshold = IDEA_REPEAT_THRESHOLD,
): boolean {
  return prior.some((other) => ideaOverlap(tokens, other) >= threshold);
}
