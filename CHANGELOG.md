# Changelog

按日期倒序，新记录写在最前面。每条记：改了什么、为什么、怎么验证、哪些还没验证。
2026-11-18 及之前的探索和拆分记录在 `docs/learning-log.md`，不再往那里追加。

## 2026-11-27

### Added

- 用户目录底座与启动自动迁移：
  - 新增 `src/paths.ts`：统一提供 `getCodaHome()`（`~/.coda`）、`getDbPath()`（`~/.coda/coda.db`）和 `getMigrationsDir()`（基于 `import.meta.dirname` 寻址，确保发包后在任意工作目录运行都能找到 SQL 迁移）。
  - `src/drizzle/index.ts` 创建目录时收紧权限为 `0o700`，并在初始化 `db` 后同步调用 `migrate(db, { migrationsFolder })` 自动建表与升级；`drizzle.config.ts` 复用 `getDbPath()` 消除路径双份硬编码。
- SQLite 模型配置双表与配置服务：
  - `src/drizzle/schema.ts` 新增 `providers`（`name`、`base_url`、`api_key`）与 `models`（`provider_id` 外键 `ON DELETE CASCADE`、`name` 别名、`model_id`、`is_active`），并为 `models.is_active` 建立部分唯一索引 `idx_models_single_active (WHERE is_active = 1)`；`agent_usage` 新增可空列 `model`。
  - 生成迁移 `src/drizzle/migrations/20261127101807_add_providers_and_models/migration.sql`。
  - 新增 `src/config.ts`：封装 Provider/Model CRUD、`maskApiKey()` 脱敏展示及 `setActiveModel()` 原子切换。
- `/model` 交互管理命令：
  - 新增 `src/model-command.ts` 并接入 `src/main.ts`，支持 `/model`、`/model add`、`/model use <别名>`、`/model rm <别名>` 以及 `/model provider [add|edit|rm]`，支持运行期热切换与编辑供应商 Key 后自动刷新当前激活运行时。

### Changed

- 彻底摆脱 `.env` 与 `dotenv`：
  - `src/main.ts` 移除 `import 'dotenv/config'` 及顶层硬编码的 `OpenAI` 实例与 `model`，改为 `AgentRuntime` 动态构建；支持无配置冷启动引导；`/context` 同步展示当前生效模型。
  - `src/tools/deepseek.ts` 改为工厂函数 `createDeepseekWebSearchTool(getApiKey)` / `createDeepseekReadUrlTool(getApiKey)`，消除对 `process.env.API_KEY` 的直接读取。
  - `src/tools/registry.ts` 将进程级 MCP 连接（`connectSharedMcp()`）与按模型组装工具表（`buildToolRegistry()`）解耦，切模型时不重连、不泄漏 MCP 连接。
  - `src/types.ts`、`src/loop.ts`、`src/compact.ts`、`src/session.ts` 透传模型名并写入 `agent_usage.model`（覆盖 `agent_round`、`session_title`、`summary`）。
  - `package.json` 预置发布元信息（`name: "@coda-ai/cli"`、`version: "0.1.0"`、`engines`、`publishConfig`），并移除 `dotenv`、`tsx` 依赖（含同步更新 `pnpm-lock.yaml`，一并移除仅由 `tsx` 引入的 `esbuild` 及其构建白名单 `pnpm-workspace.yaml`）；`README.md` 与 `AGENTS.md` 中的启动命令改为直接使用 `node src/main.ts` / `node src/index.ts`；本地 `.env` 已导入 `~/.coda/coda.db` 后与 `./data/` 一并删除。

### 学到的 / 设计取舍

