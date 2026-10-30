# DemandX 构建实施计划（P0–P7）

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 从空仓库构建一个本地运行、零边际成本的市场研究 Agent 工作台：聊天发起研究 → 采集并留存证据 → 抽取与引文校验 → 代码评分 → 八部分可追溯报告。

**Architecture:** Next.js 16 App Router 单应用 + 本地 Postgres + pg-boss worker。读走 RSC 直连 Drizzle，写走 Server Actions，实时进度走 `run_events` 表的 SSE 续传；推理通过 `LlmPort` + 数据库里的 `llm_chains` 二级路由（本地 Ollama 承担批量，云端可选承担合成）。

**Tech Stack:** Next 16.4.3 / React 19.3.1 / TS 5.6 strict / Tailwind 4.3.3 / shadcn(radix-ui 1.6.1) / ai 7.0.156 + @ai-sdk/react 4.0.16 / streamdown 2.7.1 / Drizzle 0.45.4 + postgres 3.4.9 / pg-boss 12.38 / zod 4.6.7 / vitest 5.0.5 / Playwright 1.64.1。

**依据：** `docs/superpowers/specs/2026-10-29-demandx-design.md`（数据与规则）、`...-ui-design.md`（页面与依赖）、`docs/design/prototype/`（视觉基准）。

---

## 0. 工程规范（所有任务都必须遵守）

### 0.1 依赖方向（强约束）

```
app/**            只做路由、数据装配、metadata
  └── features/** 业务组件与 actions（按领域分目录，彼此不可互相 import）
        └── components/ui/** 无业务原语（Button/Card/Sheet…）
              └── lib/**  纯函数、端口、DB、hooks（不 import React 组件）
```

- 反向 import 一律禁止；跨 feature 复用要下沉到 `components/` 或 `lib/`。
- 跨域调用只允许发生在 `lib/`（如 `lib/evidence` 被 `features/report` 使用）。
- 由 `eslint-plugin-boundaries` 在 CI 中强制，见 T0.2。

### 0.2 主题与颜色（可执行规则）

- **禁止**在 `tsx/css` 里写 `#rrggbb`、`rgb()`、`hsl()` 字面量（`globals.css` 的 token 定义除外）。
- 只允许语义 token：`bg-surface`、`text-fg`、`text-muted`、`border-border`、`bg-accent`、`text-success`…
- 动态值只能用 CSS 变量内联：`style={{ '--w': `${pct}%` }}`，不允许拼颜色。
- 暗色模式由 `data-theme="dark"` 提供第二套 token；组件里**不出现** `dark:` 前缀（token 已切换），只在需要不同结构时才用。
- 违反由 ESLint `no-restricted-syntax` + `scripts/check-tokens.mjs` 双重拦截。

### 0.3 React / Hook 规范

- 组件默认 Server Component；文件首行加 `'use client'` 必须能在注释里说清“为什么需要浏览器”。
- 任何带状态/副作用/事件监听的逻辑抽到 `lib/hooks/use-*.ts`，组件只做编排；hook 必须有单测（`renderHook`）。
- Props 用 `type XxxProps = { ... }`，禁止 `React.FC`；`children` 用 `ReactNode`。
- 不用 `any`；外部数据一律 `unknown` → zod 解析。
- 事件处理命名 `handleXxx`，props 回调命名 `onXxx`。
- 列表 `key` 用稳定业务 id，禁止 index。
- 图标按钮必须有 `aria-label`；可交互元素必须可 Tab 聚焦并显示 `:focus-visible`。

### 0.4 数据与错误规范

- 所有外部输入（DB 读出、LLM 输出、HTTP body）经 zod 校验后才进入类型系统。
- 可失败操作返回 `Result<T, AppError>`，不靠 `throw` 控制流程；`AppError` 带 `code`（`LLM_UNAVAILABLE` / `QUOTA_EXCEEDED` / `QUOTE_MISMATCH`…）。
- 服务端日志只记 `code`、`provider`、`runId`；**永不**记录 API Key、完整 prompt、证据原文。
- Server Action 必须 `'use server'` 且以 `parse(input)` 开头。

### 0.5 样式与组件规范

- `components/ui/*`：只接受 token 类名，不写业务文案；变体用 CVA。
- `features/*`：允许业务文案与数据，但不直接读 DB（由 page 传入 props）。
- 间距使用 4 的倍数（`p-4`/`gap-2`），圆角只用 `rounded-lg`(8) / `rounded-xl`(12) / `rounded-2xl`(16)。
- 动画只允许 CSS transition/keyframes，统一 150–320ms，必须包在 `prefers-reduced-motion` 内。

### 0.6 测试与提交规范

- 纯函数（评分、闸门、去重、决策）：100% 行覆盖，表驱动测试。
- Hook：`renderHook` + 假定时器；组件：测行为（可见文本、ARIA、回调），禁止快照。
- 每个任务 = 一次 commit，Conventional Commits（`feat(chat): ...`）。

---

## 1. 任务总览

| 阶段 | 任务 | 交付 | 验收 | 天 |
|---|---|---|---|---|
| P0 | T0.1–T0.9 | 骨架、token、主题、UI 原语、hooks、外壳、DB、测试基建 | `pnpm verify` 全绿，首页可跑 | 2 |
| P1 | T1.1–T1.6 | 加密、provider 表、LlmPort 链、配置页、连通性测试 | 页面配置 Ollama → 下一次 run 生效 | 4 |
| P2 | T2.1–T2.6 | SSE 骨架、useRunStream、消息 parts、Chat 页 | 对话触发 run，断线续传不丢事件 | 3 |
| P3 | T3.1–T3.7 | 去重、快照、搜索/抓取适配器、配额、S1、采集设置 | 单 run ≥30 条带快照 source | 5 |
| P4 | T4.1–T4.5 | Evidence schema、quote gate、抽取、评估、证据库 | 篡改引文 100% 拒绝；召回 ≥60% | 4 |
| P5 | T5.1–T5.5 | 聚合、rubric、可信度、决策、聚类 | 评分单测全绿，总分 ≤100 | 3 |
| P6 | T6.1–T6.4 | 报告装配、报告页、导出、E2E | 无引用论断被拦下 | 4 |
| P7 | T7.1–T7.4 | 验证工作流、运行监控、降级、文档 | 真实方向跑完并给出决策 | 3 |

---

## P0 基础（2 天）

**执行顺序调整（2026-10-30）**：T0.8（测试基建）先于 T0.3–T0.5 执行，否则 hook 与组件测试没有运行环境；其余顺序不变。

**P0 状态：已完成（2026-10-30）** — 9/9 任务；`pnpm verify` 绿（76 单测）、`pnpm e2e` 绿、`next build` 通过；工作台页在 1440/390 两种宽度实测。

**P1 状态：已完成（2026-10-30）** — 6/6 任务；密钥箱、provider 仓储、LlmPort、配置 actions、配置页 UI、settings E2E。`/settings/llm` 已可用。

**P2 状态：已完成（2026-10-30）** — 6/6 任务；run 事件与 SSE、`useRunStream`、`/api/chat`、对话页与右栏、Composer、Chat E2E。

**P3 状态：已完成（2026-10-30）** — 7/7 任务；采集基座与 S1（真实 run 落库 sources、终态回写）、`/settings/crawl`。

**P4 状态：已完成（2026-10-30）** — 5/5 任务，另加 S2 接线；Evidence schema/提示词、quote gate（仅精确+空白归一化，NFKC offset 映射）、S2 抽取（拒绝原因落库、失败策略、拒绝率告警）、`eval-extract`（12 页标注 + dry 模式）、证据库页（筛选/高亮/人工确认与复验恢复）、worker 现在真实跑 S1→S2。`docs/eval.md` 如实记录样本与未测项。

### T0.1 初始化工程与脚本

**Files:** `package.json`、`tsconfig.json`、`next.config.ts`、`src/app/layout.tsx`、`src/app/page.tsx`、`.gitignore`、`.env.example`

- [ ] **Step 1: 写 `package.json`**

