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
**quality** 链用于 S3 聚类、S4 评分与 S5 报告；对话优先使用 **bulk**（响应快），bulk 不可用时才回退 quality。点「测试连接」应返回延迟与模型名。测试连接优先探测链内的模型（bulk → quality），并附带 provider 返回的短错误原文；`/models` 清单里仍列出但已不可调用的模型（如 `big-pickle`）不会再让健康 key 误报 400。

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

侧栏「新建研究」下方的 **寻找灵感** 是自进化的扫描：每轮先读 PostgreSQL 里最近 12 次扫描的角度/查询/灵感指纹、被「用它开始研究」采纳过的方向，以及 Hacker News 近 14 天、≥40 分的热点，由 bulk 链规划 3–6 个互不重叠的角度与 8–12 条中英查询，并追加 6 条固定业务探针（模型不可用时整轮回退固定池并标注 `fallback`），模型规划有 30 秒总预算，分析阶段最多等待 150 秒并会中止超时请求（不再把超时的模型冷却 5 分钟，也不会让被放弃的请求继续占着 provider 连接）；单个模型的失败原因（超时、HTTP 状态、上游短错误）写入 `~/.demandx/logs/llm.log`。再检索中英文片段（Hacker News 评论、Reddit 搜索 RSS、GitHub Issues、Bing/网页搜索，以及已登录平台的站内搜索：知乎/小红书/抖音走中文查询、X 走英文查询，每个平台每轮最多 1 条，使用对应 profile 的有头浏览器抓取搜索结果；未登录或无 profile 时该平台直接跳过，不会开窗口）。内容农场、词典、百科直接丢弃；每条方向必须带本轮角度、引文能在原始片段中找到；角度按买家领域（财务/人力/客服/电商/物流/建筑/制造/医疗/教育/餐饮/法律/销售/健身/房产/宠物/会展/农业/保险/软件运维/设计）去重，同一领域最多两个角度，最近 3 次扫描覆盖的领域会被避开；每条灵感的标题+问题还会与最近灵感做词元重叠与 simhash 去重，每轮每个角度最多一条；优先要求至少一条含价格/付费/招聘等商业线索；若片段池里有 Reddit/HN/GitHub 等真实讨论，则每条灵感必须至少引用一条真实讨论，否则丢弃（不再把厂商宣传页当需求）；整轮都没有可引用的付费线索时，方向带「本轮没有可引用的付费/商业线索」提示返回；与历史灵感 simhash 距离 ≤8 的近似方向直接丢弃，两轮都重复则明确报「过于相似」。模型若漏掉引文或商业线索，会带上一轮的问题在同一批片段上重答一次；仍失败才换一轮规划重试。最近 8 次扫描的原始 URL 会从下一轮检索中排除，结果页显示「第 N 轮」「本轮角度」「新颖度（新 URL 占比）」「已避开 N 条 URL」。页面顶部的「扫描方向」可以输入 1–5 个方向（回车或「添加」，从已扫描角度也能一键添加），选定后顶部与列表底部的「再扫一轮」都会只按这些方向规划查询；不选方向时才由模型按热点与历史自动规划。模型不可用时，定向扫描会按方向生成模板查询，而不是回退到无关的固定池。「再扫一轮」不会清除已有结果：新轮次在页面底部用骨架屏加载，成功后追加在上一轮下方，失败只显示错误并保留已完成轮次；列表底部同样有一个「再扫一轮」按钮，不必滚回顶部。选「用它开始研究」会写 `discovery_feedback`，下一轮据此深挖或换角度。扫描通常 15–30 秒，模型超过 45 秒按超时报错。