- **2 张表 + 部分唯一索引优于第 3 张 `app_settings` 表（YAGNI）**：仅为了记录当前激活模型多建一张 KV 表偏重；在 `models.is_active` 上建 SQLite Partial Unique Index（`WHERE is_active = 1`），配合同步事务“先校验目标存在 → 清旧 → 置新”，由数据库引擎层保证全局最多只有一个激活模型，且未来加 `coda-desktop` 图形配置页时两表层级（Provider → Models）天然贴合。
- **切模型热更新必须拆开 MCP 连接生命周期**：MCP 连接属于进程级外部会话，而工具列表随模型变化（如 `-flash` 挂本地联网工具、`-pro` 挂服务端 `web_search`），拆开后切换模型毫秒级生效且不会泄漏连接。
- **迁移目录锚定 `import.meta.dirname`**：为后续发到 npm（`@coda-ai/cli`，命令 `coda`）铺路，用户从任意目录启动都不会因为 `process.cwd()` 变化找不到 migrations。

### 已知局限 / 待办

- 尚未配置打包构建脚本（如把 TS 编译到 `dist/`、复制 `migrations/`、加 `#!/usr/bin/env node` 与 `package.json` 的 `bin` / `files` 字段），真正执行 `pnpm publish` 前需补齐。
- `package.json` 的 `engines.node` 目前为 `>=22.5.0`（对应 `node:sqlite`），若要保证无需 flag 直接用 `node` 运行 `.ts`，需 `>=22.18.0` / `>=23.6.0`（当前开发环境为 Node 24）。

### 验证

- `./node_modules/.bin/tsc --noEmit` 通过。
- 在非项目目录 `/tmp` 下以 `CODA_HOME=/tmp/coda-step1` 连续启动两次，验证 `0o700` 权限、自动迁移幂等性及 `drizzle-kit check`。
- 用临时 `CODA_HOME` 端到端断言验证 `src/config.ts`、`buildToolRegistry()` 热切换以及 `src/model-command.ts` 全部交互分支（新增、复用供应商、切换、改 Key 热刷新、删模型、级联删供应商、部分唯一索引拦截）。
- 已将原 `.env` 配置导入 `~/.coda/coda.db` 并脱敏读回确认。
- 尚未用真实网络运行完整 REPL 验证联网调用模型、会话中 `/model use` 切换模型后 `agent_usage.model` 的实测写入。

## 2026-11-26

### Added

- `/context`：打印当前会话内存 `history` 的消息条数、按 `item.type` 分组的 JSON 字符数及占比，并查询该会话最近一条 `agent_usage`（`source = 'agent_round'`）展示实测 `input_tokens`、`cached_tokens` 命中率、`output_tokens` 与 `input_item_count`。
- 手动全量压缩 `/compact [额外关注点]`：
  - 新增 `src/compact.ts`：`generateCompactSummary()` 采用 **A1 策略**（原样复用 `instructions`、`tools` 与当前 `history`，只在末尾追加结构化总结指令的 `user` 消息）；`toCompactionSummaryItem()` 把摘要包成 `role: 'developer'` 的 `ResponseInputItem`。
  - `session.ts` 新增 `saveCompactionSummary()`：无需改动表结构，在同步事务内往 `agent_messages` 追加一条 `type = 'compaction_summary'`、`role = 'developer'` 的记录，并把摘要请求写入 `agent_usage`（`source = 'summary'`）；落库后内存 `history` 重置为 `[summaryItem]`。

### Changed

- `saveTurn()` 去掉 `startPosition` 参数，改为在 SQLite 同步事务内通过 `MAX(position) + 1`（抽为 `getNextPosition()`，与 `saveCompactionSummary()` 共用）顺延序号，不再依赖调用方内存里的 `history.length`。
- `loadHistory()` 改为先查该会话最新一条 `type = 'compaction_summary'` 的 `position`（无则为 `0`），只加载 `position >= startPosition` 的消息，避免 `/session` 切换时把已压缩的旧历史重新加载回来。
- 更新 `schema.ts` 和 `types.ts` 中 `input_item_count` 的注释，明确其语义为“本轮实际发送的 input item 条数”。

### 学到的 / 实测发现

