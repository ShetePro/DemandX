import { expect, test, type Page } from '@playwright/test';

import { closeDb, countProviderRows, purgeProvidersByPrefix } from './helpers/db';
import {
  STUB_ORIGIN,
  addToChain,
  createStubProvider,
  discoverModels,
  moveUpInChain,
  resetStub,
  saveChains,
  stubRequests,
} from './helpers/llm';

/**
 * Settings page end to end: the browser drives the real UI, which calls real
 * Server Actions that write to Postgres and (for discovery and the connection
 * probe) reach exactly one stubbed network edge. Nothing inside the page is
 * mocked, so a broken action, schema or adapter shows up here.
 *
 * Every row this file creates is named `e2e-stub-*` and is removed again by SQL
 * in `beforeEach` / `afterAll`, so the shared `demandx` database is left as
 * found.
 */

const PROVIDER_NAME = 'e2e-stub';
const PROVIDER_PREFIX = `${PROVIDER_NAME}%`;
const API_KEY = 'sk-e2e-123456789';
const MARKER_HEADER = 'x-e2e-marker';
const MARKER_VALUE = 'settings-e2e';
const PROVIDER_BASE_URL = `${STUB_ORIGIN}/v1`;

/** Both profiles must be non-empty, so `quality` gets a model as well. */
async function saveStubChains(page: Page): Promise<void> {
  await addToChain(page, PROVIDER_NAME, 'bulk', 'stub-model-a');
  await addToChain(page, PROVIDER_NAME, 'bulk', 'stub-model-b');
  await moveUpInChain(page, PROVIDER_NAME, 'bulk', 'stub-model-b');
  await addToChain(page, PROVIDER_NAME, 'quality', 'stub-model-a');

  await saveChains(page);
}