1. 打开 `/threads/new` → 「新建研究」。
2. 在对话里描述产品想法或用户抱怨；确认后入队（`start_research`）。
3. 由 `pnpm worker` 执行 S1 采集 → S2 抽取 → S3 聚类 → S4 评分 → S5 报告 → S6 自检。worker 每 15 秒写一次心跳；超过 45 秒未更新时，聊天内联进度与左侧卡片都会提示「worker 未运行」，而不是一直显示排队中。
4. 对话页左侧的 **研究卡片** 按 run 从旧到新叠成一副牌：最新一次 run 在最下方，完整显示；每张更早的卡片只露出头部一行（`run #N · 证据数 · 决策 · 状态`），被下面的卡片盖住，卡片之间留 8px 间隙。鼠标移入任意卡片（或键盘聚焦到卡片里的链接）时，该卡片以 420ms 的弹簧曲线（`linear()`，约 16% 过冲后回弹）展开到完整高度，并把下方卡片带弹性地推开；移出后用 ease-out 收回 44px 头部，不会跌破头部高度。聊天流内只保留当前阶段的轻量进度行；`/runs/<id>` 仍可看完整事件与结果：

| 页面 | 内容 |
| --- | --- |
| `/runs/<id>/report` | 八节报告、评分与可信度；每节同时展示带引用的事实、明确标注的“分析判断（推断）”与未知项；没有报告时说明原因 |
| `/runs/<id>/evidence` | 逐条证据、引文高亮与快照；筛选条件保存在地址栏 |
| `/runs/<id>/plan` | 14 天验证计划；首次访问时按模板生成任务 |

### 对话里的研究与分析

- **左侧卡片组**：每次 run 一张完整卡片，按时间从旧到新自上而下叠放，下面的卡片覆盖上面的卡片、只留 44px 头部，卡片之间保留 8px 间隙（包裹层 `overflow-hidden`，所以展开时裁切的是卡片本身，间隙露出的是页面背景）。头部一行给出概况（`run #N`、证据数与决策、状态徽标），被盖住的卡片仍保留阶段、命中证据、报告决策与报告/证据链接。鼠标移入卡片即展开：包裹层高度从 44px 过渡到实测卡片高度（`transition-[height]` 420ms），展开用缓动弹簧曲线 `linear()`（约 16% 过冲、一次小回弹），下方卡片跟着做弹性位移；收起用 ease-out，避免回落时把头部裁掉。键盘 Tab 进入卡片内链接同样会展开。卡片组高度只随「打开的一张 + 头部 × 其余卡片」增长，正常 run 数量下不会出现内部滚动条。
- **聊天内联进度**：run 位置显示 `研究进行中 · run #N · S1 采集`，并流式追加最近查询/采集事件；结束后折叠为一行。
- **结束后自动回到对话**：run 结束时 worker 会往该会话追加一条「研究完成/失败」结论（采集页数、接受/拒收证据、聚类与评分数量、评分与决策、报告编号），数字全部取自已存储的行；失败则写明失败阶段、原因和已保留的数据。页面开着时收到终态事件后自动重读对话，不用刷新就能看到这条消息；聊天正在流式回答时，重读会等回答结束再执行。
- **证据优先注入**：回答前把该会话最近 8 条证据写入 system（`[eN]` 引用）；`query_evidence` 只作补充，空结果最多再调一次，之后必须继续给出分析。
- **结论与操作面板**：每次回答先给明确结论（值得 / 不值得 / 需先验证）；结论含 2–4 个分支时调用 `present_options` 在末尾生成按钮，点击后以「选择：…」继续对话。
- **排版**：回答保持 Markdown 结构（短段落、`###` 小标题、列表、表格、代码块、引用），不再给每个标签段落套卡片；以加粗标签开头的段落在 `claim-rehype` 里识别成结论/事实/推断/未知/风险/实验六类，只在标签前加 3px 色条并用标签颜色区分（强调/绿/灰/黄/红/强调），推断整段降为次要文字色。列表标记与引用统一着色；含引用的回答顶部显示「基于 N 条证据」。
- **证据检索卡**：同一回答里连续的 `query_evidence` 合并成一张卡（标题显示「· N 次」），列出检索条件（信号/平台/关键词）；空结果会说明原因——研究仍在 S1/S2 时「证据通过 S2 抽取校验后才会入库」，会话没有研究或 run 失败时分别给出对应说明，不再只显示「没有找到足够证据」。
- **状态与重跑**：`get_run_status` 查询真实状态；`rerun_research` 可带 `focus` 收窄方向重跑，新 run 会新增一张卡片而不是替换旧的。
- **模型链**：对话优先 bulk；S3/S4 单次 90 秒超时后自动降级 bulk，避免 quality 模型过慢导致整次研究失败。

