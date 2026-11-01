# 运行手册（从零到一次完整研究）

本文件只描述**当前代码真实可执行**的步骤。产品定位与报告规范见 `README.md`；
设计取舍见 `docs/superpowers/specs/`。

## 1. 前置

| 依赖 | 版本 / 说明 |
| --- | --- |
| Node.js | 22 及以上（`package.json` → `engines.node`） |
| pnpm | 9.12.2（`packageManager`）；`corepack enable` 或自行安装 |
| Docker | 用于本地 PostgreSQL 16；容器只跑数据库 |
| Ollama | **可选**。真实研究需要至少一个可用的 LLM provider；完全零成本方案是本地 Ollama |

不需要 `psql`，也不需要任何云端账号或付费 API。

## 2. 首次启动（5 条命令）

```bash
cp .env.example .env
docker compose up -d      # PostgreSQL 16，发布在 127.0.0.1:5433（5432 常被本机其他实例占用）
pnpm install
pnpm db:migrate           # 幂等；重复执行不会重复建表
```

然后开两个终端：

```bash
pnpm dev                  # 终端 1：http://127.0.0.1:3000
pnpm worker               # 终端 2：消费 pipeline/s1 队列，跑 S1–S6
```

只想开一个终端时用 `pnpm dev:all`：它在同一进程组里同时起 `dev` 与 `worker`，
Ctrl-C 一起停；日志按前缀混排，调试单个进程时仍建议分开跑。

`pnpm dev` 自己读取 `.env`；`pnpm worker`、`pnpm db:migrate` 与 `scripts/*` 通过
`src/lib/db/load-env.ts` 读取同一份 `.env`。

首次启动后可以打开：

- `/` 工作台（最近 4 个 run）
- `/runs` 全部研究（最近 50 个，含监控 / 报告 / 证据库 / 验证计划入口）
- `/settings/llm`、`/settings/crawl`

## 3. 配置 provider（二选一或都配）

每次成功的模型调用（对话、S1–S6、灵感雷达、测试连接）都会写入 `api_calls` 明细，并累加 `provider_usage` 的 5 小时 / 本周 / 本月窗口；`/settings/llm` 的「用量」面板显示请求数与本月 token（入/出）。写用量失败只记日志，不影响已经成功的模型调用。

配置写在数据库里，不依赖环境变量；`/settings/llm` 页面完成 provider → 拉取模型 →
`bulk` / `quality` 两条链 → 测试连接。

### 3.1 本地 Ollama（零边际成本）

```bash
ollama serve
ollama pull qwen3:8b
# 质量链可用更大模型，例如：ollama pull qwen3:14b
```

在 `/settings/llm` 新建 provider：

| 字段 | 值 |
| --- | --- |
| 类型 | `Ollama（本地）` |
| Base URL | `http://127.0.0.1:11434`（带不带 `/v1` 均可） |
| API Key | 留空 |

保存后点「拉取模型」确认能看到 `qwen3:8b`，把模型加入 **bulk** 链；
**quality** 链用于 S3 聚类、S4 评分与 S5 报告；对话优先使用 **bulk**（响应快），bulk 不可用时才回退 quality。点「测试连接」应返回延迟与模型名。

### 3.2 OpenCode Go 或任意 OpenAI 兼容端点

| 字段 | OpenCode Go |
| --- | --- |
| 类型 | `OpenAI 兼容` |
| Base URL | `https://opencode.ai/inference/go/openai/v1`（填 `.../go` 也能用聊天与探针） |
| API Key | 你的 key |
| 额外 header | 可留空：应用会自动注入稳定的 `x-opencode-session`；需要固定值时可手填覆盖 |

注意：

- 模型清单地址固定为 `https://opencode.ai/inference/v1/models`，应用会自动解析（不要再拼 `/go/.../models`，那会 404）。
- `https://opencode.ai/inference`（不带 `/go`）是按量计费入口，每次调用真实扣费；
  保存前必须显式勾选确认框，否则返回 `PAYG_NOT_ACKNOWLEDGED`。
- OpenCode 的免费模型（id 以 `-free` 结尾）只允许官方客户端调用，其它客户端即使带 key
  也会收到 403；拉取模型时它们会被自动标记为“仅官方客户端”，不能加入链。
- 连通性测试会跳过 `*-free`，按顺序尝试前 5 个可外部调用的模型，返回首个成功的结果；
  全部 403 时会提示“免费模型仅限官方客户端，或当前区域/隐私设置不可用”。
- 其它 OpenAI 兼容端点（GLM / Kimi / DeepSeek / OpenRouter / 自建网关）填各自的
  Base URL、key，按需补 header 即可。

### 3.3 从目录添加 provider（models.dev）

`/settings/llm` 左上角「添加」默认打开**目录** tab，数据来自
`https://models.dev/api.json`（进程内缓存 24 小时）：

