import { describe, expect, it } from 'vitest';

import {
  hasBusinessSignal,
  isBlockedSource,
  isCommunitySource,
  queryKeywords,
  quoteGrounded,
  relevanceScore,
  scoreSource,
  selectSources,
} from './sources';
import type { DiscoverySource } from './types';

function source(url: string, title: string, snippet: string): DiscoverySource {
  return { url, title, snippet, platform: 'web' };
}

function candidate(url: string, title: string, snippet: string, query: string) {
  return { source: source(url, title, snippet), query };
}

describe('hasBusinessSignal', () => {
  it('matches money, hiring and paid alternatives in both languages', () => {
    for (const text of [
      '价格 200 元',
      '愿意付费',
      '外包太贵',
      'pricing page',
      'we hire a VA',
      'alternatives to X',
    ]) {
      expect(hasBusinessSignal(text)).toBe(true);
    }
  });

  it('does not treat plain emotion as a market signal', () => {
    expect(hasBusinessSignal('好烦啊，每天都很累')).toBe(false);
  });
});

describe('queryKeywords', () => {
  it('keeps domain nouns and drops workflow filler', () => {
    expect(queryKeywords('发票 报销 手工 excel 小公司 财务')).toEqual(['发票', '报销']);
    expect(queryKeywords('invoice reconciliation spreadsheet small business software')).toEqual([
      'invoice',
      'reconciliation',
    ]);
  });

  it('ignores site: operators and platform names', () => {
    expect(queryKeywords('site:reddit.com invoice tool pay')).toEqual(['invoice']);
    expect(queryKeywords('知乎 发票 报销')).toEqual(['发票', '报销']);
  });
});

describe('relevanceScore / scoreSource', () => {
  it('ranks a relevant page above an unrelated one', () => {
    const relevant = source('https://example.com/a', '发票报销工具', '每月 29 元');
    const unrelated = source('https://example.com/b', '天龙八部', '鸠摩智');
    expect(relevanceScore(relevant, '发票 报销')).toBeGreaterThan(0);
    expect(relevanceScore(unrelated, '发票 报销')).toBe(0);
    expect(scoreSource(relevant, '发票 报销')).toBeGreaterThan(scoreSource(unrelated, '发票 报销'));
  });

  it('rewards community hosts and money words', () => {
    const plain = scoreSource(
      source('https://www.reddit.com/r/x', '门店排班', '太麻烦'),
      '排班 门店',
    );
    const paid = scoreSource(
      source('https://www.reddit.com/r/x', '门店排班', '愿意付费'),
      '排班 门店',
    );
    expect(paid).toBeGreaterThan(plain);
  });

  it('marks blocked hosts negative so they never reach a slot', () => {
    expect(scoreSource(source('https://blog.csdn.net/x', '发票报销', '价格'), '发票 报销')).toBe(
      -1,
    );
  });
});

describe('quoteGrounded', () => {
  it('accepts a verbatim quote and a close paraphrase', () => {
    const text = '我们每天手工对账，愿意付费买一个工具，预算每月 200 元。';
    expect(quoteGrounded('愿意付费买一个工具', text)).toBe(true);
    expect(quoteGrounded('每天手工对账 愿意付费', text)).toBe(true);
  });

  it('rejects an invented quote', () => {
    expect(quoteGrounded('这个市场至少有十亿规模', '我们每天手工对账，愿意付费。')).toBe(false);
    expect(quoteGrounded('ok', '我们每天手工对账')).toBe(false);
  });
});

describe('hosts', () => {
  it('blocks content farms and dictionaries', () => {
    expect(isBlockedSource('https://blog.csdn.net/x/article')).toBe(true);
    expect(isBlockedSource('https://dictionary.cambridge.org/x')).toBe(true);
    expect(isBlockedSource('https://www.toutiao.com/article/1')).toBe(true);
  });

  it('recognises community hosts, including subdomains', () => {
    expect(isCommunitySource('https://old.reddit.com/r/saas')).toBe(true);
    expect(isCommunitySource('https://news.ycombinator.com/item?id=1')).toBe(true);
    expect(isCommunitySource('https://example.com/blog')).toBe(false);
  });
});

describe('selectSources', () => {
  it('drops blocked pages and duplicate URLs, keeping the best first', () => {
    const query = '发票 报销';
    const candidates = [
      candidate('https://blog.csdn.net/x', '发票报销', '每月 29 元', query),
      candidate('https://www.reddit.com/r/a', '发票报销太麻烦', '愿意付费', query),
      candidate('https://example.com/price', '发票报销工具', '每月 29 美元', query),
      candidate('https://example.com/price', '发票报销工具', '每月 29 美元', '发票 报销'),
    ];

    const selected = selectSources(candidates, 10);

    expect(selected[0]?.url).toBe('https://www.reddit.com/r/a');
    expect(selected.some((item) => item.url.includes('csdn'))).toBe(false);
    expect(selected.filter((item) => item.url === 'https://example.com/price')).toHaveLength(1);
  });

  it('caps how many sources one query may contribute', () => {
    const query = '发票 报销';
    const candidates = Array.from({ length: 8 }, (_, index) =>
      candidate(`https://example.com/${index}`, `发票报销 ${index}`, `价格 ${index} 元`, query),
    );

    expect(selectSources(candidates, 30, 3)).toHaveLength(3);
  });

  it('honours the total cap', () => {
    const query = '发票 报销';
    const candidates = Array.from({ length: 10 }, (_, index) =>
      candidate(`https://example.com/${index}`, `发票报销 ${index}`, `价格 ${index} 元`, query),
    );

    expect(selectSources(candidates, 4, 10)).toHaveLength(4);
  });
});