单 run 的墙钟上限是 90 分钟；超时/配额中断会留下已采集证据，并把 run 标记为失败。

### S1 检索与证据来源

S1 不再把整段想法直接当查询词：

- 由 `bulk` 链把想法规划成 8–14 条短查询（中英各半，按 problem / seeking / paying / switching / frequency / competitor 分组）；模型不可用时回退到 `buildAngles`，并用 `condenseIdea` 只取想法的标题从句（≤24 字）。
- 端口顺序按一手来源优先：HN 评论 → GitHub Issues → Reddit → HN 故事 → DDG → Bing。Reddit 只跑英文查询且每轮最多 2 条，GitHub 最多 4 条；其它端口不消耗其额度。
- HN 评论、Reddit 帖子、GitHub Issue 的搜索摘要本身就是正文：S1 直接把它写成快照（`sources.crawl_tier = 'snippet'`，每轮上限 40 条），不再去爬被 robots/反爬挡住的原页；S2 的引文校验仍然对着这段真实文本做。
- 进入抓取前先过滤：命中内容农场/词典/维基，或与查询零相关且没有商业线索的页面直接跳过（`source.skipped` 的 `blocked_host` / `off_topic`），不浪费抓取配额。

因此「0 条证据」通常意味着：查询太笼统、搜索端口全部被限流/拦截，或页面与查询不相关；先看 `queries` 表的 `result_count` 与 `run_events` 里 `source.skipped` 的 reason，再决定是否启用在下方配置的兜底搜索 API。

S1 的 `sources` 按 run 归属：同一个 URL/快照在重跑时会为新的 run 新建一行，复用已存快照，但不会把旧 run 的来源算进本轮（这是重跑证据骤减的旧 bug）。查询规划要求至少 4 条英文查询，否则带失败原因重答一次——英文查询是 HN/Reddit/GitHub 能返回一手讨论的前提。

S3 的硬门槛是**每个聚类至少 3 个独立来源**；达不到的方向不会变成机会。若已有证据但没有方向过门槛，S5 会写一份**探索性报告**（bulk 链）：执行摘要与「需求证据」列出来源与引文（带 [eN] 引用），竞品/排名/最佳方向/财务/验证计划/决策用「推断：」给出明确倾向（财务只给带“假设”的区间），决策记为「建议暂缓」并列出还需补齐的证据类型；**即使一条证据都没有**，也会以资深创业者/投资人的身份给出假设性判断和 14 天验证计划（claims 为空，全部标注推断/假设），只有模型不可用时才退回纯证据/空壳。报告页把这些内容标为「资深从业者判断（推断，非事实）」；没有 claim 的章节不再显示“本节没有可引用的论断”，无评分时头部显示「未评分」而不是 0/100。

### 平台登录（小红书 / 抖音 / 知乎）

`/settings/crawl` → 「平台会话」→「去登录」会启动 `pnpm crawl:login <platform> <平台首页>`，打开一个持久化的 Chromium 窗口并直接跳转到该平台（小红书 / 抖音 / 知乎）；完成登录后关闭窗口即可，页面会轮询 `~/.demandx/browser/<platform>` 的 mtime 判断会话是否更新。