1. 搜索框按名称 / baseURL / 环境变量匹配，200ms 防抖；分组按钮切换 全部 / 国内 /
   海外 / 本地。
2. 点一行选中：名称、Base URL 可改，API Key 可留空（Ollama / LM Studio 本地服务不需要
   key，key 也可以之后再补）。每行显示模型数与「已支持」标签。
3. 点「添加并带入 N 个模型」：provider 与 `provider_models` 在同一事务中写入，
   模型 `source = catalog`、`available_externally = true`；key 仍走 AES-256-GCM 加密，
   页面只回显掩码。目录项没有模型列表时按钮变为「添加 provider」，之后在模型区点
   「拉取模型」或「手动添加」。
4. 需要额外 headers、月额度或按量计费确认时，点「在手动模式中编辑」——目录选择会预填
   名称 / 类型 / Base URL，切到「手动」不丢值。

目录请求失败时页面显示「目录不可用，使用内置列表」并回退到内置预设（国内 9 家、
海外 14 家、本地 2 家），仍可搜索和添加，不会报错。Azure、Amazon Bedrock、Google
Vertex 需要资源名/项目参数/请求签名，目录中不出现，请走「手动」模式。

链的生效时机：新建 run 时把两条链快照进 `runs.chain_snapshot`，该 run 全程只用快照；
改配置只影响之后的 run。

## 4. 发起一次研究

S3 聚类与 S4 评分优先使用 quality 链；单次调用 90 秒超时后自动改用 bulk 链重试，不会因为 quality 模型过慢而让整次研究失败。

侧栏「新建研究」下方的 **寻找灵感** 会扫描中英文公开网页片段（抱怨、求推荐、付费线索），每次从 30 条垂直痛点问法里随机抽 10 条，来源优先 Hacker News 评论（真实抱怨）与网页搜索；内容农场、词典、百科直接丢弃，来源还须与查询主题相关。快速模型必须给出 4–8 个方向，并逐条填写现有替代、竞品、变现方式与 1–2 周 MVP 范围；每条引文都要能在原始片段中找到，否则整条作废。只含情绪、没有价格/付费/招聘等商业线索的方向同样被剔除。「再扫一轮」会换问法并排除已看过的来源，选「用它开始研究」即按普通研究流程入队。扫描通常 15–30 秒，模型超过 45 秒无响应会明确报超时。

1. 打开 `/threads/new` → 「新建研究」。
2. 在对话里描述产品想法或用户抱怨；确认后入队（`start_research`）。
3. 由 `pnpm worker` 执行 S1 采集 → S2 抽取 → S3 聚类 → S4 评分 → S5 报告 → S6 自检。worker 每 15 秒写一次心跳；超过 45 秒未更新时，聊天内联进度与右侧卡片都会提示「worker 未运行」，而不是一直显示排队中。
4. 对话页右侧的 **研究卡片** 按 run 叠放（最新在上，悬停展开），聊天流内只保留当前阶段的轻量进度行；`/runs/<id>` 仍可看完整事件与结果：

| 页面 | 内容 |
| --- | --- |
| `/runs/<id>/report` | 八节报告、评分与可信度；每节同时展示带引用的事实、明确标注的“分析判断（推断）”与未知项；没有报告时说明原因 |
| `/runs/<id>/evidence` | 逐条证据、引文高亮与快照；筛选条件保存在地址栏 |
| `/runs/<id>/plan` | 14 天验证计划；首次访问时按模板生成任务 |

### 对话里的研究与分析

- **右侧卡片组**：每次 run 一张卡片，透明背景、纵向居中、负 margin 叠放；悬停的卡片上浮放大、其余变淡。卡片含阶段、命中证据、报告决策与报告/证据链接。
- **聊天内联进度**：run 位置显示 `研究进行中 · run #N · S1 采集`，并流式追加最近查询/采集事件；结束后折叠为一行。
- **证据优先注入**：回答前把该会话最近 8 条证据写入 system（`[eN]` 引用）；`query_evidence` 只作补充，空结果最多再调一次，之后必须继续给出分析。
- **结论与操作面板**：每次回答先给明确结论（值得 / 不值得 / 需先验证）；结论含 2–4 个分支时调用 `present_options` 在末尾生成按钮，点击后以「选择：…」继续对话。
- **状态与重跑**：`get_run_status` 查询真实状态；`rerun_research` 可带 `focus` 收窄方向重跑，新 run 会新增一张卡片而不是替换旧的。
- **模型链**：对话优先 bulk；S3/S4 单次 90 秒超时后自动降级 bulk，避免 quality 模型过慢导致整次研究失败。

单 run 的墙钟上限是 90 分钟；超时/配额中断会留下已采集证据，并把 run 标记为失败。

### 兜底搜索（社交平台不可用时）

