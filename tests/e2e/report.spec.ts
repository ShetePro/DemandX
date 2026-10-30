import { readFile } from 'node:fs/promises';

import { expect, test, type Page } from '@playwright/test';

import { closeDb } from './helpers/db';
import {
  CREDIBILITY,
  DECISION,
  IDEA_TITLE,
  PLATFORM_A,
  PLATFORM_B,
  QUOTE_A,
  QUOTE_B,
  RUBRIC_TOTAL,
  SECTION_HEADINGS,
  UNCITED_CLAIM,
  countReportRows,
  deleteReportFixture,
  seedReportFixture,
  type ReportFixture,
} from './helpers/report';

/**
 * Report page end to end: the eight sections and the stored numbers, the
 * citation rail cut from a real snapshot, the Markdown download built by the
 * server action, and the print layout that hides the screen-only chrome.
 *
 * The pipeline stages that normally write the report do not exist yet, so the
 * suite inserts the rows they would have written (SQL only, no UI) and reads
 * the page the same way a reader does. Every id it creates is removed again in
 * `afterAll`, so the shared `demandx` database is left as found.
 */

/** One fixture per test; `afterAll` deletes them all and proves the tables are clear. */
const fixtures: ReportFixture[] = [];

function current(): ReportFixture {
  const last = fixtures.at(-1);
  if (last === undefined) throw new Error('测试数据尚未写入');
  return last;
}

/**
 * The report's citation rail. The workbench shell renders its own `<aside>`,
 * so the panel is found by its own heading instead of by position.
 */
function citationRail(page: Page) {
  return page.locator('aside').filter({ hasText: '引用 e' });
}

test.describe('Report', () => {
  // The suites share one database, so this file's own tests must not overlap.
  test.describe.configure({ mode: 'serial', timeout: 120_000 });

  test.beforeEach(async () => {
    fixtures.push(await seedReportFixture());
  });

  test.afterAll(async () => {
    for (const fixture of fixtures) await deleteReportFixture(fixture);

    for (const fixture of fixtures) {
      expect(await countReportRows(fixture)).toEqual({
        reports: 0,
        citations: 0,
        scores: 0,
        opportunities: 0,
        evidence: 0,
        sources: 0,
        runs: 0,
        threads: 0,
        ideas: 0,
      });
    }

    await closeDb();
  });

  test('八节与分数', async ({ page }) => {
    const fixture = current();
    await page.goto(`/runs/${fixture.runId}/report`);

    await expect(page.getByRole('heading', { level: 1 })).toHaveText(IDEA_TITLE);

    for (const heading of SECTION_HEADINGS) {
      await expect(page.getByRole('heading', { level: 2, name: heading })).toBeVisible();
    }

    await expect(page.getByText(`${RUBRIC_TOTAL} / 100`)).toBeVisible();
    await expect(page.getByRole('img', { name: `可信度 ${CREDIBILITY}` })).toBeVisible();
    await expect(page.getByText(DECISION, { exact: true })).toBeVisible();

    // The one claim S6 would have refused: marked in the body, never promoted
    // to a printable footnote.
    const finance = page.locator('section#finance');
    await expect(finance).toContainText(UNCITED_CLAIM);
    await expect(finance.getByText('无引用')).toBeVisible();

    // The footnote list is `hidden` on screen, so a role query would miss it:
    // it lives in the print layout and only becomes visible on paper.
    const footnotes = page.locator('section[aria-label="引用脚注"]');
    await expect(footnotes).toHaveCount(1);
    const text = (await footnotes.textContent()) ?? '';
    expect(text).toContain(`[e${fixture.evidenceIds.first}]`);
    expect(text).toContain(`[e${fixture.evidenceIds.second}]`);
    expect(text).not.toContain(UNCITED_CLAIM);
  });

  test('引用', async ({ page }) => {
    const fixture = current();
    const second = fixture.evidenceIds.second;
    await page.goto(`/runs/${fixture.runId}/report`);

    // The rail opens on the first cited evidence; clicking the second chip must
    // switch it, quoting the snapshot at the stored offset.
    await page
      .getByRole('button', { name: `证据 e${second}` })
      .first()
      .click();

    await expect(page.getByRole('heading', { name: `引用 e${second}` })).toBeVisible();

    const rail = citationRail(page);
    await expect(rail).toContainText(PLATFORM_B);
    await expect(rail.locator('mark')).toHaveText(QUOTE_B);
    await expect(rail).toContainText('不能证明他们会换到新产品');

    // And back to the first: the panel is driven by the chip, not by the URL.
    await page
      .getByRole('button', { name: `证据 e${fixture.evidenceIds.first}` })
      .first()
      .click();
    await expect(
      page.getByRole('heading', { name: `引用 e${fixture.evidenceIds.first}` }),
    ).toBeVisible();
    await expect(rail).toContainText(PLATFORM_A);
    await expect(rail.locator('mark')).toHaveText(QUOTE_A);
  });

  test('导出', async ({ page }) => {
    const fixture = current();
    await page.goto(`/runs/${fixture.runId}/report`);

    const [download] = await Promise.all([
      page.waitForEvent('download'),
      page.getByRole('button', { name: '导出 Markdown' }).click(),
    ]);

    expect(download.suggestedFilename()).toMatch(/\.md$/);
    expect(await download.failure()).toBeNull();

    const file = await download.path();
    expect(file).not.toBeNull();
    const content = await readFile(file ?? '', 'utf8');

    // The download is the stored report, not the client's copy: all eight
    // sections come from Postgres through the server action.
    for (const heading of SECTION_HEADINGS) {
      expect(content).toContain(`## ${heading}`);
    }

    expect(content).toContain(`[e${fixture.evidenceIds.first}]`);
    expect(content).toContain(`[e${fixture.evidenceIds.second}]`);
    expect(content).toContain(`**总分**：${RUBRIC_TOTAL} / 100`);
    expect(content).toContain(`**决策**：${DECISION}`);
    expect(content).toContain(PLATFORM_A);
    expect(content).toContain(PLATFORM_B);

    // An uncited claim never reaches the printable body.
    expect(content).not.toContain(UNCITED_CLAIM);
  });

  test('打印', async ({ page }) => {
    await page.goto(`/runs/${current().runId}/report`);

    const toc = page.getByRole('navigation', { name: '报告目录' });
    const exportButton = page.getByRole('button', { name: '导出 Markdown' });
    const rail = citationRail(page);

    await expect(toc).toBeVisible();
    await expect(exportButton).toBeVisible();
    await expect(rail).toBeVisible();

    await page.emulateMedia({ media: 'print' });

    // Screen-only affordances disappear; the prose and the footnote list stay.
    await expect(toc).toBeHidden();
    await expect(exportButton).toBeHidden();
    await expect(page.getByRole('button', { name: '打印' })).toBeHidden();
    await expect(rail).toBeHidden();

    await expect(page.getByRole('heading', { level: 2, name: SECTION_HEADINGS[0] })).toBeVisible();
    await expect(page.getByText(UNCITED_CLAIM)).toBeVisible();
    await expect(page.locator('section[aria-label="引用脚注"]')).toBeVisible();

    await page.emulateMedia({ media: null });
  });
});