```json
{
  "name": "demandx",
  "private": true,
  "packageManager": "pnpm@9.12.2",
  "engines": { "node": ">=22" },
  "scripts": {
    "dev": "next dev",
    "build": "next build",
    "start": "next start",
    "typecheck": "tsc --noEmit",
    "lint": "eslint . --max-warnings 0",
    "format": "prettier --write .",
    "test": "vitest run",
    "test:watch": "vitest",
    "e2e": "playwright test",
    "db:generate": "drizzle-kit generate",
    "db:migrate": "tsx src/lib/db/migrate.ts",
    "db:studio": "drizzle-kit studio",
    "verify": "pnpm typecheck && pnpm lint && pnpm test",
    "tokens:check": "node scripts/check-tokens.mjs"
  },
  "dependencies": {
    "next": "16.4.3", "react": "19.3.1", "react-dom": "19.3.1",
    "ai": "7.0.156", "@ai-sdk/react": "4.0.16", "@ai-sdk/openai-compatible": "^2.0.0",
    "streamdown": "2.7.1", "@streamdown/cjk": "^1.0.3", "@streamdown/code": "^1.0.3",
    "use-stick-to-bottom": "^1.1.6",
    "drizzle-orm": "0.45.4", "postgres": "^3.4.9",
    "pg-boss": "12.38.0",
    "zod": "4.6.7",
    "react-hook-form": "7.91.0", "@hookform/resolvers": "6.0.2",
    "@tanstack/react-table": "9.3.1", "@tanstack/react-virtual": "3.14.24",
    "recharts": "3.10.1",
    "@dnd-kit/core": "6.3.1", "@dnd-kit/sortable": "10.0.0",
    "nuqs": "2.10.2", "next-themes": "0.4.6",
    "sonner": "2.0.8", "cmdk": "1.1.1",
    "lucide-react": "1.64.0", "date-fns": "4.4.0",
    "clsx": "2.1.1", "tailwind-merge": "3.7.0", "class-variance-authority": "0.7.1",
    "radix-ui": "^1.6.1",
    "undici": "^7.0.0", "@mozilla/readability": "^0.6.0", "cheerio": "^1.0.0",
    "p-limit": "^6.1.0"
  },
  "devDependencies": {
    "typescript": "^5.6.3", "@types/node": "^22.10.0", "@types/react": "^19.0.0",
    "tailwindcss": "4.3.3", "@tailwindcss/postcss": "^4.3.2", "@tailwindcss/typography": "^0.5.20",
    "drizzle-kit": "0.31.11", "tsx": "^4.19.0",
    "vitest": "5.0.5", "@vitejs/plugin-react": "^5.0.0", "jsdom": "^26.0.0",
    "@testing-library/react": "16.3.3", "@testing-library/user-event": "14.6.8",
    "@playwright/test": "1.64.1",
    "eslint": "^9.20.0", "eslint-config-next": "16.4.3", "typescript-eslint": "^8.24.0",
    "eslint-plugin-boundaries": "^5.0.0", "eslint-plugin-jsx-a11y": "^6.10.0",
    "prettier": "^3.4.0", "prettier-plugin-tailwindcss": "^0.6.11"
  }
}
```

- [ ] **Step 2: `tsconfig.json`（strict + 路径别名）**

```json
{
  "compilerOptions": {
    "target": "ES2022", "lib": ["dom", "dom.iterable", "ES2022"],
    "strict": true, "noUncheckedIndexedAccess": true, "exactOptionalPropertyTypes": true,
    "noImplicitOverride": true, "noFallthroughCasesInSwitch": true,
    "module": "esnext", "moduleResolution": "bundler", "jsx": "preserve",
    "plugins": [{ "name": "next" }], "paths": { "@/*": ["./src/*"] },
    "skipLibCheck": true, "noEmit": true, "incremental": true
  },
  "include": ["next-env.d.ts", "**/*.ts", "**/*.tsx", ".next/types/**/*.ts"],
  "exclude": ["node_modules"]
}
```

- [ ] **Step 3: `.env.example`（不含任何密钥）**

```bash
DATABASE_URL=postgres://demandx:demandx@127.0.0.1:5432/demandx
OLLAMA_BASE_URL=http://127.0.0.1:11434
DEMANDX_SECRET_FILE=~/.demandx/secret.key
CRAWL_ENABLED=true
CRAWL_RESPECT_ROBOTS=true
SNAPSHOT_DIR=./data/snapshots
```

- [ ] **Step 4: 安装并跑通**

Run: `pnpm install && pnpm dev`
Expected: 3000 端口返回 Next 默认页；`pnpm typecheck` 无错。`src/app/page.tsx` 此时只是占位，T0.6 会把它迁入 `(workbench)` 路由组并删除。

- [ ] **Step 5: Commit**

```bash
git add package.json pnpm-lock.yaml tsconfig.json next.config.ts src .env.example .gitignore
git commit -m "chore: scaffold next app with strict ts and scripts"
```

### T0.2 设计 token 与主题（核心规范落地点）

**Files:** `src/app/globals.css`、`scripts/check-tokens.mjs`、`eslint.config.mjs`、`postcss.config.mjs`

- [ ] **Step 1: 写 token（Tailwind 4 CSS-first）**

```css
@import "tailwindcss";
@plugin "@tailwindcss/typography";

@theme inline {
  --color-bg: var(--bg);
  --color-surface: var(--panel);
  --color-surface-2: var(--panel-2);
  --color-fg: var(--fg);
  --color-muted: var(--muted);
  --color-faint: var(--faint);
  --color-border: var(--border);
  --color-border-strong: var(--border-strong);
  --color-accent: var(--accent);
  --color-accent-soft: var(--accent-soft);
  --color-success: var(--success);
  --color-success-soft: var(--success-soft);
  --color-warning: var(--warning);
  --color-warning-soft: var(--warning-soft);
  --color-danger: var(--error);
  --color-danger-soft: var(--error-soft);
  --color-s1: var(--c1);
  --color-s2: var(--c2);
  --color-s3: var(--c3);
  --color-s4: var(--c4);
  --radius-lg: 8px;
  --radius-xl: 12px;
  --radius-2xl: 16px;
}

:root {
  --bg: #f6f7f9; --panel: #ffffff; --panel-2: #fbfbfc;
  --fg: #101114; --muted: #6b7280; --faint: #9ca3af;
  --border: #e6e7eb; --border-strong: #d8dae0;
  --accent: #4f46e5; --accent-soft: #eef0ff;
  --success: #059669; --success-soft: #ecfdf5;
  --warning: #b45309; --warning-soft: #fffbeb;
  --error: #dc2626; --error-soft: #fef2f2;
  --c1: #0284c7; --c2: #7c3aed; --c3: #0d9488; --c4: #db2777;
}

[data-theme="dark"] {
  --bg: #0c0d10; --panel: #14161a; --panel-2: #191c21;
  --fg: #f3f4f6; --muted: #9aa0aa; --faint: #6b7280;
  --border: #24272e; --border-strong: #333842;
  --accent: #8b8cf7; --accent-soft: #1e1f3a;
  --success: #34d399; --success-soft: #0f2a22;
  --warning: #fbbf24; --warning-soft: #2a2313;
  --error: #f87171; --error-soft: #2c1414;
  --c1: #38bdf8; --c2: #a78bfa; --c3: #2dd4bf; --c4: #f472b6;
}

body { background: var(--bg); color: var(--fg); }
```

- [ ] **Step 2: 禁止硬编码颜色的检查脚本**

`scripts/check-tokens.mjs` 扫描 `src/**/*.{ts,tsx}`，命中 `#[0-9a-fA-F]{3,8}`、`rgb(`、`hsl(` 即失败（允许 `className` 里的 CSS 变量名与 `data:` URL）。退出码 1，输出文件与行号。

- [ ] **Step 3: ESLint 边界与颜色规则**