- **`tool_choice: 'none'` 会破坏 Prompt Cache 前缀**：实测对比发现，摘要请求传 `tool_choice: 'none'` 时，服务端会把约 3000 token 的 `tools` 定义从模型输入中剥离，`input_tokens` 从 3720 骤降到 791，但前缀在第 128 token 处即分叉，`cached_tokens` 掉到 128（16.2%）。去掉 `tool_choice: 'none'`、改由提示词约束不调用工具后，同场景下 `cached_tokens` 回到 3712 / 3952（93.9%），按 64-token 缓存块几乎 100% 命中可缓存前缀。
- **携带工具调用与 `reasoning` 的摘要请求兼容性**：在含大量 `function_call` / `function_call_output` / `reasoning` 的真实会话（`99ef1c48-f90a-4300-9d3b-d00b17f9e547`，35 条消息）中，A1 摘要请求一次通过且 `cached_tokens = 6912 / 7284`（94.9%）；`role: 'developer'` 作为压缩后 `input[0]` 也被接口正常接受。
- **压缩后的缓存重建与成本曲线**（同一会话 `agent_usage` 实测）：
  - 压缩前最后一轮：`input_item_count=34`，`input_tokens=6804`，`cached_tokens=6656`（97.8%）；
  - 压缩后第 1 轮：`input_item_count=2`，`input_tokens=4653`，`cached_tokens=3328`（71.5%）——`instructions + tools` 固定前缀缓存并未失效，仅新摘要部分未命中；
  - 压缩后第 2~5 轮：命中率迅速从 91.1% 回到 97.1%。
  - 摘要输出本身消耗了 `output_tokens=1605`（含思考 token），短会话过早 `/compact` 不一定划算，高收益出现在读入大量大文件工具输出的长会话中。
- **Event Log 边界标记的取舍**：全量压 + `compaction_summary` 行追加到 `agent_messages` 实现了零迁移、二次 `/compact` 自动基于“上次摘要 + 新消息”滚动压缩；代价是若未来改成“保留最近 N 轮原始消息”，不能再简单按 `position >= latestSummaryPos` 查询。

### 已知局限 / 待办

- 当上下文已经逼近模型窗口上限时，A1 原样发送整段 `history` 仍可能超窗，后续需要按需叠加前置瘦身（先替换旧的长工具输出再摘要）作为兜底。
- 尚未处理 `response.incomplete` 中断导致 `history` 末尾残留悬空 `function_call` 的脏历史。
- 后续统计会话原始消息数时需过滤 `type != 'compaction_summary'`。

### 验证

- `pnpm exec tsc --noEmit` 通过。
- 真实模型验证（`deepseek-flash`）：
  - 对照验证去掉 `tool_choice: 'none'` 前后的 `cached_tokens` 命中率（16.2% → 93.9%）。
  - 在包含 `my-commit` 多轮工具调用的会话 `99ef1c48-f90a-4300-9d3b-d00b17f9e547` 执行 `/compact` 并继续追问多轮，核对 `agent_messages`（`position 0..34` 保留、`35` 为 `compaction_summary`、`36..52` 连续递增）与 `agent_usage`（`source = 'summary'` 及随后 `agent_round` 的 `input_tokens` / `cached_tokens` 变化）。
  - 实测 `loadHistory()`：已压缩会话只从最新 `compaction_summary` 加载（首条为 `role: 'developer'`），未压缩会话仍从 `position = 0` 全量加载。
- 尚未用真实模型验证：同一会话连续执行两次 `/compact` 后的滚动摘要质量与 `/session` 恢复。

## 2026-11-23

### Removed

