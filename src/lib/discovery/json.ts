/**
 * Providers occasionally ignore `response_format`, wrap JSON in a fence, or
 * emit reasoning tags. Extract the object instead of discarding a correct
 * answer because of its envelope.
 */
export function parseJsonObject(text: string): unknown | null {
  let clean = text.trim();
  clean = clean.replace(/<think[^>]*>[\s\S]*?<\/think>/gi, '').trim();
  clean = clean.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '').trim();
  const first = clean.indexOf('{');
  const last = clean.lastIndexOf('}');
  if (first >= 0 && last > first) clean = clean.slice(first, last + 1);
  try {
    return JSON.parse(clean) as unknown;
  } catch {
    return null;
  }
}