```js
// eslint.config.mjs（要点）
import boundaries from 'eslint-plugin-boundaries';
export default [
  { ignores: ['.next/**', 'docs/**', 'drizzle/**'] },
  {
    plugins: { boundaries },
    settings: {
      'boundaries/elements': [
        { type: 'app', pattern: 'src/app/**' },
        { type: 'feature', pattern: 'src/features/*/**', capture: ['feature'] },
        { type: 'ui', pattern: 'src/components/ui/**' },
        { type: 'lib', pattern: 'src/lib/**' }
      ]
    },
    rules: {
      'boundaries/element-types': ['error', {
        default: 'disallow',
        rules: [
          { from: 'app', allow: ['feature', 'ui', 'lib'] },
          { from: 'feature', allow: ['ui', 'lib'], disallow: [['feature', { feature: '!${from.feature}' }]] },
          { from: 'ui', allow: ['lib'] },
          { from: 'lib', allow: ['lib'] }
        ]
      }],
      'no-restricted-syntax': ['error', {
        selector: "Literal[value=/#[0-9a-fA-F]{3,8}/]",
        message: '禁止硬编码颜色，请使用语义 token（bg-surface / text-fg / border-border…）'
      }]
    }
  }
];
```

- [ ] **Step 4: 验证**

Run: `pnpm tokens:check && pnpm lint`
Expected: 通过；临时在任一 tsx 写 `bg-[#fff]` 必须报错。

- [ ] **Step 5: Commit** — `feat(theme): semantic design tokens with enforced boundaries`

### T0.3 主题 Provider 与 Hook

**Files:** `src/components/theme-provider.tsx`、`src/lib/hooks/use-theme.ts`、`src/components/ui/theme-toggle.tsx`、`src/lib/hooks/use-theme.test.tsx`

- [ ] **Step 1: 写 `ThemeProvider`**

```tsx
'use client';
import { ThemeProvider as NextThemes } from 'next-themes';
export function ThemeProvider({ children }: { children: React.ReactNode }) {
  return (
    <NextThemes attribute="data-theme" defaultTheme="system" enableSystem disableTransitionOnChange>
      {children}
    </NextThemes>
  );
}
```

- [ ] **Step 2: 封装 hook（组件不直接引 next-themes）**

```ts
// src/lib/hooks/use-theme.ts
'use client';
import { useTheme as useNextTheme } from 'next-themes';
export type ThemeMode = 'light' | 'dark' | 'system';
export function useTheme() {
  const { theme, resolvedTheme, setTheme } = useNextTheme();
  return {
    theme: (theme ?? 'system') as ThemeMode,
    resolved: resolvedTheme === 'dark' ? 'dark' : 'light',
    setTheme,
    toggle: () => setTheme(resolvedTheme === 'dark' ? 'light' : 'dark')
  };
}
```

- [ ] **Step 3: `ThemeToggle`（首帧前不渲染图标，避免水合不一致）**

```tsx
'use client';
const [mounted, setMounted] = useState(false);
useEffect(() => setMounted(true), []);
if (!mounted) return <div className="size-8" aria-hidden />;
```

- [ ] **Step 4: 测试**

`renderHook(useTheme)`：默认解析为 `light`；调用 `toggle()` 后 `document.documentElement.dataset.theme === 'dark'`。

Run: `pnpm vitest run src/lib/hooks/use-theme.test.tsx`
Expected: PASS。

- [ ] **Step 5: Commit** — `feat(theme): provider and useTheme hook`

### T0.4 UI 原语（无业务）

**Files:** `src/components/ui/{button,card,badge,input,textarea,sheet,dialog,tooltip,skeleton,progress,separator}.tsx`、`src/lib/utils/cn.ts`

- [ ] **Step 1: `cn`**

```ts
import { clsx, type ClassValue } from 'clsx';
import { twMerge } from 'tailwind-merge';
export const cn = (...inputs: ClassValue[]) => twMerge(clsx(inputs));
```

- [ ] **Step 2: `Button` 用 CVA，颜色只走 token**

```tsx
const styles = cva(
  'inline-flex items-center justify-center gap-2 rounded-lg text-sm font-medium transition-colors focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent disabled:opacity-50 disabled:pointer-events-none',
  {
    variants: {
      variant: {
        primary: 'bg-accent text-white hover:brightness-110',
        ghost: 'bg-transparent border border-border text-muted hover:text-fg hover:bg-surface-2',
        danger: 'bg-danger-soft text-danger border border-danger/40'
      },
      size: { sm: 'h-8 px-3', md: 'h-9 px-4', icon: 'size-9 p-0' }
    },
    defaultVariants: { variant: 'primary', size: 'md' }
  }
);
```

- [ ] **Step 3: `Sheet` 基于 `radix-ui` 统一包**，动效 `data-[state=open]:slide-in-from-right`，`prefers-reduced-motion` 下禁用位移。

- [ ] **Step 4: 验收**

Run: `pnpm test` + 在页面渲染 `<Button variant="ghost">`，切换暗色后颜色随 token 变化，无硬编码。`SignalBadge` / `GradeBadge` 属于业务语义组件，放在 T0.9 创建于 `src/components/common/`。

- [ ] **Step 5: Commit** — `feat(ui): token-based primitives`

### T0.5 Hook 库

**Files:** `src/lib/hooks/{use-media-query,use-hotkeys,use-copy,use-local-storage,use-debounced-value}.ts` + 同名 `.test.ts(x)`

- [ ] **Step 1: `useMediaQuery`（SSR 安全）**

```ts
export function useMediaQuery(query: string) {
  const [matches, setMatches] = useState(false);
  useEffect(() => {
    const mql = window.matchMedia(query);
    const onChange = () => setMatches(mql.matches);
    onChange();
    mql.addEventListener('change', onChange);
    return () => mql.removeEventListener('change', onChange);
  }, [query]);
  return matches;
}
```

- [ ] **Step 2: `useHotkeys`（组合键解析，忽略输入框内触发）**

```ts
export function useHotkeys(combo: string, handler: () => void) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const target = e.target as HTMLElement;
      if (target.closest('input, textarea, [contenteditable]')) return;
      const keys = combo.toLowerCase().split('+');
      const mod = keys.includes('mod') ? (navigator.platform.includes('Mac') ? e.metaKey : e.ctrlKey) : true;
      const main = keys.filter(k => k !== 'mod').pop();
      if (mod && e.key.toLowerCase() === main) { e.preventDefault(); handler(); }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [combo, handler]);
}
```

- [ ] **Step 3: 其余三个 hook**：`useCopy`（2s 后复位）、`useLocalStorage`（JSON 序列化 + 版本号，损坏时回退默认值）、`useDebouncedValue`（delay 默认 250ms）。

- [ ] **Step 4: 测试**：`renderHook` + `vi.useFakeTimers()`；`useLocalStorage` 要覆盖“存了非法 JSON 不抛错”。

- [ ] **Step 5: Commit** — `feat(hooks): media query, hotkeys, copy, storage, debounce`

### T0.6 应用外壳

**Files:** `src/app/layout.tsx`、`src/app/(workbench)/layout.tsx`、`src/components/shell/{app-sidebar,page-header,command-palette,mobile-nav}.tsx`、`src/app/(workbench)/page.tsx`

- [ ] **Step 1: 根 layout**：`<html suppressHydrationWarning lang="zh-CN">` + `ThemeProvider` + `<Toaster />`（sonner）。

- [ ] **Step 2: 外壳布局**

```tsx
<div className="grid h-dvh grid-cols-[244px_minmax(0,1fr)] overflow-hidden max-md:grid-cols-1">
  <AppSidebar />
  <main className="h-dvh overflow-y-auto">{children}</main>
</div>
```

- [ ] **Step 3: 侧栏导航**：`nav` 项用 `usePathname()` 判定 active，active 态用 `bg-accent-soft text-accent`；`⌘K` 打开 `CommandPalette`（cmdk）。

- [ ] **Step 4: 视觉对齐**：结构与 `docs/design/prototype/index.html` 的 `.sidebar` / `.nav-item` 一致（间距 4 的倍数，图标 16px）。

- [ ] **Step 5: 迁移占位页**：删除 `src/app/page.tsx`，把工作台页放到 `src/app/(workbench)/page.tsx`；确认 `/` 仍可访问且不出现两个 root page。

