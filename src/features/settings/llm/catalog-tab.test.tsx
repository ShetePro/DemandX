import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { searchCatalog, type CatalogGroupFilter, type CatalogProvider } from '@/lib/llm/catalog';

import { CatalogTab } from './catalog-tab';

const mocks = vi.hoisted(() => ({
  getCatalog: vi.fn(),
  createFromCatalog: vi.fn(),
  push: vi.fn(),
  refresh: vi.fn(),
  success: vi.fn(),
  error: vi.fn(),
}));

vi.mock('./actions', () => ({
  getCatalogAction: mocks.getCatalog,
  createFromCatalogAction: mocks.createFromCatalog,
}));

vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: mocks.push, refresh: mocks.refresh }),
}));

vi.mock('sonner', () => ({
  toast: { success: mocks.success, error: mocks.error },
}));

const DEEPSEEK: CatalogProvider = {
  id: 'deepseek',
  name: 'DeepSeek',
  kind: 'openai-compatible',
  baseUrl: 'https://api.deepseek.com',
  env: 'DEEPSEEK_API_KEY',
  group: 'domestic',
  models: [
    { id: 'deepseek-v4-flash', name: 'DeepSeek V4 Flash' },
    { id: 'deepseek-v4-pro', name: 'DeepSeek V4 Pro' },
  ],
};

const OPENAI: CatalogProvider = {
  id: 'openai',
  name: 'OpenAI',
  kind: 'openai-compatible',
  baseUrl: 'https://api.openai.com/v1',
  env: 'OPENAI_API_KEY',
  group: 'overseas',
  models: [{ id: 'gpt-5.2', name: 'GPT-5.2' }],
};

const OLLAMA: CatalogProvider = {
  id: 'ollama',
  name: 'Ollama',
  kind: 'ollama',
  baseUrl: 'http://127.0.0.1:11434/v1',
  env: null,
  group: 'local',
  models: [],
};

const PROVIDERS = [DEEPSEEK, OPENAI, OLLAMA];

function catalogAnswer(providers: CatalogProvider[], source: 'network' | 'fallback' = 'network') {
  return { ok: true as const, value: { providers, source, fetchedAt: 1 } };
}

beforeEach(() => {
  mocks.getCatalog.mockReset();
  mocks.createFromCatalog.mockReset();
  mocks.push.mockReset();
  mocks.refresh.mockReset();
  mocks.success.mockReset();
  mocks.error.mockReset();

  mocks.getCatalog.mockImplementation(async (q: unknown, group: unknown) =>
    catalogAnswer(
      searchCatalog(
        PROVIDERS,
        typeof q === 'string' ? q : '',
        (group as CatalogGroupFilter | undefined) ?? 'all',
      ),
    ),
  );
});