test.describe('LLM settings', () => {
  // Every test writes to the same `demandx` database and cleans it up by name,
  // so they must not overlap (the config runs files in parallel, not tests
  // within this one).
  test.describe.configure({ mode: 'serial', timeout: 120_000 });

  test.beforeEach(async ({ page, request }) => {
    await resetStub(request);
    await purgeProvidersByPrefix(PROVIDER_PREFIX);
    await page.goto('/settings/llm');
  });

  test.afterAll(async () => {
    await purgeProvidersByPrefix(PROVIDER_PREFIX);
    const counts = await countProviderRows(PROVIDER_PREFIX);
    expect(counts).toEqual({ providers: 0, chainRows: 0 });

    await closeDb();
  });

  test('新增并测试连接', async ({ page, request }) => {
    await createStubProvider(page, {
      name: PROVIDER_NAME,
      apiKey: API_KEY,
      baseUrl: PROVIDER_BASE_URL,
      headers: { [MARKER_HEADER]: MARKER_VALUE },
    });
    await discoverModels(page, PROVIDER_NAME);

    await page.getByRole('button', { name: `测试 ${PROVIDER_NAME}` }).click();
    // The settings page also has a role=status notice for empty chains, so the
    // probe result is read inside its own panel.
    await expect(page.getByRole('region', { name: '测试连接' }).getByRole('status')).toHaveText(
      /^200 · \d+ ms · stub-model-a$/,
    );

    // The probe and the discovery call left the browser via the adapter, so the
    // stub saw the encrypted key's plaintext and the provider's custom header.
    const requests = await stubRequests(request);

    const discovery = requests.find((entry) => entry.path === '/v1/models');
    expect(discovery?.headers.authorization).toBe(`Bearer ${API_KEY}`);
    expect(discovery?.headers[MARKER_HEADER]).toBe(MARKER_VALUE);

    const probe = requests.at(-1);
    expect(probe?.path).toBe('/v1/chat/completions');
    expect(probe?.headers.authorization).toBe(`Bearer ${API_KEY}`);
    expect(probe?.headers[MARKER_HEADER]).toBe(MARKER_VALUE);
  });

  test('链保存', async ({ page }) => {
    await createStubProvider(page, {
      name: PROVIDER_NAME,
      apiKey: API_KEY,
      baseUrl: PROVIDER_BASE_URL,
    });
    await discoverModels(page, PROVIDER_NAME);
    await saveStubChains(page);

    await page.reload();

    const bulk = page.getByRole('list', { name: 'bulk 链' });
    await expect(bulk.getByRole('listitem')).toHaveText([
      `${PROVIDER_NAME} / stub-model-b`,
      `${PROVIDER_NAME} / stub-model-a`,
    ]);
    await expect(page.getByRole('list', { name: 'quality 链' })).toContainText(
      `${PROVIDER_NAME} / stub-model-a`,
    );
  });

  test('删除保护', async ({ page }) => {
    await createStubProvider(page, {
      name: PROVIDER_NAME,
      apiKey: API_KEY,
      baseUrl: PROVIDER_BASE_URL,
    });
    await discoverModels(page, PROVIDER_NAME);
    await saveStubChains(page);

    await page.getByRole('button', { name: '删除', exact: true }).click();
    const dialog = page.getByRole('dialog', { name: new RegExp(`^删除 ${PROVIDER_NAME}`) });
    await dialog.getByRole('button', { name: '确认删除' }).click();

    await expect(dialog.getByRole('alert')).toContainText(/bulk#\d+/);
    await expect(dialog.getByRole('alert')).toContainText(/quality#\d+/);

    await page.keyboard.press('Escape');
    await expect(dialog).toBeHidden();
    await expect(page.getByRole('link', { name: new RegExp(`^${PROVIDER_NAME}`) })).toBeVisible();
  });

  test('侧边栏入口', async ({ page }) => {
    await page.goto('/');
    await page.getByRole('link', { name: 'LLM 与采集' }).click();
    await expect(page).toHaveURL(/\/settings\/llm$/);
  });

  test('陈旧 provider id 会被纠正', async ({ page }) => {
    await page.goto('/settings/llm?provider=999999');

    await expect(page).toHaveURL(/\/settings\/llm(\?provider=\d+)?$/);
    await expect(page).not.toHaveURL(/provider=999999/);
  });

  test('一键加入链', async ({ page }) => {
    await createStubProvider(page, {
      name: PROVIDER_NAME,
      apiKey: API_KEY,
      baseUrl: PROVIDER_BASE_URL,
    });
    await discoverModels(page, PROVIDER_NAME);

    // First click: bulk is empty, so this alone must persist a usable chain.
    await page.getByRole('button', { name: '把 stub-model-a 加入链' }).click();
    await page.getByRole('menuitem', { name: '把 stub-model-a 加入 bulk 链' }).click();
    await expect(page.getByText('已加入 bulk 链 #1')).toBeVisible();
    await expect(page.getByRole('list', { name: 'bulk 链' })).toContainText(
      `${PROVIDER_NAME} / stub-model-a`,
    );

    await page.getByRole('button', { name: '把 stub-model-b 加入链' }).click();
    await page.getByRole('menuitem', { name: '把 stub-model-b 加入 quality 链' }).click();
    await expect(page.getByText('已加入 quality 链 #1')).toBeVisible();
    await expect(page.getByRole('list', { name: 'quality 链' })).toContainText(
      `${PROVIDER_NAME} / stub-model-b`,
    );

    // Membership is now visible to the menu, so the same entry cannot repeat.
    await page.getByRole('button', { name: '把 stub-model-b 加入链' }).click();
    await expect(
      page.getByRole('menuitem', { name: '把 stub-model-b 加入 quality 链' }),
    ).toBeDisabled();
    await page.keyboard.press('Escape');

    await page.reload();
    await expect(page.getByRole('list', { name: 'bulk 链' })).toContainText('stub-model-a');
    await expect(page.getByRole('list', { name: 'quality 链' })).toContainText('stub-model-b');
  });
});