国内社交平台（小红书 / 抖音 / 知乎）依赖浏览器会话；没有会话、被验证码拦截或适配器返回空时，S1 会对该查询调用一次网页搜索 API：

- 在 `/settings/crawl` → 「兜底搜索」配置服务商（Tavily / Brave / Serper）与 API Key，点「测试连接」会发起一次真实查询；
- 也可用环境变量 `WEB_SEARCH_PROVIDER` / `WEB_SEARCH_API_KEY`；
- 兜底端口标记为 `fallback`，只在所有主适配器对该查询返回 0 条结果时运行，事件流会出现 `query.fallback`；
- 除五类需求信号外，S0 还会生成 `competitor` 组（竞品对比 / 替代方案 / 定价方案），用于竞品与定价分析。

## 5. 常见错误

| 现象 | 原因与处理 |
| --- | --- |
| `DATABASE_URL is not set. Copy .env.example to .env …` | 当前目录没有 `.env`，或命令绕过了 `load-env`。先 `cp .env.example .env`；`pnpm dev` 会在项目根目录读取它。 |
| `docker compose up -d` 报端口占用 / 连接 5432 失败 | 本项目发布 **5433**。若 5433 也被占用，改 `docker-compose.yml` 的 `ports` 与 `.env` 的 `DATABASE_URL` 端口，两处必须一致。 |
| provider 测试连接超时 | Ollama 没启动：`curl http://127.0.0.1:11434/api/tags`。无响应就先 `ollama serve`。 |
| 「拉取模型」为空 | 模型没下载：`ollama pull qwen3:8b`；或 Base URL 指向了别的端口。 |
| run 失败，`runs.error.code = LLM_UNAVAILABLE` | 链为空或所有 provider 都失败。提示里的 `bulk 链为空：请先在设置中配置 provider` 表示没有配置；否则逐个 provider 点「测试连接」，看真实的 401/403/429。 |
| 对话返回 `CHAT_PROVIDER_UNSUPPORTED` | quality 链里没有 `ollama` 或 `openai-compatible` 类型的模型。把可对话模型放到 quality 链首位；`anthropic-compatible` / `google` 只用于结构化调用，不能用于聊天。 |
| 报告页写「报告尚未生成」 | 正常状态：run 还在跑、已失败或已取消。页面会给出对应原因，并链接到证据库。 |
| `pnpm test` 里的数据库用例全部 skipped | 没设置 `TEST_DATABASE_URL`。集成测试会 TRUNCATE 表，因此只接受库名以 `_test` 结尾的数据库。见下一节。 |

## 6. 验收与测试命令

```bash
pnpm verify               # typecheck + lint + vitest（无 TEST_DATABASE_URL 时数据库用例跳过）
pnpm tokens:check         # 禁止 globals.css 之外出现硬编码颜色
pnpm e2e                  # Playwright；自动启动 pnpm dev 与 stub provider
pnpm acceptance           # S2–S6 契约验收，使用确定性假模型，不需要 provider
pnpm eval:extract --dry  # 抽取标注集自检 + 指标逻辑，不需要数据库/模型
```

`pnpm acceptance` 退出码：`0` 全部断言通过，`1` 某阶段/断言失败，`2` 环境或参数不可用
（数据库连不上、`--run` 不存在等）。它是**契约**检查，不是质量评估。

`pnpm eval:extract`（不带 `--dry`）会调用真实的 `bulk` 链：退出码 `0` 达标、`1` 低于 60%
召回门槛、`2` 没有可用模型、`3` 标注集损坏。未配置 provider 时退出码是 `2`——这表示
「没测到」，不能当成 0 分。当前评估范围与已有结果见 `docs/eval.md`。

### 需要数据库的单元测试

```bash
docker compose exec db psql -U demandx -d demandx -c 'CREATE DATABASE demandx_test'
DATABASE_URL=postgres://demandx:demandx@127.0.0.1:5433/demandx_test pnpm db:migrate
TEST_DATABASE_URL=postgres://demandx:demandx@127.0.0.1:5433/demandx_test pnpm test
```

集成测试共享同一个 `_test` 库并会 TRUNCATE 相关表；不要把它指向 `demandx`
（测试会拒绝非 `_test` 库）。迁移先跑开发库、再跑测试库，顺序不能反过来。

## 7. 验收记录（2026-10-30，本机）

| 命令 | 结果 |
| --- | --- |
| `pnpm verify` | 退出码 0（typecheck / lint / vitest 全绿） |
| `pnpm exec next build` | 退出码 0 |
| `pnpm e2e` | 11 passed |
| `pnpm acceptance` | 退出码 0 |
| `pnpm eval:extract --dry` | 退出码 0（12 页 / 23 条，recall 1.00） |
| `curl -s -o /dev/null -w '%{http_code}' …` | `/`、`/runs`、`/runs/10/report` 均 200 |
