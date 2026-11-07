import { hammingDistance, simhash64 } from '@/lib/evidence/simhash';

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