- 登录与抓取都尽量使用本机已安装的 Chrome（`channel: 'chrome'`，缺失时回退 Playwright Chromium）、`zh-CN` locale 与 `Asia/Shanghai` 时区，并移除 `navigator.webdriver` 等自动化标记；`CRAWL_BROWSER_CHANNEL=bundled` 可强制使用内置 Chromium。
- 小红书 / 抖音 / 知乎 / X 的抓取**强制 headed**（即使 `CRAWL_HEADLESS` 为 true），读取前做几秒随机滚动与鼠标移动，再通过 Playwright/CDP 读取渲染后的 DOM；帖子/文章节点会追加到快照文本供 S2 抽取。验证码和登录墙仍然只记录为 `needs_human`，不会自动破解。
- X / Twitter 的反爬与账号风控更严，抓取前请确认遵守其 ToS；需要登录的页面先用「去登录」完成人工登录。
- 卡片上的「近期使用 / 较久未用」只表示 profile 目录的 mtime；真实登录状态点「检测登录」：会用无头浏览器打开该 profile，只检查登录 cookie 的**名称**（小红书 `web_session`、抖音 `sessionid/sessionid_ss/sid_tt`、知乎 `z_c0`、X `auth_token`），不会读取 cookie 值。显示「未检测到登录 cookie」就说明目录虽被使用过，但当前没有有效会话。
- 如果浏览器窗口没弹出或页面打不开，卡片右侧有「窗口打不开？手动打开」链接；
- 登录状态检测只读 cookie 名称，不读取、打印或保存 cookie 值；
- 「平台采集情况（最近 30 天）」按 `sources` 的 URL 域名统计各平台被抓取的页面数、涉及的 run 与抓取方式。数字为 0 不代表登录失败：搜索查询来自 Bing/DDG/HN/Reddit/GitHub，只有搜索结果指向这些平台域名时才会用对应登录会话抓取；如需平台内搜索，需要另外的平台搜索适配器；
- 页面打不开是网络/站点侧问题时会保留窗口并提示手动输入网址，不会直接关闭。

站内搜索不会直接使用规划器的整句查询：`socialQueryFor` 会去掉「太贵/太麻烦/推荐/工具/software/pricing…」等意图词，只保留 3–4 个领域关键词（如「律所 外包 文书起草」「invoice reconciliation spreadsheet」），并把中文查询按知乎→小红书→抖音依次错开，避免三个平台搜同一句。结果页「本轮查询（N）」展开后可以看到实际执行的全部查询，以及每个社交平台最终使用的检索词。
若分析模型全部不可用，扫描不会只剩一句报错：错误面板会列出已采集的片段数、来源 provider 和可展开的片段列表，并说明「检索已完成，模型不可用」。雷达的模型调用在 bulk 全部失败时会自动降级到 quality 链。失败原因现在会带上 provider 返回的短错误（例如 `400（Upstream request failed: Model is unavailable.）`），据此去 `/settings/llm` 修链即可。
灵感雷达的站内搜索会短暂弹出对应平台的浏览器窗口（与抓取规则一致：社交平台强制 headed、读取前做拟人滚动），因此雷达扫描时桌面会看到知乎/小红书/抖音/X 的窗口一闪而过（每个平台只搜 1 条，抓完即关）；未登录的平台不会启动。如果某个 profile 已有 Chrome 窗口在运行（例如登录窗口没关），脚本会检测 `SingletonLock` 并跳过该平台；同一 profile 还有进程内互斥和 `.demandx-search.lock` 文件锁，防止两个并发扫描同时启动同一个 Chrome。雷达本身也限制同一时间只跑一轮（第二个标签页会提示「已有一轮扫描在进行中」），因为每个 /discover 页面打开时会自动开始扫描。残留的 `SingletonLock` 会检查它指向的 PID：进程已死就自动清理（Chrome 的锁是 symlink，不能用 `existsSync` 判断，否则活锁也会被当成不存在）。遇到一堆残留的 about:blank 标签时，关闭那个浏览器窗口即可；新扫描不会再叠加。每个平台的实际查询、最终 URL、命中数与失败原因写入 `~/.demandx/logs/social-<platform>.log`，返回 0 条时可先看这个日志（常见原因是未登录、搜索页改版或验证码）。

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
| 报告显示「0 条证据 / 没有可引用的论断」 | 先看 `sources` / `evidence` 是否为空。S1 的 `source.skipped` 会写 `robots`、`off_topic`、`blocked_host` 等原因；如果 `queries.result_count` 全是 0，说明搜索端口被限流或查询太窄，建议启用在 `/settings/crawl` 配置的兜底搜索 API。 |
| `pnpm test` 里的数据库用例全部 skipped | 没设置 `TEST_DATABASE_URL`。集成测试会 TRUNCATE 表，因此只接受库名以 `_test` 结尾的数据库。见下一节。 |

