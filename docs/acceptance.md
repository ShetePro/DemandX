# 全链路契约验收（S2–S6）

`scripts/acceptance.ts` 用**确定性假模型**把 S2–S6 串起来跑一遍，并断言各阶段之间的契约。
它回答的是「管道有没有接错：闸门、独立性阈值、评分算术、报告校验、落库是否一致」，
**不回答「模型抽得好不好」**。假模型的 quote、聚类、序数、报告正文全是固定字符串，
所以本文件里的任何数字都不能当作抽取质量或市场结论。

真实模型的范围、已跑结果与缺口见 `docs/eval.md`；两边不能互相替代。

## 前提

1. Node 22、`pnpm install`。
2. `docker compose up -d` 启动 PostgreSQL（默认 `127.0.0.1:5433`）。
3. `.env` 中 `DATABASE_URL` 指向该库，`SNAPSHOT_DIR` 可写（默认 `./data/snapshots`）。
4. `pnpm db:migrate` 已执行。
5. 不需要配置任何 provider 或模型：脚本注入的是 `src/lib/testing/stub-llm.ts`，
   不会调用 `bulk` / `quality` 链，也不需要外网。

## 命令

```bash
# 自建 run + 3 个 fixture 来源与快照，跑完 S2–S6 后删除自建数据
pnpm exec tsx scripts/acceptance.ts

# 在已有 sources 的 run 上跑；数据全部保留（供人工检查报告页）
pnpm exec tsx scripts/acceptance.ts --run 123
```

退出码：

| 码 | 含义 |
| ---: | --- |
| 0 | 全部断言通过 |
| 1 | 某阶段失败或某条断言失败 |
| 2 | 环境/参数不可用（数据库连不上、`--run` 不存在、该 run 已有已接受证据、参数错误） |

`--run` 模式优先使用该 run 已有的 sources；若一条也没有，才插入 3 个 fixture 来源（并保留），
否则直接使用已有来源。若该 run **已有已接受证据**，脚本以退出码 2 拒绝执行：
S3 的 `opportunities` 是追加写入的，重跑会让同一批证据支撑两个机会，验收数字不再可比。
需要在新 run 上验收，或先清空该 run 的 evidence。

## 假模型做了什么

`createStubLlm()` 按 schema 顶层键路由，每个回答仍然经过调用方的 schema 校验：

| schema 特征 | 阶段 | 假回答 |
| --- | --- | --- |
| `items` | S2 抽取 | 从 prompt 正文里取第一句（按 `。！？\n` 切；不足 4 字取前 20 字）作为 quote；signal 依次轮换 `problem → seeking → paying → switching → recurring`；每页 1 条 |
| `clusters` | S3 聚类 | 取 prompt 中前 6 个 `id=` 的 id，组成 1 个 cluster（固定名称/定位）；prompt 没有 id 时返回空数组 |
| `acquisition` 等 | S4 评分 | 获客/收入/技术三项都选档位 2，`evidenceIds` 取 prompt 中前 3 个 id |
| `sections` | S5/S6 报告 | 八节各 1 条 claim，引用 prompt 白名单第一个 id；`finance` 额外一条引用不存在 id 的 claim，用来验证 S5 会把它移进 `unknowns` |

fixture 页面是 3 段虚构中文文本（库存同步场景），每段对应一个独立来源，目的只是让
S3 的「≥3 个独立来源」闸门有输入。它们不是真实网页，也不应被引用为市场证据。

## 断言的含义

| 断言 | 证明了什么 |
| --- | --- |
| 已接受证据 ≥1 | S2 至少把一条候选写进 `evidence` 且 `rejected_reason = null` |
| 每条已接受 quote 能用 `gateQuote` 在快照中再次定位 | 存下来的 quote 是快照的原文子串；S2 的 gate 判定与快照一致 |
| 机会 ≥1、`independentSources ≥3` | S3 的独立性阈值是按「不同 sourceId」计算的，且模型不能靠重复引用同一页凑数 |
| 评分恰好 7 行、总分 ≤100 | S4 写入了完整 rubric，`scores` 是替换而不是追加；每维上限使总分不可能超过 100 |
| 报告落库、八节齐全且每节 ≥1 条 claim | S5 的 schema 与 S6 的持久化都写全了八节 |
| `validateReport` 通过 | 报告头部的总分与 `scores` 求和一致；每条 claim 都有引用 |
| `citations` 非空 | `saveReport` 把 claim → evidence 的引用轨迹写进了 `citations` |
| `finance` 的无引用 claim 在 `reports.unknowns` 中、且不在正文 | S5 的 `sanitizeSection` 会把不可追溯的 claim 移出正文，而不是带着坏引用发布 |
| 假模型调用包含 `extract`/`cluster`/`ordinals`/`sections` | 四个模型调用点都真的被执行过，不是阶段短路后伪造的摘要 |

