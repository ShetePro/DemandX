import { load } from 'cheerio';

import type { HumanReason } from './port';

/**
 * Challenges live in the first screens of a document; scanning further only
 * raises the false-positive odds (an article *about* captchas, for instance).
 */
export const MAX_SCAN_CHARS = 200_000;

/**
 * Markup that only a challenge page carries. Checked before any text: a
 * Cloudflare interstitial also says "verify you are human", but the wrapper
 * proves it is a block, not a site-specific captcha.
 */
const BLOCKED_SELECTORS = [
  '#challenge-form',
  '#challenge-running',
  '#cf-wrapper',
  '[class*="cf-challenge" i]',
  '[class*="cf-browser-verification" i]',
];

const CAPTCHA_SELECTORS = [
  '#captcha',
  '[id*="captcha" i]',
  '[class*="captcha" i]',
  '[class*="verify-human" i]',
  '.g-recaptcha',
  '.h-captcha',
  'iframe[src*="recaptcha" i]',
  'iframe[src*="hcaptcha" i]',
];

/**
 * Wording that only appears on a challenge page. Bare `验证码` is deliberately
 * absent: articles *about* captchas mention it constantly, while UI copy asks
 * the visitor to do something. The Chinese phrases are what 小红书 / 知乎 /
 * 微博 emit; the English ones cover Cloudflare and Akamai.
 */
const CAPTCHA_TEXT = [
  '请输入验证码',
  '请完成验证',
  '请完成人机验证',
  '完成下列验证',
  '请拖动滑块',
  '滑动验证',
  'not a robot',
  'verify you are human',
];
const LOGIN_TEXT = [
  '请先登录',
  '请登录',
  '登录后查看',
  '登录后可见',
  '登录后参与',
  '立即登录',
  '扫码登录',
  '账号登录',
  'please log in',
  'please sign in',
  'sign in to continue',
  'log in to continue',
  'login required',
];
const BLOCKED_TEXT = [
  '访问过于频繁',
  '请求过于频繁',
  '操作过于频繁',
  '访问受限',
  '访问被拒绝',
  '异常访问',
  '请求被拦截',
  '您的访问出错了',
  'checking your browser',
  'just a moment',
  'attention required',
  'access denied',
  'too many requests',
  'unusual traffic',
  'enable javascript',
];

/** Path segments that are a login wall on their own. */
const LOGIN_SEGMENTS: Readonly<Record<string, true>> = {
  login: true,
  'log-in': true,
  signin: true,
  'sign-in': true,
  sign_in: true,
  passport: true,
};

function urlLooksLikeLogin(url: string): boolean {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return false;
  }
  return parsed.pathname
    .toLowerCase()
    .split('/')
    .some((segment) => LOGIN_SEGMENTS[segment] === true);
}

function includesAny(haystack: string, needles: readonly string[]): boolean {
  return needles.some((needle) => haystack.includes(needle));
}

/**
 * Classify a response body as a page a machine must not push through:
 * `captcha`, `login` or `blocked`. Returns `null` for ordinary pages.
 *
 * Detection never solves anything — it only routes the URL to a person, so a
 * miss here costs a retry while a false positive costs a queued page. Markup
 * wins over prose, and prose wins over the URL, because that is the order in
 * which the evidence gets less reliable.
 */
export function detectChallenge(html: string, url: string): HumanReason | null {
  if (html.trim() === '') return null;

  const $ = load(html.slice(0, MAX_SCAN_CHARS));
  $('script, style, noscript').remove();

  const markup = (selector: string): boolean => $(selector).length > 0;
  if (BLOCKED_SELECTORS.some(markup)) return 'blocked';
  if (CAPTCHA_SELECTORS.some(markup)) return 'captcha';

  // Collapse whitespace so a phrase split across tags still matches.
  const text = $.root().text().replace(/\s+/g, ' ').toLowerCase();
  if (includesAny(text, CAPTCHA_TEXT)) return 'captcha';
  if (includesAny(text, LOGIN_TEXT)) return 'login';
  if (includesAny(text, BLOCKED_TEXT)) return 'blocked';

  return urlLooksLikeLogin(url) ? 'login' : null;
}
