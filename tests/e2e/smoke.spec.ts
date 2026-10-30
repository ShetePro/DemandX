import { expect, test, type Page } from '@playwright/test';

import { closeDb } from './helpers/db';
import {
  CREDIBILITY,
  IDEA_TITLE,
  RUBRIC_TOTAL,
  countReportRows,
  deleteReportFixture,
  seedReportFixture,
  type ReportFixture,
} from './helpers/report';

/**
 * The in-page view switch. Scoped to its own nav: the report body also carries
 * links whose names contain 证据 / 计划.
 */
function tabs(page: Page) {
  return page.getByRole('navigation', { name: '会话视图' });
}

/**
 * The shell end to end: conversations are the navigation unit. The suite seeds
 * one finished run with a real report (SQL only, no UI) so the sidebar row can
 * be checked against the state and score the database actually holds, then
 * drives the four in-page views of that conversation.
 *
 * Every row the fixture creates is removed again in `afterAll`, so the shared
 * `demandx` database is left as found.
 */
test.describe('Shell', () => {
  test.describe.configure({ mode: 'serial', timeout: 120_000 });

  const fixtures: ReportFixture[] = [];

  test.afterAll(async () => {
    for (const fixture of fixtures) await deleteReportFixture(fixture);
    for (const fixture of fixtures) {
      expect(await countReportRows(fixture)).toMatchObject({
        reports: 0,
        citations: 0,
        evidence: 0,
        runs: 0,
        threads: 0,
        ideas: 0,
      });
    }

    await closeDb();
  });

  test('会话是导航单位：侧栏进入详情，详情内切换四个视图', async ({ page }) => {
    const fixture = await seedReportFixture();
    fixtures.push(fixture);

    // The root is the new-research screen, not a dashboard.
    await page.goto('/');
    await expect(page).toHaveURL(/\/threads\/new$/);
    await expect(page.getByRole('heading', { level: 1 })).toHaveText('先描述一个问题');

    const list = page.getByRole('navigation', { name: '会话列表' });
    await expect(list).toBeVisible();

    // The four old destinations are gone; conversations replace them.
    for (const gone of ['工作台', '报告', '证据库']) {
      await expect(list.getByRole('link', { name: gone })).toHaveCount(0);
    }

    // A row shows the real state of the newest run and the report's score.
    const row = () => list.getByRole('link', { name: new RegExp(IDEA_TITLE) }).first();
    await expect(row()).toContainText('已完成');
    await expect(row()).toContainText(`${RUBRIC_TOTAL} · ${CREDIBILITY}`);

    await row().click();
    await expect(page).toHaveURL(new RegExp(`/threads/${fixture.threadId}$`));
    await expect(row()).toHaveAttribute('aria-current', 'page');

    // Every view stays on the same conversation; only `?view=` changes.
    await tabs(page).getByRole('link', { name: '报告', exact: true }).click();
    await expect(page).toHaveURL(new RegExp(`/threads/${fixture.threadId}\\?view=report$`));
    await expect(page.getByRole('heading', { level: 1 })).toHaveText(IDEA_TITLE);
    await expect(page.getByText(`${RUBRIC_TOTAL} / 100`)).toBeVisible();

    await tabs(page).getByRole('link', { name: '证据', exact: true }).click();
    await expect(page).toHaveURL(new RegExp(`/threads/${fixture.threadId}\\?view=evidence$`));
    await expect(page.getByRole('heading', { level: 1 })).toHaveText('证据库');

    await tabs(page).getByRole('link', { name: '计划', exact: true }).click();
    await expect(page).toHaveURL(new RegExp(`/threads/${fixture.threadId}\\?view=plan$`));
    await expect(page.getByRole('heading', { level: 1 })).toHaveText('14 天验证计划');

    await tabs(page).getByRole('link', { name: '对话', exact: true }).click();
    await expect(page).toHaveURL(new RegExp(`/threads/${fixture.threadId}$`));
    await expect(page.getByRole('heading', { level: 1 })).toHaveText(IDEA_TITLE);
  });
});