**这些断言只覆盖结构契约**：不检查 quote 是否切题、聚类是否合理、档位是否准确、
报告 prose 是否有价值。真实抽取质量必须用人工标注集测（见 `docs/eval.md`），
且不得把本脚本的输出写进那张表的 recall/precision。

## 预期输出（示例）

同一台机器上的真实运行结果（run id、报告 id 与耗时每次不同）：

```text
## 全链路契约验收摘要

> 假模型输出仅用于验证 S2–S6 的管道契约（闸门、独立性、评分、校验、落库），不代表真实抽取质量。

- run：#45（新建 run（结束后清理））
- 来源：3
- 假模型调用序列：extract → extract → extract → cluster → ordinals → sections
- 清理策略：结束后删除自建 run 与快照

| 阶段 | 结果 | 耗时 |
| --- | --- | ---: |
| S2 抽取 | 接受 3 · 拒绝 0 · 读取失败 0 | 15 ms |
| S3 聚类 | 机会 1 · 独立性不足丢弃 0 | 8 ms |
| S4 评分 | 已评分 1 · 决策：建议先验证，再开发 ×1 | 12 ms |
| S5/S6 报告 | #31 · 总分 49/100 · 可信度 B · 决策 建议先验证，再开发 · claim 8 · 引用 8 · 未知 1 · 8 节 | 15 ms |

总耗时：199 ms

### 断言

- ✅ 已接受证据 ≥1（实际 3）
- ✅ 每条已接受 quote 都能用 gateQuote 在快照中再次定位
- ✅ 机会 ≥1（实际 1）
- ✅ independentSources ≥3（最小 3）
- ✅ 评分恰好 7 行（实际 7）
- ✅ 总分 49 ≤ 100
- ✅ 报告已落库
- ✅ 八节齐全且每节至少 1 条 claim
- ✅ validateReport 通过
- ✅ citations 非空（实际 8）
- ✅ finance 的无引用 claim 已移入 reports.unknowns
- ✅ 该 claim 不在正文 claims 中
- ✅ 假模型调用包含 extract/cluster/ordinals/sections

### 清理（自建数据）
- run #45 已删除（级联 thread/idea、sources、evidence、opportunities、scores、reports、citations、events、messages）
- 本 run 残留：sources 0 · evidence 0 · opportunities 0 · reports 0 · citations 0
- 快照：删除 3 个（仍被其他 run 引用而保留 0 个）
- 全库计数（清理后）：runs 4 · sources 23 · evidence 3 · opportunities 1 · reports 1
```

最后一行是「清理后计数」：脚本删除自建 idea（级联到 thread/run/全部子表），再删除不再被
任何 `sources` 行引用的快照文件。快照是内容寻址的，因此若同一段文本仍被别的 run 引用，
文件会保留并计入「仍被其他 run 引用而保留」。全库计数应与运行前一致。

## 已知边界

- 假模型的 `signal` 只有前三次调用会被用到（3 个 fixture 页面），所以「已付费」恰好 1 条；
  这不是真实分布。
- 自建模式固定为 3 个 fixture 来源，假模型每页 1 条、signal 按顺序轮换，因此总分固定为
  49、可信度 B、决策「建议先验证，再开发」。数字稳定是刻意的（便于发现回归），也正因此
  不能用来评估模型或方向；`--run` 模式的总分会随该 run 的来源数量与信号分布变化。
- `--run` 的保留模式会写入真实数据库行；确认可以污染该 run 后再使用。
- 脚本不写阶段事件（只有 `createRun` 留下的 `run.created`），也不改 `runs.status`：它验收的是
  阶段契约，不是 worker 的调度与状态机；后者由 worker 与 SSE 的单测覆盖。

## 相关文件

- 脚本：`scripts/acceptance.ts`
- 假模型：`src/lib/testing/stub-llm.ts`（**仅测试/脚本使用，生产代码不得导入**）
- 摘要纯函数：`src/lib/testing/acceptance-summary.ts`
- 单测：`src/lib/testing/{stub-llm,acceptance-summary}.test.ts`
- 真实抽取质量评估：`docs/eval.md`
