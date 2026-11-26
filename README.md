# agent-basic

用 TypeScript 学习 agent 机制的实验项目：Responses API 流式输出、工具调用、MCP、skills、会话持久化。

```bash
pnpm install
pnpm exec tsx src/main.ts                    # 启动，第一次提问时创建新会话
# 运行中：/context 查看上下文占用，/compact [关注点] 压缩上下文，/session <uuid> 切换会话，/exit 退出
```

配置见 `AGENTS.md` 的 Security & Configuration 一节。

## 项目目标与协作方式

这是学习项目，目标是理解 agent 的各个机制，而不是快速得到一个成品。

- AI 先讲清楚概念、取舍和要关注的重点，再指出代码里对应的位置。
- 每一步尽量小、可观察，用日志或 `agent_usage` / `agent_messages` 的数据来验证。
- 做完一步，在 `CHANGELOG.md` 里补一条（改了什么、为什么、怎么验证、哪些没验证）。

该约定同样写在 `AGENTS.md` 里，后续对话都适用。

## 文档索引

- `AGENTS.md`：仓库结构、开发命令、代码风格和协作约定。
- `CHANGELOG.md`：每次改动的记录，最新的在前。
- `docs/learning-log.md`：2026-11-18 及之前的探索和拆分记录（历史，不再追加）。

