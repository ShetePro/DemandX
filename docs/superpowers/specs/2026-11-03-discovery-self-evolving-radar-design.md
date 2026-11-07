# 灵感雷达 · 自进化扫描（2026-11-03）

## 目标

每次扫描都从「最近热点 + 历史扫描记忆」重新规划角度与查询，产出与最近若干轮不重复的方向；
用户采用过的方向被记录，成为下一轮规划的上下文。结果页必须说明本轮角度、新颖度，以及避开了哪些历史。

不在范围内：后台定时扫描、向量库/embedding、跨用户学习（本应用单用户本地运行）。

## 现状问题

- `DISCOVERY_QUERY_POOL` 是 28 条固定查询，随机抽 10 条；问法与主题高度重叠，同一查询的搜索结果也稳定，所以每轮结果趋同。
- 去重只在页面内存（`seenUrls`），刷新即丢；从不落库。
- 模型只看到 30 条片段，没有热点、历史角度、用户反馈可依据。
- 没有趋势源；`runtime.ts` 仅 hn-comments / bing / 可选 web search。

## 数据模型（`src/lib/db/schema/discovery.ts`）

`discovery_scans`

| 列 | 类型 | 说明 |
| --- | --- | --- |
| id | serial PK | 结果页用它回传 scanId |
| angles | jsonb string[] | 本轮由模型规划的角度 |
| queries | jsonb string[] | 实际执行的查询 |
| source_urls | jsonb string[] | 本轮展示给模型的来源 URL |
| opportunities | jsonb `{title,problem,angle,fingerprint}`[] | 用于跨轮去重 |
| trend_titles | jsonb string[] | 本轮热点输入摘要（标题） |
| model | text | 规划/分析所用模型 |
| elapsed_ms | integer | |
| created_at | timestamptz | |

`discovery_feedback`

| 列 | 说明 |
| --- | --- |
| id | PK |
| scan_id | FK → discovery_scans，`set null`（审计保留） |
| opportunity_title / angle | 被采用的方向 |
| thread_id | FK → threads，`set null` |
| created_at | |

## 流程（`POST /api/discovery/scan`）

1. **记忆**：读最近 12 次扫描的 angles / queries / opportunities（含 fingerprint）与采用反馈；收集最近 8 次扫描的 source_urls 作为排除集（上限 300 条）。
2. **热点**：HN Algolia `search_by_date`（近 14 天、`points>40`）取 20 条，标题 + 摘要 + 点数；失败视为空列表，不阻断扫描。
3. **规划**（`planner.ts`，`bulk` 链，结构化输出）：
   - 输出 3–6 个互不重叠的角度，每个角度 2 条查询（中英混合），共 8–12 条；
   - 输入：热点摘要、历史角度/查询/标题、被采用方向、一个随机探索行业（增加不确定性）；
   - 校验：查询去重、角度 ⊆ 规划角度、至少 3 个角度有查询；
   - 模型失败/输出非法 → 回退到固定池的随机 10 条，角度记为 `通用业务手工痛点`；
   - 每轮再追加 6 条固定业务探针，保证样例池里有可引用的商业线索片段。
4. **检索 + 过滤 + 分析**：沿用 `findOpportunities`（S1 式检索、内容农场/无商业线索过滤、引用白名单与 quote 校验），新增：
   - 每条机会必须带 `angle`，且属于本轮角度，否则丢弃；
   - `simhash64(title + problem)` 与历史 fingerprint 距离 ≤ 8 视为重复，丢弃；
   - 输出若缺引文或商业线索，先在同一批片段上带失败原因重答一次；仍失败时返回 `TOO_SIMILAR`/`INVALID_OUTPUT`，路由换一轮规划重试一次（上限 2 次），仍失败则如实报错。
   - 商业线索以「必选证据来源编号」列表显式交给模型，并把含商业线索的片段排在提示词最前；每条灵感尽量引用其中一个。整轮都没有可引用付费线索时，已通过角度/引文/新颖度校验的方向仍会返回，但标注 `commercialGap`，UI 提示「只基于问题信号，开始研究前需补证据」。
   - 模型偶尔用「（无有效灵感）」占位，这类输出直接判为无效，不渲染成卡片。
5. **入库**：成功的扫描写 `discovery_scans`，返回 `scanId`、`angles`、`novelty`（新 URL 占比）与 `avoided`（本轮排除的历史 URL 数）。
6. **反馈**：结果页「用它开始研究」成功创建线程后写 `discovery_feedback`；失败不影响线程创建，但要记录一次失败日志。

## 指定方向

结果页顶部提供「扫描方向」输入：0–5 个方向（回车添加、可移除、可从历史角度一键添加）。
选定后请求携带 `directions[]`，规划器把 angles 锁定为用户方向，每个方向 2–4 条查询，
`strategy='directed'`；模型失败时用同一方向生成模板查询，绝不退回无关固定池。未选方向时
`directions` 为空，沿用自动规划（`planned` / `fallback`）。顶部与列表底部的「再扫一轮」
读取同一份方向选择。

## API / UI

- `DiscoveryResult` 新增 `scanId`、`angles`、`novelty {newUrls,total,ratio}`、`avoided`、`strategy: 'planned' | 'fallback'`。
- 扫描阶段从 3 步变 4 步：`plan → search → filter → model`；文案标明「按最近热点规划新角度」。
- 结果页顶部：本轮角度标签、`新颖度 72%（避开最近 8 次扫描的 214 条 URL）`；卡片标题旁显示所属角度。
- 错误提示区分：`TOO_SIMILAR`（连续两轮过于相似，建议稍后再扫）、`NO_SOURCES`、模型不可用。

## 失败模式

- 无模型：规划回退固定池，扫描继续（`strategy='fallback'`）。
- 热点源不可达：空热点，规划靠历史与随机种子。
- 检索结果全是零相关页面：相关性门槛丢弃后触发 `NO_SOURCES`，路由换角度重试；不会把价格页/词典页当证据。
- 数据库写入失败：扫描结果仍返回，但标注 `scanId=null` 且不参与后续去重（不静默）。
- 反馈写入失败：toast 提示「方向已开始研究，但反馈未记录」。

## 验证

- 单测：planner（历史/热点进入 prompt、非法输出回退、查询去重）、trends 解析、novelty 距离、find 的 angle/重复过滤与 `TOO_SIMILAR`、页面新字段渲染与反馈调用。
- 集成（`TEST_DATABASE_URL`）：memory 读最近扫描、排除 URL、写反馈。
- 手动：连续两轮扫描，确认查询/标题/来源不同，结果页角度与新颖度变化。