- 去掉自动压缩：删除 `estimateContextTokens`、`advanceBoundary`，以及只给它们用的 `COMPACT_HIGH_TOKENS`、`KEEP_RECENT_OUTPUTS`、`CHARS_PER_TOKEN`；`loop.ts` 的 `ask()` 不再在每轮请求前估算和推进边界；`context_compacted` 事件连同 `render.ts` 里的展示一起删除。
- 清理上下文状态：`ContextState`（`boundary`、`lastInputTokens`）整体删除。`boundary` 没有代码推进、恒为 0；`lastInputTokens` 只写不读。随之删除 `ask()` 的 `state` 参数和返回值、`main.ts` 里的 `contextState` 变量，以及整个 `src/context.ts`（`buildInput`、`isToolOutput`、`MIN_COMPACT_CHARS`）。`ask()` 里 `input` 直接用 `[...history, ...items]`。
- 去掉 `--session` 启动参数，同时删除 `.vscode/launch.json` 里传这个参数的“加载历史记录”配置；`README.md`、`AGENTS.md` 的用法说明同步改成运行中的 `/session`。

### Added

- `/session <id>`：在运行中切换会话。先 `getSessionInfo` + `loadHistory` 加载，成功后才替换 `sessionId` 和 `history`；失败（如会话不存在）只打印错误，当前会话原样保留。只输入 `/session` 会显示当前会话 id 和用法。命令按空白拆成“命令 + 参数”再比较。

### Why

- 单阈值触发会抖动：压到阈值附近后，几乎每次提问都又超阈值。而且只要还有旧输出可压，“保留最近 8 个”的窗口每回合都会往后滑一格，边界跟着前进，从被替换的那个位置往后的前缀全变，缓存命中率会变差。要缓解得做高低水位（压到明显低于阈值才停），动作也要从“按个数”改成“按目标 token”。
- 自动压缩在用户不知道的时候改变发给模型的内容，不好观察和对比。改成用户主动 `/compact`，时机由人决定，没有抖动。
- 方向调整：`/compact` 计划做成“让模型总结旧上下文”，而不是只替换工具输出。替换工具输出只作为摘要前的前置步骤（先把旧的长工具输出换成占位符，再交给摘要模型，让摘要请求更小）。

### 现状与取舍

- 现在没有任何上下文压缩，上下文会一路增长，直到 `/compact` 做出来。
- 不为将来保留死代码：`buildInput`、`boundary` 都删了，做摘要时按当时的需要重写（占位符替换只是摘要前的前置步骤，切点会是一次性参数，不是跨提问的状态）。
- 之后要显示上下文大小，不需要内存状态：提问结束的提示可以用 `round_commit` 事件里的 `round.usage.input_tokens`；`/context` 按需查该会话最近一条 `agent_usage`（`source = 'agent_round'`）的 `input_tokens`。没有压缩时，它就是当前上下文的实际大小。

### 已知局限 / 待办

- `main.ts` 里的 `/compact` 目前只是占位：只打印 `compact` 后 `continue`，不做任何事。
- 切换会话时没有处理“上一轮因 `response.incomplete` 等原因中断、`history` 末尾可能是没有输出的 `function_call`”这种脏历史。
- 摘要要持久化：摘要文本由模型生成，不能由切点重新算出来，切换会话（`/session`）时需要一个存放位置（`agent_sessions` 加列或新表），且不应写进 `agent_messages`，那里存的是原始记录。
- 摘要的切点不能把 `function_call` 与其输出、`reasoning` 与其后续 item 切开；建议只落在某条用户消息之前。
- 摘要请求带着 `function_call` 条目，是否要同时传 `tools`、`reasoning` item 是否要剔除，取决于所用接口，需要实测。

### 验证

- `pnpm exec tsc --noEmit` 通过；`src` 里搜不到 `advanceBoundary`、`estimateContextTokens`、`ContextState`、`lastInputTokens`、`boundary`、`buildInput`、`context_compacted` 的残留。
- 尚未用真实模型验证。建议：
  - 跑一个会读大文件的会话，确认不再出现“上下文压缩”那行，并查 `agent_usage`，同一会话的 `input_tokens` 应该只涨不落。
  - `/session <另一个会话 id>` 后追问只有那个会话才知道的内容，模型应答得出来；查 `agent_messages`，新消息写进目标会话、`position` 连续，原会话不增行。
  - `/session 乱写的id` 应报错且程序不退出，之后提问仍写进切换前的会话。

