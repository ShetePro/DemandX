import { describe, expect, it } from 'vitest';

import { parseCasePage, parseRevenue } from './parse';

const PAGE_TEXT = [
  'Near Fatal Car Crash to $3.8M/Year Selling Skincare Products',
  'June 11th, 2018',
  'About Business Tools Andy Hnilo Founder, Alitura Naturals $316K revenue/mo 1 Founders 6 Employees',
  'Alitura Naturals alitura.com from Los Angeles, California, USA started June 2014',
  '$316,000 revenue/mo 1 Founders 6 Employees',
].join('\n');

const PAGE_HTML =
  '<html><head><meta name="description" content="Hello! Who are you and what are you working on? I am the Founder &amp; CEO of Alitura."></head></html>';

describe('parseRevenue', () => {
  it('prefers the site label over the headline figure', () => {
    expect(parseRevenue(PAGE_TEXT)).toEqual({
      month: 316_000,
      note: '$316K revenue/mo',
    });
  });

  it('converts a headline yearly figure to a month', () => {
    expect(parseRevenue('I built a $3.8M/Year business')).toEqual({
      month: 316_666.67,
      note: '$3.8M/Year',
    });
  });

  it('does not read a tool price in the body as revenue', () => {
    const text = `A long story about tools.\n${'x'.repeat(300)}\nWe pay $19/mo for Notion.`;
    expect(parseRevenue(text)).toBeNull();
  });
});

describe('parseCasePage', () => {
  it('reads the identity, revenue and founding year the page states', () => {
    expect(
      parseCasePage({
        url: 'https://www.starterstory.com/stories/alitura-naturals',
        title: 'Near Fatal Car Crash to $3.8M/Year Selling Skincare Products - Starter Story',
        text: PAGE_TEXT,
        html: PAGE_HTML,
      }),
    ).toEqual({
      slug: 'alitura-naturals',
      title: 'Near Fatal Car Crash to $3.8M/Year Selling Skincare Products',
      revenueMonth: 316_000,
      revenueNote: '$316K revenue/mo',
      foundedYear: 2014,
      summary: 'Hello! Who are you and what are you working on? I am the Founder & CEO of Alitura.',
      founders: 1,
      employees: 6,
    });
  });

  it('leaves missing fields null instead of guessing', () => {
    const parsed = parseCasePage({
      url: 'https://www.starterstory.com/stories/unknown',
      title: 'Unknown',
      text: 'A page with no metadata block.',
    });

    expect(parsed.revenueMonth).toBeNull();
    expect(parsed.foundedYear).toBeNull();
    expect(parsed.summary).toBeNull();
  });
});
