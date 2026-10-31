import { expect, test, type Page } from '@playwright/test';

import {
  closeDb,
  countProviderRows,
  countThreadArtifacts,
  db,
  deleteThreadsWithIdeas,
  purgeProvidersByPrefix,
  storedMessages,
} from './helpers/db';
import { resetStub, setupProviderWithChains, stubRequests, type StubRequest } from './helpers/llm';

/**
 * Chat page end to end: `/threads/new` creates the run and hands over to the
 * conversation, which asks the question on its own. That request goes to the
 * real `/api/chat` route, which reads the quality chain from Postgres and
 * streams from the stubbed provider; `useChat` renders the increments, the run
 * activity card folds the real SSE event log, and the answer is written back so
 * a reload still shows it.
 *
 * Only the provider's network edge is stubbed. The suite names its provider
 * `e2e-chat-*` and deletes every row it created in `afterAll`, so the shared
 * `demandx` database is left as found.
 */

const PROVIDER_NAME = 'e2e-chat';
const PROVIDER_PREFIX = `${PROVIDER_NAME}%`;
const API_KEY = 'sk-e2e-chat-123456';
const IDEA = '帮我验证跨境库存同步工具';
const REPLY = '付费信号只有 1 条有价格页';

/** Thread ids created by this file; `afterAll` deletes their whole idea tree. */
const createdThreadIds: number[] = [];

/** A chat completion the adapter requested as a stream — the only real answer. */
function isStreamingChat(entry: StubRequest): boolean {
  return (
    entry.path === '/v1/chat/completions' &&
    typeof entry.body === 'object' &&
    entry.body !== null &&
    'stream' in entry.body &&
    entry.body.stream === true
  );
}

/** Open a real conversation through `/threads/new` and remember its id. */
async function createThread(page: Page): Promise<number> {
  await page.goto('/threads/new');

  const composer = page.getByLabel('输入消息');
  // The dock animates this card into the thread page, so it is styled once.
  await expect(composer.locator('..')).toHaveClass(/rounded-2xl/);
  await composer.fill(IDEA);
  await composer.press('Enter');

  // The composer docks immediately (520ms FLIP) while the create request runs
  // in parallel, then the thread page takes over.
  await expect(page).toHaveURL(/\/threads\/\d+$/, { timeout: 15_000 });
  const match = /\/threads\/(\d+)$/.exec(page.url());
  if (match?.[1] === undefined) throw new Error(`无法从 URL 解析 thread id: ${page.url()}`);

  // Same card after the hand-off: no radius or padding swap on arrival.
  await expect(page.getByLabel('输入消息').locator('..')).toHaveClass(/rounded-2xl/);

  const threadId = Number(match[1]);
  createdThreadIds.push(threadId);
  return threadId;
}

/**
 * Insert a run and its first two events directly: the worker that normally
 * writes them does not exist yet, and the transcript must still render a real
 * log.
 */
async function seedRun(threadId: number): Promise<number> {
  const client = db();
  const rows = await client<{ id: number }[]>`
    insert into runs (idea_id, thread_id, status, stage)
    select idea_id, id, 'running', 'S1' from threads where id = ${threadId}
    returning id
  `;

  const runId = rows[0]?.id;
  if (runId === undefined) throw new Error(`thread ${threadId} 不存在，无法插入 run`);

  // A message row makes the afterAll cascade assertion meaningful.
  await client`
    insert into messages (thread_id, role, parts)
    values (${threadId}, 'user', ${JSON.stringify([{ type: 'text', text: IDEA }])}::jsonb)
  `;

  await client`
    insert into run_events (run_id, seq, type, payload)
    values
      (${runId}, 1, 'run.created', ${JSON.stringify({ idea: IDEA })}::jsonb),
      (${runId}, 2, 'stage.started', ${JSON.stringify({ stage: 'S1' })}::jsonb)
  `;

  return runId;
}

/**
 * Append the terminal event and flip the run row. The rail and the activity
 * card must pick this up over SSE — the page is never reloaded after this call.
 */
async function finishRun(runId: number): Promise<void> {
  await db().begin(async (tx) => {
    await tx`
      insert into run_events (run_id, seq, type, payload)
      values (${runId}, 3, 'run.finished', ${JSON.stringify({ status: 'finished' })}::jsonb)
    `;
    await tx`
      update runs
      set status = 'finished', stage = 'S1', finished_at = now()
      where id = ${runId}
    `;
  });
}

