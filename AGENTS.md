# 仓库指南

## 项目目标与协作方式

这是一个**学习项目**，目的是理解 agent 的工作机制（流式输出、工具调用、MCP、skills、会话持久化、上下文管理）。助手的重点是帮用户理解其中的机制和取舍，而不只是交付代码。

- 先讲概念：说明这个机制为什么存在、解决什么问题、有什么取舍，然后再谈代码。
- 指出仓库中对应的关键位置（文件和函数），并点明一两个值得关注的要点。
- 把工作拆成用户能自己动手、能观察结果的小步骤。建议该打印什么日志、查询什么数据（如 `agent_usage`、`agent_messages`）、对比什么指标来验证结果。
- 当用户明显在自己思考时，优先用引导性问题或提示，而不是直接给完整答案；用户要答案时再给。
- 一个步骤完成后，建议把学到的内容记到 `README.md` 的"学习记录"一节（最新的在前）。
- 解释使用中文，除非用户切换语言；代码和标识符使用英文。

## 项目结构与模块组织

本仓库包含用 TypeScript 编写的 OpenAI API、MCP 工具实验，以及一个可持久化会话的命令行 agent。

- `src/responses-api/main.ts`：交互式 agent、流式事件、对话历史和 usage 持久化。
- `src/responses-api/tools.ts`：工具定义、shell/文件操作和 MCP 集成；`applyDiff.ts` 负责处理补丁。
- `src/drizzle/`：SQLite 连接（通过 `drizzle-orm/node-sqlite` 使用 Node 内置的 `node:sqlite`）、`schema.ts` 中的表定义，以及生成的迁移文件。
- 其他 `src/*.ts` 文件：独立的 function calling 和结构化输出示例。

仓库没有专门的测试或资源目录。

## 构建、测试与开发命令

使用 pnpm；`package.json` 声明的版本为 pnpm `^11.13.1`。

- `pnpm install`：安装依赖。
- `pnpm exec tsx src/responses-api/main.ts`：在仓库根目录启动交互式 agent。
- `pnpm exec tsx src/responses-api/main.ts --session <uuid>`：恢复已保存的会话；输入 `/exit` 退出。
- `pnpm exec tsx src/index.ts`：运行独立的 function calling 示例。
- `pnpm exec tsc --noEmit`：只做类型检查，不生成 JavaScript。
- `pnpm exec drizzle-kit generate`：根据 schema 变更生成迁移，供人工审阅。
- `pnpm exec drizzle-kit migrate`：把迁移应用到已配置的数据库；执行前先确认目标库。

没有 build 脚本。`pnpm test` 只是占位，会以错误退出。

## 代码风格与命名约定

使用 strict TypeScript 和 ESM，两空格缩进，相对路径导入显式带 `.ts` 扩展名，适用处使用 type-only 导入。引号和分号风格跟随所在文件；项目没有配置格式化工具或 linter。函数和变量用 camelCase，类型用 PascalCase，数据库标识符用 snake_case。示例保持简单，让流式输出和工具调用的数据流可观察。

## 测试指南

项目没有配置测试框架，也没有覆盖率要求。改动后运行类型检查，并用开发环境的凭据运行受影响的示例。修改 agent 时，按需验证流式输出、工具结果和会话恢复。当自动化测试能提供有意义的回归保护时再添加；记录验证步骤，以及无法运行的检查项。

## 提交与 PR 指南

历史提交包括 `chore: 初始化仓库`、`update` 和 `删除多余文件`，没有统一约定。提交标题应简洁并说明改动内容。PR 应说明行为变化、列出验证结果、关联相关 issue，并标明 schema 或配置的变更。

## 安全与配置

在本地 `.env` 中配置 `API_KEY`、`BASE_URL`、`MODEL_NAME` 和 `DATABASE_URL`。`DATABASE_URL` 是 SQLite 文件路径（默认 `./data/agent.db`），目录会在运行时自动创建，且 `.env` 会覆盖 shell 中已导出的 `DATABASE_URL`。`data/` 和 `*.db` 文件已被 git 忽略。不要提交凭据或对话导出内容。agent 可以执行 shell 命令并修改文件，试用这些工具时请使用一次性的工作目录。迁移的生成和应用要分开进行。
