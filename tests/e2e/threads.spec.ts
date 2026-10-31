import { expect, test, type Page } from '@playwright/test';

import {
  closeDb,
  countThreadArtifacts,
  deleteThreadsWithIdeas,
  purgeProvidersByPrefix,
} from './helpers/db';
import { resetStub, setupProviderWithChains } from './helpers/llm';

/**
 * Sidebar actions end to end: every conversation row exposes its actions both
 * on right-click and through the hover button, and deleting asks for
 * confirmation before removing the thread, its messages and its run.
 */

const PROVIDER_NAME = 'e2e-thread-actions';
const PROVIDER_PREFIX = `${PROVIDER_NAME}%`;
const API_KEY = 'sk-e2e-thread-actions-123456';

const createdThreadIds: number[] = [];

let ideaCounter = 0;

function nextIdea(): string {
  ideaCounter += 1;
  return `e2e 删除会话 ${Date.now()}-${ideaCounter}`;
}

async function createThread(page: Page, idea: string): Promise<number> {
  await page.goto('/threads/new');
  const composer = page.getByLabel('输入消息');
  await composer.fill(idea);
  await composer.press('Enter');

  await expect(page).toHaveURL(/\/threads\/\d+$/, { timeout: 15_000 });
  const match = /\/threads\/(\d+)$/.exec(page.url());
  if (match?.[1] === undefined) throw new Error(`无法从 URL 解析 thread id: ${page.url()}`);

  const threadId = Number(match[1]);
  createdThreadIds.push(threadId);
  return threadId;
}

function rowLink(page: Page, idea: string) {
  return page.getByRole('navigation', { name: '会话列表' }).getByRole('link', { name: idea });
}

async function confirmDeletion(page: Page): Promise<void> {
  const dialog = page.getByRole('dialog', { name: '删除会话？' });
  await expect(dialog).toBeVisible();
  await dialog.getByRole('button', { name: '删除', exact: true }).click();
}

test.describe('Sidebar conversations', () => {
  test.describe.configure({ mode: 'serial', timeout: 120_000 });

  test.beforeEach(async ({ page, request }) => {
    await resetStub(request);
    await purgeProvidersByPrefix(PROVIDER_PREFIX);
    await setupProviderWithChains(page, {
      name: PROVIDER_NAME,
      apiKey: API_KEY,
      bulk: ['stub-model-a'],
      quality: ['stub-model-a'],
    });
  });

  test.afterAll(async () => {
    await purgeProvidersByPrefix(PROVIDER_PREFIX);
    await deleteThreadsWithIdeas(createdThreadIds);
    await closeDb();
  });

  test('deletes a conversation through the hover button', async ({ page }) => {
    const idea = nextIdea();
    const threadId = await createThread(page, idea);

    const row = rowLink(page, idea);
    await expect(row).toBeVisible();
    await row.hover();

    const trigger = page.getByRole('button', { name: `会话操作：${idea}` });
    await expect(trigger).toBeVisible();
    await trigger.click();

    await page.getByRole('menuitem', { name: '删除会话' }).click();
    await confirmDeletion(page);

    await expect(page).toHaveURL('/threads/new', { timeout: 15_000 });
    await expect(rowLink(page, idea)).toHaveCount(0);
    expect(await countThreadArtifacts([threadId])).toEqual({ threads: 0, runs: 0, messages: 0 });
  });

  test('opens the same menu on right-click and deletes', async ({ page }) => {
    const idea = nextIdea();
    const threadId = await createThread(page, idea);

    const row = rowLink(page, idea);
    await expect(row).toBeVisible();
    await row.click({ button: 'right' });

    await page.getByRole('menuitem', { name: '删除会话' }).click();
    await confirmDeletion(page);

    await expect(page).toHaveURL('/threads/new', { timeout: 15_000 });
    await expect(rowLink(page, idea)).toHaveCount(0);
    expect(await countThreadArtifacts([threadId])).toEqual({ threads: 0, runs: 0, messages: 0 });
  });

  test('cancelling keeps the conversation', async ({ page }) => {
    const idea = nextIdea();
    const threadId = await createThread(page, idea);

    const row = rowLink(page, idea);
    await row.hover();
    await page.getByRole('button', { name: `会话操作：${idea}` }).click();
    await page.getByRole('menuitem', { name: '删除会话' }).click();

    const dialog = page.getByRole('dialog', { name: '删除会话？' });
    await dialog.getByRole('button', { name: '取消' }).click();
    await expect(dialog).toHaveCount(0);

    await page.goto('/threads/new');
    await expect(rowLink(page, idea)).toHaveCount(1);
    expect((await countThreadArtifacts([threadId])).threads).toBe(1);
  });
});