- [ ] **Step 6: 验收**：1440 与 1024 宽度下侧栏不跳变；暗色切换无闪烁；键盘可遍历所有导航项。

- [ ] **Step 7: Commit** — `feat(shell): app layout, sidebar and command palette`

### T0.7 数据库与迁移

**Files:** `docker-compose.yml`、`drizzle.config.ts`、`src/lib/db/{client,schema,migrate}.ts`、`src/lib/db/schema/*.ts`

- [ ] **Step 1: `docker-compose.yml`（仅 Postgres）**

```yaml
services:
  db:
    image: postgres:16-alpine
    environment: { POSTGRES_USER: demandx, POSTGRES_PASSWORD: demandx, POSTGRES_DB: demandx }
    ports: ["5432:5432"]
    volumes: ["pgdata:/var/lib/postgresql/data"]
volumes: { pgdata: {} }
```

- [ ] **Step 2: schema 分区**：`core.ts`（ideas/threads/messages/runs/run_events）、`evidence.ts`（sources/evidence/queries）、`analysis.ts`（opportunities/scores/reports/citations）、`llm.ts`（providers/provider_models/llm_chains/provider_usage/api_calls）、`validation.ts`（validation_tasks）。

约束必须在 DB 层体现：`sources` 唯一键 `(canonical_url, content_hash)`；`llm_chains` 主键 `(profile, position)`；`evidence.signal` 用 `pgEnum`。

- [ ] **Step 3: 迁移脚本** `src/lib/db/migrate.ts` 用 `drizzle-orm/postgres-js/migrator`，缺表时自动建。

- [ ] **Step 4: 验证**

Run: `docker compose up -d && pnpm db:generate && pnpm db:migrate && pnpm db:studio`
Expected: 五组表可见；重复 `db:migrate` 幂等。

- [ ] **Step 5: Commit** — `feat(db): schema, migrations and local postgres`

### T0.8 测试基建

**Files:** `vitest.config.ts`、`src/test/setup.ts`、`playwright.config.ts`

- [ ] **Step 1: vitest 两个 project**：`node`（`src/lib/**`，不含 `.test.tsx`）与 `jsdom`（组件/hook），共享 `setup.ts`（RTL cleanup、`matchMedia` mock、`ResizeObserver` mock）。

- [ ] **Step 2: playwright**：`webServer: pnpm dev`，`baseURL: http://127.0.0.1:3000`，`use: { viewport: { width: 1440, height: 900 } }`，失败留 trace。

- [ ] **Step 3: 验收**：`pnpm test` 在空测试集下成功退出；`pnpm e2e` 能启动服务。

- [ ] **Step 4: Commit** — `test: vitest projects and playwright base`

### T0.9 首个页面与 verify 闸门

**Files:** `src/app/(workbench)/page.tsx`、`src/lib/utils/format.ts`

- [ ] **Step 1: 工作台页（RSC）**：静态数据渲染四行 run，列与原型 `cols-runs` 一致；状态/等级用 `SignalBadge` 与 `GradeBadge`（在 T0.4 中新增）。

- [ ] **Step 2: `format.ts`**：`formatRelativeTime(date)` / `formatScore(n)` / `formatCurrency(amount, currency)`，用 date-fns，单测覆盖跨日与 null。

- [ ] **Step 3: 验收**：`pnpm verify` 全绿；页面在暗色下无对比度问题（目测 WCAG AA）。

- [ ] **Step 4: Commit** — `feat(workbench): first server-rendered page`

---

## P1 LLM 配置（4 天）

### T1.1 密钥加密

**Files:** `src/lib/crypto/secret.ts`、`src/lib/crypto/secret.test.ts`

- [ ] **Step 1: 失败测试**

```ts
it('round-trips and never exposes plaintext', () => {
  const box = loadSecretBox('/tmp/dx-test.key');
  const ct = box.encrypt('sk-live-1234567890');
  expect(ct).not.toContain('sk-live');
  expect(box.decrypt(ct)).toBe('sk-live-1234567890');
  expect(box.mask('sk-live-1234567890')).toBe('sk-…7890');
});
it('creates key file with 0600', () => {
  expect(statSync('/tmp/dx-test.key').mode & 0o777).toBe(0o600);
});
```

- [ ] **Step 2: 实现**：`randomBytes(32)` 首次写盘（`mode: 0o600`, `flag: 'wx'`），AES-256-GCM，输出 `v1:<iv>:<tag>:<ciphertext>`（base64url）；导入时校验前缀与长度。

- [ ] **Step 3: Run** `pnpm vitest run src/lib/crypto` → PASS。

- [ ] **Step 4: Commit** — `feat(crypto): aes-gcm secret box with local key file`

### T1.2 Provider 数据访问层

**Files:** `src/lib/llm/repository.ts`、`src/lib/llm/repository.test.ts`、`src/lib/db/schema/llm.ts`

- [ ] **Step 1: 定义仓储接口**（不暴露密文给上层）

```ts
export type ProviderRow = { id: number; name: string; kind: ProviderKind; baseUrl: string; keyMask: string; enabled: boolean };
export interface ProviderRepo {
  list(): Promise<ProviderRow[]>;
  create(input: CreateProviderInput): Promise<ProviderRow>;
  update(id: number, patch: UpdateProviderInput): Promise<ProviderRow>;
  remove(id: number): Promise<Result<void>>;          // 被链引用 → QUOTA/REFERENCED 错误
  resolveApiKey(id: number): Promise<string | null>;  // 仅 LlmPort 内部使用
}
```

- [ ] **Step 2: 测试**：删除被 `llm_chains` 引用的 provider 返回 `code: 'PROVIDER_REFERENCED'`；`list()` 不含明文。

- [ ] **Step 3: Commit** — `feat(llm): provider repository with masked keys`

### T1.3 LlmPort 与降级链

**Files:** `src/lib/llm/{types,registry,chain}.ts`、`src/lib/llm/adapters/{openai-compatible,anthropic,google,ollama}.ts`、`src/lib/llm/chain.test.ts`

- [ ] **Step 1: 类型**

```ts
export type ProviderKind = 'openai-compatible' | 'anthropic-compatible' | 'google' | 'ollama';
export type ChainItem = { providerId: number; providerName: string; kind: ProviderKind; modelId: string };
export interface LlmPort {
  structured<T>(schema: z.ZodType<T>, prompt: Prompt, o: { profile: 'bulk' | 'quality' }): Promise<{ data: T; used: ChainItem; usage: Usage }>;
  text(prompt: Prompt, o: { profile: 'bulk' | 'quality' }): Promise<{ text: string; used: ChainItem; usage: Usage }>;
}
```

- [ ] **Step 2: 链执行器（顺序降级 + 冷却）**

```ts
for (const item of chain) {
  if (cooldown.isOpen(item.providerId)) continue;
  const res = await adapterFor(item).call(...);
  if (res.ok) return res;
  recordFailure(item.providerId, res.error);       // 401/403/429 → cooldown 5 分钟
  errors.push({ item, error: res.error });
}
return { ok: false, code: 'LLM_UNAVAILABLE', errors };
```

- [ ] **Step 3: 测试（mock fetch）**：首个 provider 返回 429 → 使用第二个；全部失败 → `LLM_UNAVAILABLE` 且 `errors` 长度等于链长；`structured()` 输出不合 schema → 重试一次后失败。

- [ ] **Step 4: Ollama 适配器**：`POST /api/chat`，`format: z.toJSONSchema(schema)`，`temperature: 0`，`stream: false`；超时 120s。

- [ ] **Step 5: Commit** — `feat(llm): port, adapters and fallback chain`

### T1.4 配置页 Server Actions

**Files:** `src/features/settings/llm/actions.ts`、`src/features/settings/llm/schema.ts`、`src/app/(workbench)/settings/llm/page.tsx`

- [ ] **Step 1: zod schema 共享**（表单与 action 同一份）

