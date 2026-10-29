import { expect, test, type APIRequestContext, type Page } from '@playwright/test';
import fs from 'node:fs';
import path from 'node:path';
import postgres from 'postgres';

/**
 * Settings page end to end: the browser drives the real UI, which calls real
 * Server Actions that write to Postgres and (for discovery and the connection
 * probe) reach exactly one stubbed network edge. Nothing inside the page is
 * mocked, so a broken action, schema or adapter shows up here.
 *
 * Every row this file creates is named `e2e-*` and is removed again by SQL in
 * `beforeEach` / `afterAll`, so the shared `demandx` database is left as found.
 */

const STUB_ORIGIN = `http://127.0.0.1:${process.env.STUB_PORT ?? '4010'}`;
const PROVIDER_NAME = 'e2e-stub';
const API_KEY = 'sk-e2e-123456789';
const MARKER_HEADER = 'x-e2e-marker';
const MARKER_VALUE = 'settings-e2e';
const PROVIDER_BASE_URL = `${STUB_ORIGIN}/v1`;

type StubRequest = {
  method: string;
  path: string;
  headers: Record<string, string>;
  body: unknown;
};

let sql: postgres.Sql | null = null;

function databaseUrl(): string {
  const configured = process.env.DATABASE_URL?.trim();
  if (configured) return configured;

  const envFile = path.join(process.cwd(), '.env');
  const line = fs
    .readFileSync(envFile, 'utf8')
    .split(/\r?\n/)
    .find((entry) => entry.trimStart().startsWith('DATABASE_URL='));

  if (line) {
    const value = line
      .slice(line.indexOf('=') + 1)
      .trim()
      .replace(/^["']|["']$/g, '');
    if (value !== '') return value;
  }

  throw new Error('DATABASE_URL 未配置：请准备 .env（参考 .env.example）后重试');
}

function db(): postgres.Sql {
  if (sql === null) sql = postgres(databaseUrl(), { max: 1 });
  return sql;
}

/**
 * Chain rows first: `llm_chains.provider_id` is ON DELETE RESTRICT, so a
 * provider that is still referenced cannot be removed before its rows are.
 */
async function purgeE2eProviders(): Promise<number> {
  const client = db();
  await client`
    delete from llm_chains
    where provider_id in (select id from providers where name like 'e2e-%')
  `;
  const removed = await client`delete from providers where name like 'e2e-%' returning id`;
  return removed.length;
}

async function countE2eRows(): Promise<{ providers: number; chainRows: number }> {
  const client = db();
  const providerRows = await client<{ count: number }[]>`
    select count(*)::int as count from providers where name like 'e2e-%'
  `;
  const chainRows = await client<{ count: number }[]>`
    select count(*)::int as count
    from llm_chains
    where provider_id in (select id from providers where name like 'e2e-%')
  `;
  return {
    providers: providerRows[0]?.count ?? -1,
    chainRows: chainRows[0]?.count ?? -1,
  };
}

async function resetStub(request: APIRequestContext): Promise<void> {
  const response = await request.get(`${STUB_ORIGIN}/__reset`);
  expect(response.ok()).toBeTruthy();
}

async function stubRequests(request: APIRequestContext): Promise<StubRequest[]> {
  const response = await request.get(`${STUB_ORIGIN}/__requests`);
  expect(response.ok()).toBeTruthy();
  return (await response.json()) as StubRequest[];
}

async function createStubProvider(page: Page): Promise<void> {
  await page
    .getByRole('region', { name: 'Providers' })
    .getByRole('button', { name: '添加', exact: true })
    .click();

  const dialog = page.getByRole('dialog', { name: '添加 provider' });
  await dialog.getByLabel('名称').fill(PROVIDER_NAME);
  await dialog.getByLabel('类型').selectOption('openai-compatible');
  await dialog.getByLabel('Base URL').fill(PROVIDER_BASE_URL);
  await dialog.getByLabel('API Key').fill(API_KEY);
  await dialog.getByLabel('Headers').fill(JSON.stringify({ [MARKER_HEADER]: MARKER_VALUE }));

  await dialog.getByRole('button', { name: '添加 provider' }).click();

  await expect(page).toHaveURL(/\/settings\/llm\?provider=\d+$/);
  await expect(page.getByRole('link', { name: new RegExp(`^${PROVIDER_NAME}`) })).toBeVisible();
}

async function discoverModels(page: Page): Promise<void> {
  await page.getByRole('button', { name: '拉取模型' }).click();

  const chips = page.getByRole('list', { name: `${PROVIDER_NAME} 的模型` });
  await expect(chips.getByText('stub-model-a', { exact: true })).toBeVisible();
  await expect(chips.getByText('stub-model-b', { exact: true })).toBeVisible();
}

async function addToChain(page: Page, profile: 'bulk' | 'quality', modelId: string): Promise<void> {
  const select = page.getByLabel(`从可用模型添加到 ${profile} 链`);
  await select.selectOption({ label: `${PROVIDER_NAME} / ${modelId}` });
  await select.locator('..').getByRole('button', { name: '添加', exact: true }).click();
  await expect(page.getByRole('list', { name: `${profile} 链` })).toContainText(modelId);
}

/** Both profiles must be non-empty, so `quality` gets a model as well. */
async function saveStubChains(page: Page): Promise<void> {
  await addToChain(page, 'bulk', 'stub-model-a');
  await addToChain(page, 'bulk', 'stub-model-b');
  await page.getByRole('button', { name: `将 ${PROVIDER_NAME} / stub-model-b 上移` }).click();
  await addToChain(page, 'quality', 'stub-model-a');

  await page.getByRole('button', { name: '保存链' }).click();
  await expect(page.getByText('链路已保存，下一次 run 生效')).toBeVisible();
}

test.describe('LLM settings', () => {
  // Every test writes to the same `demandx` database and cleans it up by name,
  // so they must not overlap (the config runs files in parallel, not tests
  // within this one).
  test.describe.configure({ mode: 'serial', timeout: 120_000 });

  test.beforeEach(async ({ page, request }) => {
    await resetStub(request);
    await purgeE2eProviders();
    await page.goto('/settings/llm');
  });

  test.afterAll(async () => {
    await purgeE2eProviders();
    const counts = await countE2eRows();
    expect(counts).toEqual({ providers: 0, chainRows: 0 });

    await sql?.end({ timeout: 5 });
    sql = null;
  });

  test('新增并测试连接', async ({ page, request }) => {
    await createStubProvider(page);
    await discoverModels(page);

    await page.getByRole('button', { name: `测试 ${PROVIDER_NAME}` }).click();
    await expect(page.getByRole('status')).toHaveText(/^200 · \d+ ms · stub-model-a$/);

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
    await createStubProvider(page);
    await discoverModels(page);
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
    await createStubProvider(page);
    await discoverModels(page);
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
});
