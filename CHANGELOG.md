# Changelog

按日期倒序，新记录写在最前面。每条记：改了什么、为什么、怎么验证、哪些还没验证。
2026-11-18 及之前的探索和拆分记录在 `docs/learning-log.md`，不再往那里追加。

## 2026-11-23

### Removed

- 去掉自动压缩：删除 `estimateContextTokens`、`advanceBoundary`，以及只给它们用的 `COMPACT_HIGH_TOKENS`、`KEEP_RECENT_OUTPUTS`、`CHARS_PER_TOKEN`；`loop.ts` 的 `ask()` 不再在每轮请求前估算和推进边界；`context_compacted` 事件连同 `render.ts` 里的展示一起删除。
- `ContextState` 去掉 `lastInputItemCount`，只剩 `boundary` 和 `lastInputTokens`。

### Why

- 单阈值触发会抖动：压到阈值附近后，几乎每次提问都又超阈值。而且只要还有旧输出可压，“保留最近 8 个”的窗口每回合都会往后滑一格，边界跟着前进，从被替换的那个位置往后的前缀全变，缓存命中率会变差。要缓解得做高低水位（压到明显低于阈值才停），动作也要从“按个数”改成“按目标 token”。
- 自动压缩在用户不知道的时候改变发给模型的内容，不好观察和对比。改成用户主动 `/compact`，时机由人决定，没有抖动。
- 方向调整：`/compact` 计划做成“让模型总结旧上下文”，而不是只替换工具输出。替换工具输出只作为摘要前的前置步骤（先把旧的长工具输出换成占位符，再交给摘要模型，让摘要请求更小）。

### Kept

- `buildInput` 和 `boundary` 保留。现在没有代码推进 `boundary`，它恒为 0，`buildInput` 等于原样返回，所以上下文会一路增长，直到 `/compact` 做出来。
- `lastInputTokens` 仍然在 `recordResponse` 里记录，但暂时没有人读，留给之后的“每次提问结束后提示上下文大小”和 `/context` 命令。

### 已知局限 / 待办

- `main.ts` 里的 `/compact` 目前只是占位：只打印 `compact`，之后没有 `continue`，会继续把它当问题发给模型。
- 摘要要持久化：摘要文本由模型生成，不能像占位符那样由 `boundary` 重新算出来，恢复会话（`--session`）时需要一个存放位置（`agent_sessions` 加列或新表），且不应写进 `agent_messages`，那里存的是原始记录。
- 摘要的切点不能把 `function_call` 与其输出、`reasoning` 与其后续 item 切开；建议只落在某条用户消息之前。
- 摘要请求带着 `function_call` 条目，是否要同时传 `tools`、`reasoning` item 是否要剔除，取决于所用接口，需要实测。

### 验证

- `pnpm exec tsc --noEmit` 通过；`src` 里搜不到 `advanceBoundary`、`estimateContextTokens`、`lastInputItemCount`、`context_compacted`、`COMPACT_HIGH_TOKENS`、`KEEP_RECENT_OUTPUTS` 的残留。
- 尚未用真实模型验证。建议：跑一个会读大文件的会话，确认不再出现“上下文压缩”那行，并查 `agent_usage`，同一会话的 `input_tokens` 应该只涨不落。

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