```ts
export const providerInput = z.object({
  name: z.string().min(1).max(40),
  kind: z.enum(['openai-compatible', 'anthropic-compatible', 'google', 'ollama']),
  baseUrl: z.url(),
  apiKey: z.string().min(8).optional(),
  headers: z.record(z.string(), z.string()).default({}),
  monthlyAllowanceUsd: z.number().nonnegative().optional(),
  acknowledgePayg: z.boolean().default(false)
});
```

- [ ] **Step 2: actions**：`createProvider` / `updateProvider` / `deleteProvider` / `testProvider` / `saveChains`。`testProvider` 只发 `max_tokens: 8` 的请求，返回 `{ ok, status, latencyMs, error? }`，错误原样返回。

- [ ] **Step 3: PAYG 守卫**：`baseUrl` 命中按量模板且 `acknowledgePayg !== true` → 返回 `code: 'PAYG_NOT_ACKNOWLEDGED'`。

- [ ] **Step 4: 测试**：action 入参非法 → 400 结构；测试连接超时 → 返回 `status: 0, error: 'timeout'` 不抛。

- [ ] **Step 5: Commit** — `feat(settings): provider crud and connection test`

### T1.5 配置页 UI

**Files:** `src/features/settings/llm/{provider-list,provider-form,model-chips,chain-editor,usage-panel}.tsx`、`src/lib/hooks/use-provider-test.ts`

- [ ] **Step 1: 组件边界**

| 组件 | props | 说明 |
|---|---|---|
| `ProviderList` | `providers, activeId, onSelect` | 无数据请求 |
| `ProviderForm` | `initial?, onSubmit` | RHF + zodResolver，key 输入 `type=password` |
| `ModelChips` | `models, disabledIds` | 不可外部调用的模型 `aria-disabled` |
| `ChainEditor` | `chains, onChange` | dnd-kit `SortableContext`，键盘可排序（`onKeyDown` 上下移动） |
| `UsagePanel` | `usage` | 进度用 `style={{ '--w': pct }}`，不拼颜色 |

- [ ] **Step 2: `useProviderTest`**：`{ state: 'idle'|'testing'|'ok'|'error', result, run }`，内部 `AbortController`，卸载即取消。

- [ ] **Step 3: 视觉对齐**：`docs/design/prototype/index.html` 中 `[data-screen="settings"]` 的结构；间距/圆角/徽章按 token。

- [ ] **Step 4: 验收（E2E，T1.6 前手测）**：新增 Ollama → 测试连接显示延迟 → 拖拽 quality 链 → 保存 → 刷新后顺序保留。

- [ ] **Step 5: Commit** — `feat(settings): llm configuration UI`

### T1.6 配置 E2E

**Files:** `tests/e2e/settings.spec.ts`

- [ ] **Step 1: 用例**：创建 provider（mock 测试接口 `/api/test` 由 MSW 或 route 拦截）→ 断言“已连接”与掩码；删除被引用 provider → 断言错误提示与列表不变；空链保存 → 断言按钮禁用。

- [ ] **Step 2: Run** `pnpm e2e tests/e2e/settings.spec.ts` → 3 个用例通过。

- [ ] **Step 3: Commit** — `test(e2e): llm settings flow`

---

## P2 Chat 外壳（3 天）

### T2.1 Run 事件与 SSE 端点

**Files:** `src/lib/runs/{events,repository}.ts`、`src/features/chat/actions.ts`、`src/app/api/runs/[runId]/stream/route.ts`、`src/worker/main.ts`（骨架）

- [ ] **Step 1: 线程与 run 写入**：`createThread(input)` 返回 `threadId`；`createRun({ threadId, idea, angles })` 在同一个事务里写 `runs`（`chain_snapshot` 取当前 `llm_chains`）、`messages`（用户消息）、`run_events('run.created')`；`budget` 相关字段不存在，只写 `deadline_at = now() + interval '90 minutes'`。

- [ ] **Step 2: 事件写入**：`appendEvent(runId, type, payload)` 在同一事务里 `seq = coalesce(max(seq),0)+1`，并更新 `runs.stage`。

- [ ] **Step 3: SSE**：`ReadableStream`，每 500ms 查 `seq > after`，心跳 15s，客户端断开即 `cancel()`；`after` 来自 `?after_seq` 或 `Last-Event-ID`。

- [ ] **Step 4: 测试**：`createRun` 的 `chain_snapshot` 在配置变更后仍是旧值（快照语义）；`readEvents(after)` 按 seq 升序无重复；SSE 端点在 2 个事件后关闭连接不报错。

- [ ] **Step 5: Commit** — `feat(runs): creation, append-only events and resumable sse`

### T2.2 useRunStream Hook

**Files:** `src/lib/hooks/use-run-stream.ts`、`use-run-stream.test.ts`、`src/lib/runs/event-reducer.ts`、`event-reducer.test.ts`

- [ ] **Step 1: reducer 先测**：乱序 seq 去重、重复事件幂等、`run.failed` 后停止接收。

```ts
it('ignores duplicate seq', () => {
  const s1 = reduce(initial, { seq: 3, type: 'stage.started', payload: {} });
  const s2 = reduce(s1, { seq: 3, type: 'stage.started', payload: {} });
  expect(s2.events).toHaveLength(1);
});
```

- [ ] **Step 2: hook**：`new EventSource(url)`，`onerror` 后指数退避（1s→8s，最多 5 次），用 `lastSeq` 重建 URL；返回 `{ events, stage, connected, error }`。

- [ ] **Step 3: 测试**：mock `EventSource`，断言重连 URL 带 `after_seq`；卸载后不再重连。

- [ ] **Step 4: Commit** — `feat(runs): sse hook with resume and backoff`

### T2.3 Chat API 与消息 parts

**Files:** `src/app/api/chat/route.ts`、`src/features/chat/{message-parts,tool-cards,composer,thread}.tsx`、`src/lib/chat/tools.ts`

- [ ] **Step 1: `/api/chat`**：`streamText({ model, messages, tools })` → `toUIMessageStreamResponse()`；系统提示要求“任何市场论断必须带 `[eN]`，无证据则说没有足够证据”。

  模型来自 `getChatModel()`：只接受 **openai-compatible / ollama** 两类（用 `createOpenAICompatible({ baseURL, apiKey })`）。`anthropic-compatible` 与 `google` 仅在 `LlmPort.structured` 中通过 fetch 适配器使用；若把它们设为 quality 链唯一项，聊天入口会返回 `CHAT_PROVIDER_UNSUPPORTED` 并在 UI 提示切换，而不是静默降级。

- [ ] **Step 2: 工具定义**（先接 mock，P3 接真数据）

```ts
export const tools = {
  query_evidence: tool({
    inputSchema: z.object({ signal: z.enum(SIGNALS).optional(), q: z.string().optional() }),
    execute: async (args) => ({ items: [] as EvidenceDto[], args })
  }),
  start_research: tool({
    inputSchema: z.object({ idea: z.string().min(8), angles: z.array(z.string()).optional() }),
    execute: async (args) => ({ status: 'needs_confirmation', args })   // 不产生副作用
  })
};
```

- [ ] **Step 3: parts 渲染**：`text` → Streamdown（`cjk` + `code` 懒加载）；`tool-*` → 卡片；`data-evidence` → 证据卡。未知 part 渲染 `null` 并记 `console.warn`。

- [ ] **Step 4: `[eN]` 转 chip**：在 text part 渲染后，用受控的 rehype 插件替换 `[e\d+]` 为 `<CitationChip id="e12" />`。

- [ ] **Step 5: Commit** — `feat(chat): streaming api and message part renderers`

### T2.4 对话页装配

**Files:** `src/app/(workbench)/threads/[threadId]/page.tsx`、`src/features/chat/chat-screen.tsx`、`src/features/runs/run-rail.tsx`

- [ ] **Step 1: RSC 读历史**：messages 按 `created_at` 升序传给客户端；`threadId` 不存在 → `notFound()`。

- [ ] **Step 2: 布局**：`grid-cols-[minmax(0,1fr)_312px]`；`thread-scroll` 内部滚动，composer 固定底部（`use-stick-to-bottom` 只在接近底部时自动跟随）。

