/**
 * Anti-automation hygiene for logged-in social crawls. This does not try to
 * defeat a captcha or a login wall — those stay `needs_human`. It only keeps a
 * real Chrome profile from looking like a bare automation client: no
 * `navigator.webdriver`, a realistic locale/timezone, and a few seconds of
 * human-like scrolling before the DOM is read.
 */

/** Runs before every page script; values match a normal zh-CN Chrome profile. */
export const STEALTH_INIT_SCRIPT = `(() => {
  try {
    Object.defineProperty(navigator, 'webdriver', { get: () => undefined });
    Object.defineProperty(navigator, 'languages', { get: () => ['zh-CN', 'zh', 'en'] });
    Object.defineProperty(navigator, 'plugins', { get: () => [1, 2, 3, 4, 5] });
    if (!window.chrome) window.chrome = { runtime: {} };
    const query = navigator.permissions && navigator.permissions.query;
    if (typeof query === 'function') {
      navigator.permissions.query = (params) =>
        params && params.name === 'notifications'
          ? Promise.resolve({ state: Notification.permission })
          : query.call(navigator.permissions, params);
    }
  } catch {
    // A locked-down property is fine; never break the page over stealth.
  }
})();`;

export interface StealthContext {
  /** Playwright resolves a Disposable; callers only await it. */
  addInitScript?: (script: string) => Promise<unknown>;
}

/** Best effort: a context that refuses init scripts still crawls. */
export async function applyStealth(context: StealthContext): Promise<void> {
  try {
    await context.addInitScript?.(STEALTH_INIT_SCRIPT);
  } catch {
    // Ignored: stealth is an optimisation, not a correctness requirement.
  }
}

export interface HumanizePage {
  evaluate?: <T>(fn: () => T) => Promise<T>;
  mouse?: { move(x: number, y: number, options?: { steps?: number }): Promise<void> };
}

function pause(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

/** Randomised, bounded interaction: scroll down in steps, move the mouse, return. */
export async function humanizeSocialPage(
  page: HumanizePage,
  random: () => number = Math.random,
): Promise<void> {
  if (page.evaluate === undefined) return;
  const between = (min: number, max: number): number => min + Math.floor(random() * (max - min));

  await pause(between(400, 1_200));
  const steps = between(2, 4);
  for (let step = 0; step < steps; step += 1) {
    const delta = between(320, 760);
    await page.evaluate(() => window.scrollBy({ top: 640, behavior: 'smooth' }));
    await pause(between(300, 900) + delta % 120);
  }

  if (page.mouse !== undefined) {
    await page.mouse.move(between(120, 980), between(120, 640), { steps: 8 });
    await pause(between(200, 500));
    await page.mouse.move(between(120, 980), between(120, 640), { steps: 8 });
  }

  await page.evaluate(() => window.scrollTo({ top: 0, behavior: 'smooth' }));
  await pause(between(300, 800));
}

/**
 * Post-like nodes only. Appending this to the readable snapshot gives the
 * extractor the rendered timeline text that a CSR shell hides from jsdom.
 */
export async function domDigest(page: HumanizePage): Promise<string> {
  if (page.evaluate === undefined) return '';
  return page.evaluate(() => {
    const selectors = [
      'article',
      '[role="article"]',
      '[data-testid="tweetText"]',
      '.note-item',
      '.video-card',
    ];
    const seen = new Set<string>();
    const chunks: string[] = [];
    for (const selector of selectors) {
      for (const node of document.querySelectorAll(selector)) {
        const text = (node as HTMLElement).innerText?.trim() ?? '';
        if (text.length < 20 || seen.has(text)) continue;
        seen.add(text);
        chunks.push(text);
        if (chunks.length >= 20) return chunks.join('\n\n');
      }
    }
    return chunks.join('\n\n');
  });
}