## 6. 验收与测试命令

```bash
pnpm verify               # typecheck + lint + vitest（无 TEST_DATABASE_URL 时数据库用例跳过）
pnpm tokens:check         # 禁止 globals.css 之外出现硬编码颜色
pnpm e2e                  # Playwright；自动启动 pnpm dev 与 stub provider
pnpm acceptance           # S2–S6 契约验收，使用确定性假模型，不需要 provider
pnpm eval:extract --dry  # 抽取标注集自检 + 指标逻辑，不需要数据库/模型
pnpm cases:ingest --limit 50 --dry  # 案例库 P0：抓 50 条 Starter Story 公开访谈，只统计不写库
pnpm cases:ideas --pages 8          # 案例库 idea 索引：走 /data 的筛选分区，写入 case_ideas
```

`pnpm acceptance` 退出码：`0` 全部断言通过，`1` 某阶段/断言失败，`2` 环境或参数不可用
（数据库连不上、`--run` 不存在等）。它是**契约**检查，不是质量评估。

`pnpm eval:extract`（不带 `--dry`）会调用真实的 `bulk` 链：退出码 `0` 达标、`1` 低于 60%
召回门槛、`2` 没有可用模型、`3` 标注集损坏。未配置 provider 时退出码是 `2`——这表示
「没测到」，不能当成 0 分。当前评估范围与已有结果见 `docs/eval.md`。

### 案例库（P0，只入库不检索）

`pnpm cases:ingest` 是案例库的第一阶段：从 Starter Story 的公开 sitemap（`/stories/`，
约 3.3k 条创始人访谈）按片抓取，遵守 robots 与 1s 间隔，正文快照走
`src/lib/evidence/snapshot.ts`（内容寻址、可校验引文）。只解析页面**原文里写明**的字段：
标题、站点自己的 `$X revenue/mo` 标签、`started <Month> <Year>`、meta description。
类别、商业模式、可借鉴机制留给后续 S2 抽取，此时为 `null`。

```bash
pnpm cases:ingest --limit 50              # 抓 50 条并写入 case_studies
pnpm cases:ingest --limit 20 --dry        # 只抓取和统计，不写快照/数据库
pnpm cases:ingest --limit 50 --offset 50  # 取下一段
pnpm cases:ingest --sitemap data/cases/sitemap.xml.gz --limit 10
```

输出会给出 `ok / robots / needs_human / error` 分布与字段命中率（营收、成立年、摘要）、
正文均值。`case_studies.url` 唯一，重复执行是 upsert，并保留后续 LLM 填入的
`category / business_model / extraction`。它**不**参与 pipeline，也不影响评分；P1 才接检索
（`search_cases` 工具）。

`pnpm cases:ideas` 抓的是另一个入口：`https://www.starterstory.com/data` 的公开 idea
索引（约 3.7k 个 business，含月营收）。匿名访问每个筛选分区只返回 **25 行**，计数器虽写
「Showing 100」，无限滚动只对登录用户开放，所以脚本按 `starting_costs` 与
`business_model` 分区逐个抓取，`--pages` 控制请求预算（默认 8，间隔 3s）。写入
`case_ideas`：标题/描述/域名、营收与来源（`reported` 创始人自报 / `estimated` 站点估算）、
Solo 分（站点自己的分数，不是我们的 rubric）、模型/增长/客户/工具标签。业务页才有的字段
（as-of 日期、国家、团队、定价、融资、来源数）留给 `enrichment` 列，后续 P0.6 填充。

```bash
pnpm cases:ideas --pages 30           # 扩大覆盖
pnpm cases:ideas --pages 3 --dry      # 只抓取和统计
pnpm cases:ideas --html data/cases/listing.html   # 离线解析已保存的列表页（无网络时）
```

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