- [ ] **Step 3: 审批卡**：`tool-start_research` 的 `input-available` 状态渲染；确认后调用 `createRun` action 并 `router.refresh()`。

- [ ] **Step 4: 验收**：输入 → 发送 → 流式文本出现 → 点 `e12` 抽屉打开 → 刷新页面历史仍在。

- [ ] **Step 5: Commit** — `feat(chat): chat screen with run rail`

### T2.5 Composer 与快捷键

**Files:** `src/features/chat/composer.tsx`、`src/lib/hooks/use-auto-resize.ts`

- [ ] **Step 1: 行为**：Enter 发送、Shift+Enter 换行、输入法组合中不发送（`e.nativeEvent.isComposing`）；流式中按钮变“停止”并调用 `stop()`。

- [ ] **Step 2: 自适应高度**：`useAutoResize` 将 `scrollHeight` 映射到 1–6 行，超过滚动。

- [ ] **Step 3: 单测**：组合输入不触发 `onSubmit`；`stop` 在无流式时禁用。

- [ ] **Step 4: Commit** — `feat(chat): composer with ime and stop`

### T2.6 Chat E2E

**Files:** `tests/e2e/chat.spec.ts`

- [ ] **Step 1: 用例**：发消息 → 审批卡出现 → 确认 → run 卡片出现 → 断言 `data-testid="stage"` 文案变化；断网重连（route abort）→ 事件数不回退。

- [ ] **Step 2: Run** `pnpm e2e tests/e2e/chat.spec.ts` → 通过。

- [ ] **Step 3: Commit** — `test(e2e): chat run flow`

---

## P3 采集（5 天）

### T3.1 URL 归一化与去重

**Files:** `src/lib/evidence/canonical-url.ts`、`src/lib/evidence/simhash.ts` + 测试

- [ ] **Step 1: 测试先行**：`https://A.com/p/?utm_source=x#frag` → `https://a.com/p`；保留业务参数 `?id=1`；去掉 `fbclid/gclid/utm_*`。

- [ ] **Step 2: SimHash**：中文按 2-gram、英文按词切分，64 位，`hamming(a,b) <= 3` 视为重复；测试覆盖短文本（<10 字）走精确比较。

- [ ] **Step 3: Commit** — `feat(evidence): canonical urls and near-duplicate detection`

### T3.2 快照存储

**Files:** `src/lib/evidence/snapshot.ts`、`src/lib/evidence/snapshot.test.ts`

- [ ] **Step 1: 写入**：`data/snapshots/<sha256[0:2]>/<sha256>.txt.gz` 存**清洗后纯文本**，同目录 `.html.gz` 存原文；返回 `{ path, textPath, hash, bytes }`。

- [ ] **Step 2: 读取**：`readSnapshotText(hash)` 带 LRU（容量 50），文件缺失抛 `SNAPSHOT_MISSING`。

- [ ] **Step 3: 保留策略**：`pruneSnapshots(olderThanDays=90)`，测试用临时目录 + 假时间。

- [ ] **Step 4: Commit** — `feat(evidence): compressed snapshot store`

### T3.3 搜索适配器

**Files:** `src/lib/search/{port,ddg,bing,hn,github,appstore,limiter}.ts`、`tests/fixtures/search/*.html`

- [ ] **Step 1: 端口**

```ts
export type SearchHit = { url: string; title: string; snippet: string; platform: Platform; publishedAt?: string };
export interface SearchPort { id: string; search(q: string, o: { limit: number; recencyDays?: number }): Promise<SearchHit[]> }
```

- [ ] **Step 2: 结果页解析**：DDG html 端点用 cheerio/正则解析 `a.result__a`；Bing 用 `li.b_algo h2 a`。解析器必须对**保存的 HTML fixture** 测试，不联网。

- [ ] **Step 3: 结构化源**：HN Algolia `search?query=&tags=story`；GitHub `search/issues`（匿名限流 10/min）；App Store `customerreviews/page=1/id=<id>/sortby=mostrecent/json`。

- [ ] **Step 4: 限流器**：每 host 令牌桶（默认 1 rps）+ 3–8s 抖动；测试用假时钟。

- [ ] **Step 5: Commit** — `feat(search): adapters with fixture-tested parsers`

### T3.4 抓取（tier1 / tier2）

**Files:** `src/lib/crawl/{port,static,fetch-playwright,robots,challenge}.ts`、`scripts/crawl-login.ts`

- [ ] **Step 1: tier1**：undici 15s 超时 + `readability` 抽正文；`content-type` 非 html 直接拒绝。

- [ ] **Step 2: tier2**：Playwright `launchPersistentContext('~/.demandx/browser/<platform>')`；`goto(url, { waitUntil: 'domcontentloaded' })`；等待正文选择器；返回 html。

- [ ] **Step 3: 挑战检测**：命中登录墙/验证码选择器 → `{ status: 'needs_human', reason }`，**不重试、不绕过**。

- [ ] **Step 4: robots**：`CRAWL_RESPECT_ROBOTS=true` 时读 `/robots.txt` 并缓存 24h；`Disallow` 直接跳过并记 `skipped_reason='robots'`。

- [ ] **Step 5: 测试**：challenge 检测用本地 HTML 样本；robots 解析用固定文本；**不**对真实站点发请求。

- [ ] **Step 6: Commit** — `feat(crawl): static and playwright adapters with human-in-the-loop`

### T3.5 配额与看门狗

**Files:** `src/lib/quota/{policy,guard,deadline}.ts` + 测试

- [ ] **Step 1: 规则**：`quota_profile` 形如 `{ github: { window: 'minute', limit: 10 }, exa: { window: 'month', limit: 2500 } }`；调用前 `claim(provider)`，失败返回 `QUOTA_EXCEEDED`。

- [ ] **Step 2: 窗口计数**：写 `provider_usage`，按 `window_start` 归并；跨窗口自动重置。

- [ ] **Step 3: 看门狗**：`assertAlive(deadlineAt)` 在每阶段入口调用，过期抛 `DEADLINE_EXCEEDED`，调用方转入降级报告。

- [ ] **Step 4: 测试**：边界（第 10 次成功、第 11 次拒绝）、时钟回拨不导致负数。

- [ ] **Step 5: Commit** — `feat(quota): provider windows and deadline watchdog`

### T3.6 S1 采集阶段

**Files:** `src/lib/pipeline/{s1-collect,run}.ts`、`src/worker/{main,queues}.ts`、`src/lib/pipeline/s1-collect.test.ts`

- [ ] **Step 1: 阶段契约**

```ts
type StageResult = { ok: true; context: RunContext } | { ok: false; code: AppErrorCode; detail?: unknown };
export async function collect(ctx: RunContext): Promise<StageResult>
```

- [ ] **Step 2: 流程**：角度 → 查询（并行 2，受配额）→ 命中 → 抓取 → 快照 → 入库（唯一键去重，SimHash 二次去重）→ 每条写 `evidence.added`? 不，S1 只写 `run_events('stage.progress')` 与 `sources`。

- [ ] **Step 3: 幂等**：`input_hash = sha256(queries.join('|'))`，重跑同 stage 走 `ON CONFLICT DO NOTHING`。

- [ ] **Step 4: worker**：pg-boss 队列 `run:s1`，`retryLimit: 2`，`singletonKey: runId`；失败写 `run.failed`。

- [ ] **Step 5: 验收**：真实跑一次（Ollama 未装也可，S1 不依赖 LLM）→ `sources` ≥30 条，`run_events` 有进度事件。

- [ ] **Step 6: Commit** — `feat(pipeline): s1 collection stage`

### T3.7 采集设置页

**Files:** `src/app/(workbench)/settings/crawl/page.tsx`、`src/features/settings/crawl/{platform-card,limits-form,human-queue}.tsx`、`src/lib/crawl/session-status.ts`

- [ ] **Step 1: 会话状态**：读 `~/.demandx/browser/<platform>` 的 mtime 判定“已登录/过期”，不读 cookie 内容。

- [ ] **Step 2: 登录**：Server Action 起 `scripts/crawl-login.ts` 子进程，返回 pid；前端轮询 `/api/crawl/session?platform=` 每 2s，最多 5 分钟。

