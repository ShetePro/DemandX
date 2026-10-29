/**
 * 64-bit SimHash over a language-agnostic token stream. Chinese has no spaces,
 * so CJK runs are cut into overlapping 2-grams; latin words and numbers are
 * split on non-alphanumerics and lowercased. Punctuation-only input yields no
 * tokens, which keeps the hash stable across formatting noise.
 */

/** Han (incl. ext. A/compat), kana, and hangul: scripts written without spaces. */
const CJK_RANGES: ReadonlyArray<readonly [number, number]> = [
  [0x3040, 0x30ff],
  [0x3400, 0x4dbf],
  [0x4e00, 0x9fff],
  [0xac00, 0xd7af],
  [0xf900, 0xfaff],
];

const CJK_CLASS = CJK_RANGES.map(
  ([start, end]) => `\\u${start.toString(16)}-\\u${end.toString(16)}`,
).join('');
const TOKEN_PATTERN = new RegExp(`[${CJK_CLASS}]+|[A-Za-z0-9]+`, 'g');

const FNV_OFFSET_BASIS = 0xcbf29ce484222325n;
const FNV_PRIME = 0x100000001b3n;
const MASK_64 = 0xffffffffffffffffn;
const BITS = 64;

function cjkTokens(run: string): string[] {
  if (run.length === 1) return [run];
  const tokens: string[] = [];
  for (let index = 0; index + 1 < run.length; index += 1) {
    tokens.push(run.slice(index, index + 2));
  }
  return tokens;
}

/** Splits text into CJK 2-grams, lowercase latin/number words, and nothing else. */
export function tokenize(text: string): string[] {
  const tokens: string[] = [];
  for (const match of text.matchAll(TOKEN_PATTERN)) {
    const chunk = match[0];
    const first = chunk.codePointAt(0) ?? 0;
    if (CJK_RANGES.some(([start, end]) => first >= start && first <= end)) {
      tokens.push(...cjkTokens(chunk));
    } else {
      tokens.push(chunk.toLowerCase());
    }
  }
  return tokens;
}

/** FNV-1a, 64-bit, over the UTF-8 bytes of `input`. */
export function fnv1a64(input: string): bigint {
  let hash = FNV_OFFSET_BASIS;
  for (const byte of Buffer.from(input, 'utf8')) {
    hash ^= BigInt(byte);
    hash = (hash * FNV_PRIME) & MASK_64;
  }
  return hash;
}

function simhashTokens(tokens: readonly string[]): bigint {
  if (tokens.length === 0) return 0n;

  const weights = new Map<string, number>();
  for (const token of tokens) weights.set(token, (weights.get(token) ?? 0) + 1);

  const votes = new Array<number>(BITS).fill(0);
  for (const [token, weight] of weights) {
    const hash = fnv1a64(token);
    for (let bit = 0; bit < BITS; bit += 1) {
      const isSet = ((hash >> BigInt(bit)) & 1n) === 1n;
      votes[bit] = (votes[bit] ?? 0) + (isSet ? weight : -weight);
    }
  }

  let fingerprint = 0n;
  for (let bit = 0; bit < BITS; bit += 1) {
    if ((votes[bit] ?? 0) > 0) fingerprint |= 1n << BigInt(bit);
  }
  return fingerprint;
}

/** 64-bit SimHash of the text; `0n` when there are no tokens. */
export function simhash64(text: string): bigint {
  return simhashTokens(tokenize(text));
}

/** Number of differing bits, always within 0–64. */
export function hammingDistance(a: bigint, b: bigint): number {
  let diff = (a ^ b) & MASK_64;
  let distance = 0;
  while (diff !== 0n) {
    distance += Number(diff & 1n);
    diff >>= 1n;
  }
  return distance;
}

/**
 * Near-duplicate check. Very short texts carry too little signal for SimHash
 * (a handful of tokens can produce wildly different fingerprints for the same
 * meaning), so they fall back to exact string equality.
 */
export function isNearDuplicate(a: string, b: string, threshold = 3): boolean {
  const tokensA = tokenize(a);
  const tokensB = tokenize(b);
  if (tokensA.length < 5 || tokensB.length < 5) return a === b;
  return hammingDistance(simhashTokens(tokensA), simhashTokens(tokensB)) <= threshold;
}
