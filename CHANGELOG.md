# Changelog

按日期倒序，新记录写在最前面。每条记：改了什么、为什么、怎么验证、哪些还没验证。
2026-11-18 及之前的探索和拆分记录在 `docs/learning-log.md`，不再往那里追加。

## 2026-11-20

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
- `lastInputItemCount` 只在内存里。重启后恢复会话时它是 0，已经压缩过的历史会被按原始大小估算，结果偏高、更早触发压缩（保守方向）。可以以后从 `agent_usage.input_item_count` 恢复。

### 验证

- `pnpm exec tsc --noEmit` 通过。
- 尚未用真实模型验证。建议：把 `COMPACT_HIGH_TOKENS` 临时改成 8000，读一个大文件后看 `context_compacted` 是否比修复前早一轮出现，并把“当前估算”和下一轮 `agent_usage.input_tokens` 对比；再用 `--session` 恢复一个长会话，看第一次请求前是否已经压缩。

## 2026-11-18

### Changed

- 按职责拆分模块：`main.ts`（入口）、`loop.ts`（`ask()` 循环）、`context.ts`（`buildInput()`）、`prompt.ts`、`render.ts`、`session.ts`、`tools/`（每个工具一个文件，`registry.ts` 汇总）。详细背景见 `docs/learning-log.md`。
- 行为变化：工具按模型输出顺序执行；未知工具名直接报错而不是转发给 MCP；工具重名时启动报错。
