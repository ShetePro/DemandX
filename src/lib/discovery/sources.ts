import { hammingDistance, simhash64 } from '@/lib/evidence/simhash';

import type { DiscoverySource } from './types';

/**
 * Content farms publish keyword-shaped articles, not complaints: their pages
 * dominate generic queries and poison an opportunity scan with advice columns.
 * They are dropped outright rather than down-ranked, because one "DLL repair"
 * blog post is enough to invent a fake product idea.
 */
export const BLOCKED_HOSTS: readonly string[] = [
  'csdn.net',
  'toutiao.com',
  'baijiahao.baidu.com',
  'sohu.com',
  '163.com',
  'jianshu.com',
  'zhuanlan.zhihu.com',
  // Dictionaries, encyclopedias and translation pages match keywords without
  // describing any workflow; they are the main source of off-topic "quote".
  'cambridge.org',
  'dictionary.com',
  'yahoo.com',
  'englisher.info',
  'uptogo.com.tw',
  'wikipedia.org',
  'baike.baidu.com',
  'zhidao.baidu.com',
];

/** Communities where people describe work and money in their own words. */
export const COMMUNITY_HOSTS: readonly string[] = [
  'reddit.com',
  'news.ycombinator.com',
  'x.com',
  'twitter.com',
  'v2ex.com',
  'zhihu.com',
  'weibo.com',
  'douban.com',
  'xiaohongshu.com',
  'douyin.com',
  'tieba.baidu.com',
  'producthunt.com',
  'indiehackers.com',
  'sspai.com',
  'juejin.cn',
];

/**
 * Commercial context: money, time cost, hiring, paid alternatives. A snippet
 * without one of these is someone's opinion, not a market signal.
 */
export const BUSINESS_PATTERN =
  /(付费|价格|收费|订阅|续费|预算|成本|外包|雇|招人|客户|发票|报销|月费|年费|每月|每年|按月|按年|报价|竞品|替代|贵|省钱|[¥$]|\d+\s*(元|美元|块|usd)|pay|paid|pricing|price|subscription|invoice|billing|customer|client|budget|cost|hire|hiring|outsourc|revenue|refund|worth it|afford|alternative|self-host)/i;

/**
 * Tokens that appear in almost every query and therefore prove nothing about
 * relevance. Domain nouns (发票/对账/invoice/…) are what the match tests for.
 */
const GENERIC_TOKENS: Record<string, true> = {
  工具: true,
  软件: true,
  手工: true,
  excel: true,
  小公司: true,
  公司: true,
  团队: true,
  小企业: true,
  卖家: true,
  店长: true,
  财务: true,
  销售: true,
  hr: true,
  小团队: true,
  知乎: true,
  reddit: true,
  小红书: true,
  微博: true,
  v2ex: true,
  site: true,
  com: true,
  www: true,
  small: true,
  business: true,
  software: true,
  spreadsheet: true,
  tool: true,
  tools: true,
  pay: true,
  paid: true,
  manual: true,
  data: true,
  team: true,
  for: true,
  and: true,
  the: true,
  with: true,
  that: true,
  your: true,
};

function hostOf(url: string): string {
  try {
    return new URL(url).hostname.toLowerCase();
  } catch {
    return '';
  }
}

function matchesHost(host: string, list: readonly string[]): boolean {
  return list.some((domain) => host === domain || host.endsWith(`.${domain}`));
}

export function isBlockedSource(url: string | DiscoverySource): boolean {
  const host = hostOf(typeof url === 'string' ? url : url.url);
  return host === '' || matchesHost(host, BLOCKED_HOSTS);
}

export function isCommunitySource(url: string | DiscoverySource): boolean {
  const host = hostOf(typeof url === 'string' ? url : url.url);
  return matchesHost(host, COMMUNITY_HOSTS);
}

export function hasBusinessSignal(text: string): boolean {
  return BUSINESS_PATTERN.test(text);
}

/** The text the model and the filter both see for one hit. */
export function sourceText(source: DiscoverySource): string {
  return `${source.title}\n${source.snippet}`;
}