- [ ] **Step 3: 限速表单**：RHF + zod（并发 1–3、间隔 1–30s、页数 1–120、总时长 10–180 分钟）。

- [ ] **Step 4: `needs_human` 队列表**：来源、原因、重试按钮；重试只重新入队该 URL。

- [ ] **Step 5: Commit** — `feat(settings): crawl sessions, limits and retry queue`

---

## P4 抽取与引文闸门（4 天）

### T4.1 Evidence schema 与提示词

**Files:** `src/lib/evidence/schema.ts`、`src/lib/evidence/prompt.ts`

- [ ] **Step 1: schema**

```ts
export const SIGNALS = ['problem', 'seeking', 'paying', 'switching', 'recurring'] as const;
export const evidenceDraft = z.object({
  quote: z.string().min(4).max(600),
  signal: z.enum(SIGNALS),
  firstHand: z.boolean(),
  publishedAt: z.string().datetime().nullable(),
  priceMentioned: z.object({ amount: z.number().positive(), currency: z.string().length(3) }).nullable(),
  supports: z.string().min(4).max(120),
  doesNotProve: z.string().min(4).max(120)
});
```

- [ ] **Step 2: 提示词**：要求“只摘录原文，不改写；一个页面最多 3 条；没有可引用内容返回空数组”；把 schema 同时放进 system 与 `format`。

- [ ] **Step 3: 测试**：schema 拒绝改写型过长 quote（>600）、拒绝未知 signal。

- [ ] **Step 4: Commit** — `feat(evidence): draft schema and extraction prompt`

### T4.2 Quote Gate（核心）

**Files:** `src/lib/evidence/quote-gate.ts`、`quote-gate.test.ts`

- [ ] **Step 1: 失败测试（先写）**

```ts
it('accepts exact substring and returns offset', () => {
  const r = gate('前文……「三个平台改库存改到凌晨」……后文', '三个平台改库存改到凌晨');
  expect(r.ok).toBe(true);
  if (r.ok) expect(r.offset).toBe(6);
});
it('accepts whitespace-normalized match', () => {
  expect(gate('a  b\n c', 'a b c').ok).toBe(true);
});
it('rejects paraphrased quote', () => {
  const r = gate('原文是三个平台库存同步很麻烦', '多平台库存同步非常麻烦');
  expect(r).toMatchObject({ ok: false, reason: 'quote_not_in_snapshot' });
});
it('rejects when snapshot missing', () => {
  expect(gate('', '任意').ok).toBe(false);
});
```

- [ ] **Step 2: 实现要点**：先 NFKC 归一化并构建 `normIndex → originalIndex` 映射；空白折叠为单空格但保留映射；返回的 `offset` 指向**原始文本**（供高亮），并返回 `normalizedOffset` 便于二次定位。

```ts
export type GateResult = { ok: true; offset: number; length: number } | { ok: false; reason: 'quote_not_in_snapshot' | 'empty_quote' };
```

- [ ] **Step 3: 模糊回退禁用**：不做编辑距离、不做同义替换；只有精确 / 空白归一化两种。

- [ ] **Step 4: Run** `pnpm vitest run src/lib/evidence/quote-gate.test.ts` → 全绿。

- [ ] **Step 5: Commit** — `feat(evidence): quote gate with offset mapping`

### T4.3 抽取执行器

**Files:** `src/lib/pipeline/s2-extract.ts`、`src/lib/pipeline/s2-extract.test.ts`

- [ ] **Step 1: 批处理**：每页一次 `LlmPort.structured(..., { profile: 'bulk' })`；并发 2（Ollama 单机）；每页超时 120s。

- [ ] **Step 2: 落库**：通过 gate → 写 `evidence`；失败 → 写 `rejected_reason`，**不入评分**；两类都发事件。

- [ ] **Step 3: 指标**：阶段结束写 `run_events('stage.finished', { accepted, rejected, recallSample })`；拒绝率 >20% 时事件带 `warning: 'high_rejection_rate'`。

- [ ] **Step 4: 测试**：mock LlmPort 返回 3 条（1 条篡改）→ 2 条入库，1 条 rejected。

- [ ] **Step 5: Commit** — `feat(pipeline): s2 extraction with rejection reasons`

### T4.4 抽取质量评估

**Files:** `scripts/eval-extract.ts`、`tests/fixtures/extract/labeled-30.json`

- [ ] **Step 1: 标注集**：30 页，每页标注应抽出的 quote 片段（人工）。

- [ ] **Step 2: 脚本**：跑 bulk 链 → 计算召回/精确率 → 输出 Markdown 表到 `docs/eval.md`；退出码 0，但召回 <60% 时打印 `FAIL_THRESHOLD`。

- [ ] **Step 3: 验收**：`pnpm tsx scripts/eval-extract.ts` 在 Ollama 运行时可执行并给数。

- [ ] **Step 4: Commit** — `feat(eval): extraction recall harness`

### T4.5 证据库页面

**Files:** `src/app/(workbench)/runs/[runId]/evidence/page.tsx`、`src/features/evidence/{evidence-table,filters,evidence-sheet}.tsx`、`src/lib/evidence/queries.ts`

- [ ] **Step 1: 表格**：TanStack Table 列定义（信号、来源、时间、摘要、支持/不能证明、状态）；>200 行启用 virtual。
- [ ] **Step 2: 筛选**：`nuqs` 管理 `signal/platform/hand/price/q`，服务端读 `searchParams` 直接查询（不重复请求）。
- [ ] **Step 3: 抽屉**：`EvidenceSheet` 高亮 quote（用 `offset/length` 切分文本为三段渲染 `<mark>`），显示快照路径与“不能证明”。
- [ ] **Step 4: 人工确认**：`confirmEvidence` / `rejectEvidence` action；驳回写 `rejected_reason='manual'` 并触发评分重算（P5 接入，先留事件）。
- [ ] **Step 5: E2E**：筛选后刷新 URL 保持；点击行打开抽屉并高亮。

- [ ] **Step 6: Commit** — `feat(evidence): table, filters and quote highlighting`

---

## P5 聚类与评分（3 天）

### T5.1 聚合查询

**Files:** `src/lib/scoring/aggregate.ts`、`aggregate.test.ts`

- [ ] **Step 1: 计数定义**：`n/p/c/comp/r` 与规格 §9 一致；SQL 用 `count(distinct ...)`，测试用内存 fixture 校验。

- [ ] **Step 2: Commit** — `feat(scoring): evidence aggregation`

### T5.2 Rubric 纯函数

**Files:** `src/lib/scoring/rubric.ts`、`rubric.test.ts`

- [ ] **Step 1: 表驱动测试**（先写）

```ts
it.each([
  [0, 0], [1, 6], [2, 6], [3, 11], [4, 11], [5, 16], [9, 16], [10, 20], [25, 20]
])('needs(%i) = %i', (n, expected) => expect(scoreNeeds(n)).toBe(expected));
it('caps payment at 10 without a verifiable price page', () => {
  expect(scorePayment(5, { hasVerifiablePrice: false })).toBe(10);
});
it('never exceeds 100', () => { expect(total(sampleScores())).toBeLessThanOrEqual(100); });
```

- [ ] **Step 2: 实现**：七维独立导出，便于单测；`total()` 断言各维度不超上限。

- [ ] **Step 3: Commit** — `feat(scoring): rubric with table-driven tests`

### T5.3 可信度与决策

**Files:** `src/lib/scoring/{credibility,decision}.ts` + 测试

- [ ] **Step 1: 可信度**：A/B/C/D 规则与规格一致；测试覆盖“付费≥13 需求 16 → A”“无来源 → D”。
- [ ] **Step 2: 决策**：按序求值，5 条分支逐条测试；`decision()` 返回 `{ decision, reason, nextStep }`。
- [ ] **Step 3: Commit** — `feat(scoring): credibility and ordered decision rules`

### T5.4 聚类阶段

**Files:** `src/lib/pipeline/s3-cluster.ts`、`s3-cluster.test.ts`