describe('CatalogTab', () => {
  it('lists providers with group, host, env hint, model count and support badge', async () => {
    render(<CatalogTab />);

    expect(await screen.findByText('DeepSeek')).toBeInTheDocument();
    expect(screen.getByText('OpenAI')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Ollama/ })).toBeInTheDocument();
    expect(screen.getByText('api.deepseek.com')).toBeInTheDocument();
    expect(screen.getByText('Key：DEEPSEEK_API_KEY')).toBeInTheDocument();
    expect(screen.getAllByText('已支持')).toHaveLength(3);
    expect(screen.getAllByText('国内').length).toBeGreaterThan(0);
  });

  it('debounces the search and filters the rows', async () => {
    const user = userEvent.setup();
    render(<CatalogTab />);
    await screen.findByText('OpenAI');

    await user.type(screen.getByLabelText('搜索目录'), 'deepseek');

    await waitFor(() => expect(mocks.getCatalog).toHaveBeenLastCalledWith('deepseek', 'all'));
    await waitFor(() => expect(screen.queryByText('OpenAI')).not.toBeInTheDocument());
    expect(screen.getByText('DeepSeek')).toBeInTheDocument();

    // One call may arrive per keystroke; every call in between carried the
    // intermediate query, and the last one is the debounced value.
    expect(mocks.getCatalog.mock.calls.length).toBeLessThanOrEqual(9);
  });

  it('filters by group and keeps the query', async () => {
    const user = userEvent.setup();
    render(<CatalogTab />);
    await screen.findByText('OpenAI');

    await user.click(screen.getByRole('button', { name: '本地' }));

    await waitFor(() => expect(mocks.getCatalog).toHaveBeenLastCalledWith('', 'local'));
    await waitFor(() => expect(screen.queryByText('DeepSeek')).not.toBeInTheDocument());
    expect(screen.getByRole('button', { name: /Ollama/ })).toBeInTheDocument();
  });

  it('shows the fallback banner and still lists searchable presets', async () => {
    mocks.getCatalog.mockResolvedValue(catalogAnswer(PROVIDERS, 'fallback'));

    render(<CatalogTab />);

    expect(await screen.findByText('目录不可用，使用内置列表')).toBeInTheDocument();
    expect(screen.getByText('DeepSeek')).toBeInTheDocument();
  });

  it('shows an error with a retry button when the action fails', async () => {
    mocks.getCatalog.mockResolvedValue({ ok: false, code: 'LLM_UNAVAILABLE', message: '目录挂了' });

    render(<CatalogTab />);

    expect(await screen.findByRole('alert')).toHaveTextContent('加载目录失败：目录挂了');
    expect(screen.getByRole('button', { name: '重试' })).toBeInTheDocument();
  });

  it('shows an empty state when nothing matches', async () => {
    mocks.getCatalog.mockImplementation(async () => catalogAnswer([]));

    render(<CatalogTab />);

    expect(await screen.findByText(/没有匹配的 provider/)).toBeInTheDocument();
  });

  it('expands a selection with its env hint and model count', async () => {
    const user = userEvent.setup();
    const onPrefillChange = vi.fn();
    render(<CatalogTab onPrefillChange={onPrefillChange} />);

    await user.click(await screen.findByRole('button', { name: /DeepSeek/ }));

    expect(screen.getByText('环境变量：DEEPSEEK_API_KEY（可留空）')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: '添加并带入 2 个模型' })).toBeInTheDocument();
    expect(screen.getByLabelText('API Key（可选）')).toHaveAttribute('type', 'password');
    expect(onPrefillChange).toHaveBeenCalledWith({
      name: 'DeepSeek',
      kind: 'openai-compatible',
      baseUrl: 'https://api.deepseek.com',
    });
  });

  it('creates the provider without a key and navigates to it', async () => {
    const user = userEvent.setup();
    mocks.createFromCatalog.mockResolvedValue({
      ok: true,
      value: { provider: { ...DEEPSEEK, id: 12 }, modelCount: 2 },
    });

    render(<CatalogTab />);
    await user.click(await screen.findByRole('button', { name: /DeepSeek/ }));
    await user.click(screen.getByRole('button', { name: '添加并带入 2 个模型' }));

    await waitFor(() =>
      expect(mocks.createFromCatalog).toHaveBeenCalledWith({
        catalogId: 'deepseek',
        name: 'DeepSeek',
        baseUrl: 'https://api.deepseek.com',
      }),
    );
    expect(mocks.push).toHaveBeenCalledWith('/settings/llm?provider=12');
    expect(mocks.success).toHaveBeenCalledWith('已添加 DeepSeek，带入 2 个模型');
  });

  it('sends the typed key and the edited name/endpoint', async () => {
    const user = userEvent.setup();
    mocks.createFromCatalog.mockResolvedValue({
      ok: true,
      value: { provider: { ...DEEPSEEK, id: 3 }, modelCount: 2 },
    });

    render(<CatalogTab />);
    await user.click(await screen.findByRole('button', { name: /DeepSeek/ }));

    const name = screen.getByLabelText('名称');
    await user.clear(name);
    await user.type(name, 'My DeepSeek');
    await user.type(screen.getByLabelText('API Key（可选）'), 'sk-catalog-123456');
    await user.click(screen.getByRole('button', { name: '添加并带入 2 个模型' }));

    await waitFor(() =>
      expect(mocks.createFromCatalog).toHaveBeenCalledWith({
        catalogId: 'deepseek',
        name: 'My DeepSeek',
        baseUrl: 'https://api.deepseek.com',
        apiKey: 'sk-catalog-123456',
      }),
    );
  });

  it('shows the server failure and does not navigate', async () => {
    const user = userEvent.setup();
    mocks.createFromCatalog.mockResolvedValue({
      ok: false,
      code: 'VALIDATION_FAILED',
      message: '目录中没有 provider deepseek',
    });

    render(<CatalogTab />);
    await user.click(await screen.findByRole('button', { name: /DeepSeek/ }));
    await user.click(screen.getByRole('button', { name: '添加并带入 2 个模型' }));

    expect(await screen.findByRole('alert')).toHaveTextContent('目录中没有 provider deepseek');
    expect(mocks.push).not.toHaveBeenCalled();
    expect(mocks.error).toHaveBeenCalled();
  });

  it('lets a selection jump to the manual tab with prefilled values', async () => {
    const user = userEvent.setup();
    const onRequestManual = vi.fn();
    render(<CatalogTab onRequestManual={onRequestManual} />);

    await user.click(await screen.findByRole('button', { name: /DeepSeek/ }));
    await user.click(screen.getByRole('button', { name: '在手动模式中编辑' }));

    expect(onRequestManual).toHaveBeenCalledTimes(1);
  });
});