/**
 * Query terms that carry the topic: Chinese tokens are kept whole (发票, 对账),
 * English is lowercased. Generic workflow words are removed so a page about
 * "spreadsheets" is not automatically relevant to an invoicing query.
 */
export function queryKeywords(query: string): string[] {
  const tokens = query
    .toLowerCase()
    .replace(/site:\S+/g, ' ')
    .split(/[^\p{L}\p{N}]+/u)
    .filter((token) => token.length >= 2);

  const specific = tokens.filter((token) => GENERIC_TOKENS[token] === undefined);
  const chosen = specific.length > 0 ? specific : tokens;
  return [...new Set(chosen)];
}

export function relevanceScore(source: DiscoverySource, query: string): number {
  const text = sourceText(source).toLowerCase();
  return queryKeywords(query).reduce(
    (score, keyword) => (text.includes(keyword) ? score + 1 : score),
    0,
  );
}

/**
 * Relevance first: without a topical match the page is noise no matter how
 * reputable its host. Community and money mentions then break ties.
 */
export function scoreSource(source: DiscoverySource, query: string): number {
  if (isBlockedSource(source)) return -1;
  return (
    (isCommunitySource(source) ? 2 : 0) +
    (hasBusinessSignal(sourceText(source)) ? 1 : 0) +
    Math.min(2, relevanceScore(source, query))
  );
}

function normalize(text: string): string {
  return text.toLowerCase().replace(/\s+/g, '');
}

function quoteTokens(text: string): string[] {
  const tokens: string[] = [];
  for (const word of text.toLowerCase().split(/[^\p{L}\p{N}]+/u)) {
    if (word.length >= 3) tokens.push(word);
  }
  // CJK is written without spaces; bigrams approximate word identity.
  for (const run of text.match(/[\u4e00-\u9fff]+/g) ?? []) {
    for (let index = 0; index < run.length - 1; index += 1) {
      tokens.push(run.slice(index, index + 2));
    }
  }
  return tokens;
}

/**
 * A citation is only accepted when its quote can be found in the source the
 * model was given. Paraphrases are allowed up to a token majority, but a quote
 * invented wholesale fails — which is the failure mode URL-only checks miss.
 */
export function quoteGrounded(quote: string, source: string): boolean {
  const cleanQuote = normalize(quote);
  if (cleanQuote.length < 4) return false;
  if (normalize(source).includes(cleanQuote)) return true;

  const tokens = quoteTokens(quote);
  if (tokens.length === 0) return false;
  const sourceText = source.toLowerCase();
  const present = tokens.filter((token) => sourceText.includes(token)).length;
  return present / tokens.length >= 0.6;
}

export interface Candidate {
  source: DiscoverySource;
  /** The query that produced it; relevance is always judged against this. */
  query: string;
}

/**
 * Drops blocked hosts and off-topic strangers, removes near-duplicates, then
 * keeps the highest-scoring `limit` candidates. Sorting is stable, so two
 * equally good pages keep the search engine's order.
 */
export function selectSources(
  candidates: readonly Candidate[],
  limit: number,
  perQuery = 5,
): DiscoverySource[] {
  const seenUrls = new Set<string>();
  const fingerprints: bigint[] = [];
  const perQueryCount = new Map<string, number>();

  const scored = candidates.flatMap((candidate) => {
    if (seenUrls.has(candidate.source.url)) return [];
    seenUrls.add(candidate.source.url);

    const score = scoreSource(candidate.source, candidate.query);
    if (score < 0) return [];

    // Keep the sample diverse: one verbose query must not fill every slot.
    const used = perQueryCount.get(candidate.query) ?? 0;
    if (used >= perQuery) return [];
    perQueryCount.set(candidate.query, used + 1);

    const fingerprint = simhash64(sourceText(candidate.source));
    if (fingerprints.some((stored) => hammingDistance(stored, fingerprint) <= 2)) {
      return [];
    }
    fingerprints.push(fingerprint);

    return [{ source: candidate.source, score }];
  });

  return scored
    .sort((a, b) => b.score - a.score)
    .slice(0, limit)
    .map((entry) => entry.source);
}