- [ ] **Step 1: 聚类**：`LlmPort.structured(..., { profile: 'quality' })` 输入为证据摘要列表（不含全文本），输出 `[{ name, positioning, evidenceIds }]`。
- [ ] **Step 2: 硬门槛**：独立来源 <3 的簇降级为单条证据记录，不生成 opportunity；测试覆盖 2 源与 3 源。
- [ ] **Step 3: 落库**：`opportunities` + `independent_sources`（去重来源数）。
- [ ] **Step 4: Commit** — `feat(pipeline): clustering with independence threshold`

### T5.5 S4 评级与报告校验规则

**Files:** `src/lib/pipeline/s4-score.ts`、`src/lib/report/validate.ts`、`validate.test.ts`

- [ ] **Step 1: S4**：读取 aggregate → rubric → credibility → `scores`；纯代码，无 LLM 调用。
- [ ] **Step 2: 校验器**：`validateReport(sections)` 检查：八部分齐全、每条 claim 有 citation、`sum(scores) === rubricTotal`、未知项不得出现在正文。
- [ ] **Step 3: 测试**：构造 4 份坏报告（缺节、无引用、总分不符、未知项混入）→ 各自返回对应错误码。
- [ ] **Step 4: Commit** — `feat(report): structural validation`

---

## P6 报告（4 天）

### T6.1 报告装配

**Files:** `src/lib/report/{schema,assemble}.ts`、`src/lib/pipeline/s5-report.ts`、`s6-validate.ts`

- [ ] **Step 1: schema**：八部分固定键（`summary/evidence/competitors/ranking/bestDirection/finance/plan/decision`），每节 `{ claims: { text, evidenceIds[], kind }[], unknowns: string[] }`。
- [ ] **Step 2: 装配**：`quality` 链生成 JSON；**只允许**填 `text` 与 `unknowns`，`evidenceIds` 必须来自输入集合，越界即丢弃并记 `unknown`。
- [ ] **Step 3: S6**：跑 `validateReport`，失败则 `run.failed` 且不写 `reports` 行。
- [ ] **Step 4: 测试**：模型返回不存在的 `e99` → 该 claim 被移入 `unknowns`，正文不含 `e99`。
- [ ] **Step 5: Commit** — `feat(report): assembly with citation whitelist`

### T6.2 报告页

**Files:** `src/app/(workbench)/runs/[runId]/report/page.tsx`、`src/features/report/{report-view,toc,claim,citations-panel,radar-chart}.tsx`

- [ ] **Step 1: RSC**：一次查询 `reports + scores + citations + evidence`，组装为视图模型；未完成时显示“报告生成中”并链接到运行页。
- [ ] **Step 2: 组件**：`Claim` 渲染文本 + `CitationChip`；`RadarChart` 用 recharts `next/dynamic({ ssr: false })`，颜色取 `var(--accent)`（通过 `getComputedStyle` 注入，避免硬编码）。
- [ ] **Step 3: 目录**：`IntersectionObserver` 高亮；`prefers-reduced-motion` 下取消过渡。
- [ ] **Step 4: 打印**：`@media print` 隐藏侧栏/按钮，引用改为脚注。
- [ ] **Step 5: Commit** — `feat(report): report page with citations and radar`

### T6.3 导出与分享

**Files:** `src/features/report/export-action.ts`、`src/lib/report/to-markdown.ts`、`to-markdown.test.ts`

- [ ] **Step 1: Markdown 生成**：纯函数，八部分 + 引用脚注 + 未知项；测试断言“无引用 claim 不出现在正文”。
- [ ] **Step 2: 下载**：Server Action 返回 `text/markdown` 内容，前端 `Blob` 下载，文件名 `<idea>-<date>.md`。
- [ ] **Step 3: Commit** — `feat(report): markdown export`

### T6.4 报告 E2E

**Files:** `tests/e2e/report.spec.ts`

- [ ] **Step 1: 用例**：打开报告 → 目录点击滚动 → 点 `[e19]` 抽屉定位 → 导出按钮触发下载 → 打印样式快照（`page.emulateMedia({ media: 'print' })` 后截图比对关键元素隐藏）。

- [ ] **Step 2: Run** `pnpm e2e tests/e2e/report.spec.ts` → 通过。

- [ ] **Step 3: Commit** — `test(e2e): report navigation, citations and export`

---

## P7 验证工作流与收尾（3 天）

### T7.1 14 天验证任务

**Files:** `src/lib/validation/{model,repository}.ts`、`src/app/(workbench)/runs/[runId]/plan/page.tsx`、`src/features/validation/plan-board.tsx`

- [ ] **Step 1: 模型**：`validation_tasks(run_id, day, title, done, evidence_id?, note)`；默认模板 14 天（访谈/落地页/价格测试/真实付款）。
- [ ] **Step 2: 交互**：勾选走 Server Action，乐观更新 + 失败回滚；`aria-pressed` 正确。
- [ ] **Step 3: Commit** — `feat(validation): 14-day plan board`

### T7.2 运行监控页

**Files:** `src/app/(workbench)/runs/[runId]/page.tsx`、`src/features/runs/{stage-stepper,query-table,failures-panel}.tsx`

- [ ] **Step 1: 组装**：SSE 事件 + `queries` + `sources` 统计；暂停/恢复 action 只影响后续请求。
- [ ] **Step 2: 降级横幅**：`run.error.code === 'DEADLINE_EXCEEDED' | 'QUOTA_EXCEEDED'` 时展示“部分采集未完成”，并列出跳过原因。
- [ ] **Step 3: Commit** — `feat(runs): monitor page with degradation banner`

### T7.3 全链路验收

- [ ] **Step 1: 真实跑一次**：`docker compose up -d` → `ollama serve` + `ollama pull qwen3:8b` → 新建研究 → 等待完成。

- [ ] **Step 2: 断言**：`sources ≥ 30`；`evidence` 拒绝率 < 20%；报告八部分齐全；`sum(scores) ≤ 100`；决策属于五选一。

- [ ] **Step 3: 记录**：把一次真实 run 的耗时、拒绝率、召回率写入 `docs/eval.md`。

### T7.4 文档与收尾

**Files:** `README.md`（运行说明）、`AGENTS.md`、`docs/superpowers/specs/*`（如实现偏离则同步修订）

- [ ] **Step 1: README**：前置（Docker、Ollama、Node 22）、`pnpm install`、`db:migrate`、`pnpm dev`、首次配置 LLM、跑一次研究、常见错误（Ollama 未启动 / 端口占用 / 模型未 pull）。
- [ ] **Step 2: AGENTS**：补目录结构、命令、约定（token、边界、hook 规范）与“不要引入”的清单。
- [ ] **Step 3: 清理**：删除临时脚本与未使用依赖（`pnpm dlx depcheck` 人工确认，不盲删）。
- [ ] **Step 4: Commit** — `docs: runbook and agent guidelines`

---

## 2. 完成定义（Definition of Done）

- [ ] `pnpm verify` 与 `pnpm e2e` 全绿；`pnpm tokens:check` 无硬编码颜色。
- [ ] 每个页面在 light/dark 两种主题下无不可读文本（对比度 ≥ 4.5:1）。
- [ ] 所有 hook 有单测；评分/闸门/去重/决策 100% 行覆盖。
- [ ] 报告中的每条论断可点击追溯到快照原文；无引用论断不出现在正文。
- [ ] 一次真实研究可在无云端账号、无付费 API 的前提下完成（Ollama + 免费源）。
- [ ] `README.md` 能让一个陌生人从零跑起来。

## 3. 风险触发点（出现即停手复核）

| 触发 | 动作 |
|---|---|
| 抽取拒绝率 >20% 连续两次 | 停 P4，先跑 `eval-extract`，按规格 §12 升模型 |
| 单个 run 超过 90 分钟 | 停，检查抓取限速与并发，不看 LLM |
| Provider 删除被引用 | 只报错，不做级联删除（数据完整性优先） |
| 任何地方出现硬编码颜色 | CI 拦截，改 token，不豁免 |
