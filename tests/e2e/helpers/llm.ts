import { expect, type APIRequestContext, type Page } from '@playwright/test';

/**
 * UI helpers shared by the settings and chat suites. Every step here is the
 * same one a user takes: open the dialog, pull models, add them to a chain,
 * save. Only the provider's HTTP endpoint is stubbed.
 */

const STUB_PORT = process.env.STUB_PORT ?? '4010';

export const STUB_ORIGIN = `http://127.0.0.1:${STUB_PORT}`;
export const STUB_BASE_URL = `${STUB_ORIGIN}/v1`;

export type StubRequest = {
  method: string;
  path: string;
  headers: Record<string, string>;
  body: unknown;
};

export type ChainProfile = 'bulk' | 'quality';

export async function resetStub(request: APIRequestContext): Promise<void> {
  const response = await request.get(`${STUB_ORIGIN}/__reset`);
  expect(response.ok()).toBeTruthy();
}

export async function stubRequests(request: APIRequestContext): Promise<StubRequest[]> {
  const response = await request.get(`${STUB_ORIGIN}/__requests`);
  expect(response.ok()).toBeTruthy();
  return (await response.json()) as StubRequest[];
}

export type StubProviderConfig = {
  name: string;
  apiKey: string;
  baseUrl?: string;
  headers?: Record<string, string>;
};

/** Fill the provider dialog and wait for the list to show the new row. */
export async function createStubProvider(page: Page, config: StubProviderConfig): Promise<void> {
  await page
    .getByRole('region', { name: 'Providers' })
    .getByRole('button', { name: '添加', exact: true })
    .click();

  const dialog = page.getByRole('dialog', { name: '添加 provider' });
  await dialog.getByLabel('名称').fill(config.name);
  await dialog.getByLabel('类型').selectOption('openai-compatible');
  await dialog.getByLabel('Base URL').fill(config.baseUrl ?? STUB_BASE_URL);
  await dialog.getByLabel('API Key').fill(config.apiKey);
  if (config.headers !== undefined) {
    await dialog.getByLabel('Headers').fill(JSON.stringify(config.headers));
  }

  await dialog.getByRole('button', { name: '添加 provider' }).click();

  await expect(page).toHaveURL(/\/settings\/llm\?provider=\d+$/);
  await expect(page.getByRole('link', { name: new RegExp(`^${config.name}`) })).toBeVisible();
}

/** Pull the stub's two models and assert they reached the model list. */
export async function discoverModels(page: Page, providerName: string): Promise<void> {
  await page.getByRole('button', { name: '拉取模型' }).click();

  const chips = page.getByRole('list', { name: `${providerName} 的模型` });
  await expect(chips.getByText('stub-model-a', { exact: true })).toBeVisible();
  await expect(chips.getByText('stub-model-b', { exact: true })).toBeVisible();
}

/** Append one model to a profile chain (the editor adds at the end). */
export async function addToChain(
  page: Page,
  providerName: string,
  profile: ChainProfile,
  modelId: string,
): Promise<void> {
  const select = page.getByLabel(`从可用模型添加到 ${profile} 链`);
  await select.selectOption({ label: `${providerName} / ${modelId}` });
  await select.locator('..').getByRole('button', { name: '添加', exact: true }).click();
  await expect(page.getByRole('list', { name: `${profile} 链` })).toContainText(modelId);
}

export async function moveUpInChain(
  page: Page,
  providerName: string,
  profile: ChainProfile,
  modelId: string,
): Promise<void> {
  await page.getByRole('button', { name: `将 ${providerName} / ${modelId} 上移` }).click();
}

export async function saveChains(page: Page): Promise<void> {
  await page.getByRole('button', { name: '保存链' }).click();
  await expect(page.getByText('链路已保存，下一次 run 生效')).toBeVisible();
}

export type ProviderChainSetup = StubProviderConfig & {
  /** Models appended to each profile, in the order they are added. */
  bulk: readonly string[];
  quality: readonly string[];
};

/**
 * The whole fixture: navigate to the settings page, create the provider, pull
 * its models, fill both chains (the editor refuses an empty one) and save.
 */
export async function setupProviderWithChains(
  page: Page,
  setup: ProviderChainSetup,
): Promise<void> {
  await page.goto('/settings/llm');
  await createStubProvider(page, setup);
  await discoverModels(page, setup.name);

  for (const modelId of setup.bulk) {
    await addToChain(page, setup.name, 'bulk', modelId);
  }
  for (const modelId of setup.quality) {
    await addToChain(page, setup.name, 'quality', modelId);
  }

  await saveChains(page);
}
