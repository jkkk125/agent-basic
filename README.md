# agent-basic

用 TypeScript 学习 agent 机制的实验项目：Responses API 流式输出、工具调用、MCP、skills、会话持久化。

```bash
pnpm install
pnpm exec tsx src/responses-api/main.ts                    # 新会话
pnpm exec tsx src/responses-api/main.ts --session <uuid>   # 恢复会话，/exit 退出
```

配置见 `AGENTS.md` 的 Security & Configuration 一节。

## 项目目标与协作方式

这是学习项目，目标是理解 agent 的各个机制，而不是快速得到一个成品。

- AI 先讲清楚概念、取舍和要关注的重点，再指出代码里对应的位置。
- 每一步尽量小、可观察，用日志或 `agent_usage` / `agent_messages` 的数据来验证。
- 做完一步，在下面的学习记录里补一条。

该约定同样写在 `AGENTS.md` 里，后续对话都适用。

## 学习记录

按时间倒序，新记录追加在最前面。

### 2026-11-17 上下文管理：先量一下现状

**问题**：`ask()` 每次请求都发送 `[...history, ...items]`，历史只增不减，对话越长每轮 `input_tokens` 越高。

**数据**（来自本地 `data/agent.db`，`agent_usage` 和 `agent_messages` 两张表）：

- 单个会话单轮 `input_tokens` 最高到 50462，一个 16 轮的提交会话就是这样涨上去的。
- `agent_messages` 里 `function_call_output`（工具输出）共 95 条、约 397k 字符，占全部消息的 70% 以上；`reasoning` 约 56k，`message` 约 41k。

**结论**：上下文膨胀的主要来源是工具输出，不是对话文本。所以第一步优先处理工具输出，而不是先做整段历史摘要。

**接下来的计划**（按顺序，做完一步在这里补一条记录）：

1. 旧工具输出替换成占位符，只保留最近几轮的完整内容。
2. 用 `usage.input_tokens` 判断是否接近上限，超过阈值再对更早的历史做摘要。
3. 对比 `agent_usage` 里压缩前后的 `input_tokens` 和 `cached_tokens`，验证效果。

**要留意**：改历史会破坏前缀，影响 `cached_tokens` 命中率，替换时机要想清楚。