test.describe('Chat', () => {
  // One shared `demandx` database and one singleton `llm_chains` table, so the
  // tests in this file must not overlap.
  test.describe.configure({ mode: 'serial', timeout: 120_000 });

  test.beforeEach(async ({ page, request }) => {
    await resetStub(request);
    await purgeProvidersByPrefix(PROVIDER_PREFIX);
    await setupProviderWithChains(page, {
      name: PROVIDER_NAME,
      apiKey: API_KEY,
      // Chat reads the quality chain; `bulk` only has to be non-empty to save.
      bulk: ['stub-model-a'],
      quality: ['stub-model-a'],
    });
  });

  test.afterAll(async () => {
    await purgeProvidersByPrefix(PROVIDER_PREFIX);
    await deleteThreadsWithIdeas(createdThreadIds);

    expect(await countProviderRows(PROVIDER_PREFIX)).toEqual({ providers: 0, chainRows: 0 });
    expect(await countThreadArtifacts(createdThreadIds)).toEqual({
      threads: 0,
      runs: 0,
      messages: 0,
    });

    await closeDb();
  });

  test('新建研究后自动出现流式回复，刷新后仍在', async ({ page, request }) => {
    const threadId = await createThread(page);

    // No keystroke and no worker: the thread page asks the question itself.
    const reply = page.locator('article').last();
    await expect(reply).toContainText(REPLY);

    // The stored question is shown once, not once from history plus once sent.
    await expect(page.locator('article').filter({ hasText: IDEA })).toHaveCount(1);

    // Proof the answer was streamed: the adapter asked the stub for SSE.
    expect((await stubRequests(request)).filter(isStreamingChat)).toHaveLength(1);

    // The reply must be in Postgres before the reload, otherwise this asserts
    // nothing about persistence.
    await expect
      .poll(async () => (await storedMessages(threadId)).map((message) => message.role))
      .toEqual(['user', 'assistant']);

    await page.reload();
    await expect(page.locator('article').last()).toContainText(REPLY);
    await expect(page.locator('article').filter({ hasText: IDEA })).toHaveCount(1);
    // A stored answer stops the auto prompt: the reload asks nothing.
    expect((await stubRequests(request)).filter(isStreamingChat)).toHaveLength(1);
  });

  test('流式增量与引用', async ({ page, request }) => {
    const threadId = await createThread(page);

    // The automatic first answer has to be stored, so the reload below seeds the
    // transcript and the composer starts idle.
    await expect.poll(async () => (await storedMessages(threadId)).length).toBe(2);
    await page.reload();
    await expect(page.locator('article').last()).toContainText(REPLY);
    await resetStub(request);

    const composer = page.getByLabel('输入消息');
    await composer.fill(IDEA);
    await composer.press('Enter');

    // The reply is one article; the two chunks arrive as separate increments,
    // so the first must be visible before the second is written.
    const reply = page.locator('article').last();
    await expect(reply).toContainText('先看证据：');
    expect(await reply.innerText()).not.toContain('付费信号');

    await expect(reply).toContainText(REPLY);

    const chip = reply.getByRole('button', { name: '证据 e12' });
    await expect(chip).toBeVisible();
    await chip.click();

    const sheet = page.getByRole('dialog', { name: '证据 e12' });
    await expect(sheet).toContainText('证据 e12 的原文、快照高亮与状态在证据库中查看');
    // A run now starts with the first message, so the evidence page is reachable.
    const openEvidence = sheet.getByRole('link', { name: '打开证据库' });
    await expect(openEvidence).toBeVisible();
    await expect(openEvidence).toHaveAttribute('href', /\/runs\/\d+\/evidence$/);

    expect((await stubRequests(request)).filter(isStreamingChat)).toHaveLength(1);
  });

  test('右栏事件与研究进度', async ({ page }) => {
    const threadId = await createThread(page);
    const runId = await seedRun(threadId);

    // First paint comes from the RSC snapshot of the run log.
    await page.reload();
    const rail = page.getByRole('complementary', { name: '运行详情' });

    await expect(rail.locator('li[aria-current="step"]')).toContainText('S1 采集');
    await expect(rail.getByText('run.created')).toBeVisible();
    await expect(rail.getByText('stage: S1')).toBeVisible();
    await expect(rail.getByText('进行中')).toBeVisible();

    // The same log is told on the assistant side of the transcript.
    const activity = page.getByRole('group', { name: '研究进度' });
    await expect(activity).toContainText('S1 采集');
    await expect(activity).toContainText('进行中');

    // No reload here: only the insert, which both SSE connections poll.
    await finishRun(runId);
    await expect(rail.getByText('已结束')).toBeVisible({ timeout: 1_500 });
    await expect(rail.getByText('已完成')).toBeVisible({ timeout: 1_500 });
    await expect(activity).toHaveCount(0);
    await expect(page.getByText('研究完成', { exact: true })).toBeVisible({ timeout: 1_500 });
  });

  test('输入框增高时，对话底部留出同等距离', async ({ page }) => {
    await createThread(page);

    const metrics = () =>
      page.evaluate(() => {
        const region = document.querySelector('section[aria-label="对话"]');
        if (!region) throw new Error('对话区未渲染');
        const scroll = region.querySelector('div.overflow-y-auto');
        const content = scroll?.firstElementChild;
        const composer = region.querySelector('div.pointer-events-auto');
        if (!scroll || !content || !composer) throw new Error('布局节点缺失');

        return {
          paddingBottom: Number.parseFloat(getComputedStyle(content).paddingBottom),
          composerHeight: composer.getBoundingClientRect().height,
          atBottom: Math.abs(scroll.scrollHeight - scroll.scrollTop - scroll.clientHeight) <= 1,
        };
      });

    const before = await metrics();
    expect(before.composerHeight).toBeGreaterThan(60);
    expect(Math.abs(before.paddingBottom - (before.composerHeight + 16))).toBeLessThanOrEqual(1);
    expect(before.atBottom).toBe(true);

    const textarea = page.getByLabel('输入消息');
    await textarea.fill(Array.from({ length: 6 }, (_, index) => `第 ${index + 1} 行`).join('\n'));

    await expect
      .poll(async () => (await metrics()).paddingBottom)
      .toBeGreaterThan(before.paddingBottom + 40);

    const after = await metrics();
    expect(Math.abs(after.paddingBottom - (after.composerHeight + 16))).toBeLessThanOrEqual(1);
    expect(after.atBottom).toBe(true);
  });
});
