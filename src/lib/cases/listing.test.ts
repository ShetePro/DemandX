import { describe, expect, it } from 'vitest';

import { parseListingPage, parseMoney } from './listing';

const PAGE = `
<div class="num-results">Showing 100 of 3,745 ideas</div>
<div id="db-view-rows">
  <a class="nostylelink flex items-center gap-3 px-3 py-2.5 " href="/businesses/flamme">
    <div class="min-w-0 flex-1">
      <div class="text-sm font-semibold text-slate-900 truncate">Couples relationship app</div>
      <div class="text-xs text-slate-500 truncate leading-snug">Couples app with daily questions</div>
      <div class="flex items-center gap-1 5 mt-0 5"><span class="font-mono text-slate-400 truncate text-[11px]">flamme.app</span></div>
    </div>
    <div class="shrink-0 text-right">
      <div class="db-rev is-estimated" title="Estimated from public sources">
        <span class="db-rev-fig">$10K <small>/mo</small></span>
        <span class="db-rev-src">Estimated</span>
      </div>
    </div>
  </a>
  <a class="nostylelink flex items-center gap-3 px-3 py-2.5 " href="/businesses/reported-co">
    <div class="min-w-0 flex-1">
      <div class="text-sm font-semibold text-slate-900 truncate">Reported business</div>
      <div class="text-xs text-slate-500 truncate leading-snug">A founder-reported case</div>
      <div><span class="font-mono text-slate-400 truncate text-[11px]">reported.co</span></div>
    </div>
    <div class="shrink-0 text-right">
      <div class="db-rev is-reported">
        <span class="db-rev-fig">$1.2M <small>/mo</small></span>
        <span class="db-rev-src">Reported</span>
      </div>
    </div>
  </a>
</div>
<div id="db-view-cards">
  <div class="rounded-xl border border-slate-200 bg-white p-4 shadow-sm">
    <a class="nostylelink block" href="/businesses/flamme"><span class="font-bold text-slate-900 leading-snug block text-[15px]">Couples relationship app</span></a>
    <p class="text-sm text-slate-500 leading-snug m-0 mt-1">Couples app with daily questions</p>
    <span class="font-mono text-slate-400 truncate text-[11px]" style="max-width: 60%">flamme.app</span>
    <div class="db-rev is-estimated"><span class="db-rev-fig">$10K <small>/mo</small></span><span class="db-rev-src">Estimated</span></div>
    <div class="min-w-0"><div>Solo score</div><div class="text-sm"><span class="tabular-nums">78</span></div></div>
    <div class="mt-3"><div class="font-mono">Model</div><div class="flex flex-wrap gap-1">
      <a class="db-tag" href="/data?business_model=9703"><span class="db-tag-label">Subscription</span></a>
      <a class="db-tag" href="/data?business_model=14144"><span class="db-tag-label">Print on demand merch</span></a>
    </div></div>
    <div class="mt-3"><div class="font-mono">Growth</div><div class="flex">
      <span class="db-tag" data-tag-tooltip="Free traffic"><span class="db-tag-label">SEO</span></span>
    </div></div>
    <div class="mt-3"><div class="font-mono">Customers</div><div>
      <a class="db-tag" href="/data?icp=12677"><span class="db-tag-label">Couples</span></a>
    </div></div>
    <div class="mt-3"><div class="font-mono">Tools</div><div class="db-tools">
      <span class="db-tool" title="TikTok"></span>
    </div></div>
    <div class="mt-3 db-facts whitespace-normal"><span>SaaS</span></div>
  </div>
</div>
`;

describe('parseMoney', () => {
  it('reads the listed shorthand', () => {
    expect(parseMoney('$30K')).toBe(30_000);
    expect(parseMoney('$1.2M')).toBe(1_200_000);
    expect(parseMoney('$650')).toBe(650);
  });
});

describe('parseListingPage', () => {
  const page = parseListingPage(PAGE);

  it('reads the counter and both revenue provenances', () => {
    expect(page.total).toBe(3_745);
    const reported = page.ideas.find((idea) => idea.slug === 'reported-co');
    expect(reported?.revenueMonth).toBe(1_200_000);
    expect(reported?.revenueSource).toBe('reported');
  });

  it('merges the rich card fields into the row record', () => {
    const flamme = page.ideas.find((idea) => idea.slug === 'flamme');

    expect(flamme).toMatchObject({
      title: 'Couples relationship app',
      summary: 'Couples app with daily questions',
      domain: 'flamme.app',
      revenueMonth: 10_000,
      revenueSource: 'estimated',
      soloScore: 78,
      models: ['Subscription', 'Print on demand merch'],
      growth: ['SEO'],
      customers: ['Couples'],
      tools: ['TikTok'],
      facts: ['SaaS'],
    });
  });

  it('collects business-model filter ids for the next request', () => {
    expect(page.models).toEqual(
      expect.arrayContaining([
        { id: '9703', name: 'Subscription' },
        { id: '14144', name: 'Print on demand merch' },
      ]),
    );
  });

  it('returns nothing for the paywall landing page', () => {
    const empty = parseListingPage('<html><body>Join Starter Story</body></html>');
    expect(empty.total).toBeNull();
    expect(empty.ideas).toEqual([]);
  });
});