## 2026-11-20

> 2026-11-23 起自动压缩已整体移除，下面的 `estimateContextTokens`、`advanceBoundary` 和 `lastInputItemCount` 都不再存在，保留这段是作为设计过程的记录。

### Fixed

- 上下文压缩的触发判断滞后一轮：`advanceBoundary` 只看上一轮请求的 `input_tokens`，不包含上一轮之后新增的模型输出和工具输出（例如刚读了一个大文件），要等再发一次请求才会被感知。
  - 现在用 `estimateContextTokens` 判断：上一轮实测值 + 上一轮请求之后新增 item 的字符数估算（约 3 字符 1 token）。
  - 恢复会话（`--session`）时没有实测值，整段历史按估算算，第一次请求前就能触发压缩，不用先发一次请求。

### Changed

- `ContextState` 增加 `lastInputItemCount`：上一轮请求发出时 `history + items` 的 item 总数，下标不小于它的 item 就是“还没被实测覆盖”的部分。它和 `lastInputTokens` 在 `loop.ts` 的 `recordResponse` 里成对更新，且只在 `res.usage` 存在时更新，避免新 token 数配旧 item 数。
- `advanceBoundary` 的第三个参数从 `lastInputTokens` 改为估算后的 token 数。
- `context_compacted` 事件增加 `estimated_tokens`，终端会同时显示上一轮实测值和当前估算值，便于对照。

### 设计说明

- 实测值衡量的是压缩后实际发出去的内容，原始列表（`[...history, ...items]`）比它大是预期的，不需要对齐，也不应该拿原始列表去替代实测值。只有“滞后”需要补。
- 没有做“按历史会话统计平均 token/字符比”的校准：估算只覆盖实测值之后的一小段，`/3` 的误差相对 100k 阈值可以忽略；真要校准，用最近一次请求的比例比跨会话平均更贴近当前内容。

### 已知局限

- 压缩仍然是“触发看 token、动作按个数（保留最近 8 个工具输出）”，两者脱钩。最近 8 个输出本身很大时，压缩后仍可能超阈值。
- `ContextState` 只在内存里，`--session` 恢复时整体归零（包括 `boundary`）。库里存的是完整原始记录，压缩只是发送时的视图，所以 `boundary=0` 时发出去的就是原始历史，按原始大小估算方向是对的。但这时整段历史都靠字符数估算，没有“误差只占一小段”的缓冲：
  - 中文占比高的内容（约 1~1.5 字符/token）会被 `/3` 低估；
  - instructions 和工具定义的固定开销不在历史里，也没算进去；
  - 结果是首轮可能晚一轮才触发压缩，首次响应的 `input_tokens` 回来后自行纠正。
- 不能直接从 `agent_usage` 最后一行恢复 `lastInputTokens` / `lastInputItemCount`：那个 `input_tokens` 是旧进程压缩后的大小，而重启后 `boundary` 是 0，两者对不上。要恢复，必须把 `boundary` 一起持久化。

### 验证

- `pnpm exec tsc --noEmit` 通过。
- 尚未用真实模型验证。建议：把 `COMPACT_HIGH_TOKENS` 临时改成 8000，读一个大文件后看 `context_compacted` 是否比修复前早一轮出现，并把“当前估算”和下一轮 `agent_usage.input_tokens` 对比；再用 `--session` 恢复一个长会话，看第一次请求前是否已经压缩。

## 2026-11-18

### Changed

- 按职责拆分模块：`main.ts`（入口）、`loop.ts`（`ask()` 循环）、`context.ts`（`buildInput()`）、`prompt.ts`、`render.ts`、`session.ts`、`tools/`（每个工具一个文件，`registry.ts` 汇总）。详细背景见 `docs/learning-log.md`。
- 行为变化：工具按模型输出顺序执行；未知工具名直接报错而不是转发给 MCP；工具重名时启动报错。
