# Repository Guidelines

## Project Structure & Module Organization

This repository contains TypeScript experiments with OpenAI APIs, MCP tools, and a persistent command-line agent.

- `src/responses-api/main.ts`: interactive agent, streaming events, conversation history, and usage persistence.
- `src/responses-api/tools.ts`: tool definitions, shell/file operations, and MCP integration; `applyDiff.ts` handles patches.
- `src/drizzle/`: SQLite connection (Node built-in `node:sqlite` via `drizzle-orm/node-sqlite`), table definitions in `schema.ts`, and generated migrations.
- Other `src/*.ts` files: standalone function-calling and structured-output examples.

There are no dedicated test or asset directories.

## Build, Test, and Development Commands

Use pnpm; `package.json` declares pnpm `^11.13.1`.

- `pnpm install`: install dependencies.
- `pnpm exec tsx src/responses-api/main.ts`: start the interactive agent from the repository root.
- `pnpm exec tsx src/responses-api/main.ts --session <uuid>`: resume a stored session; enter `/exit` to quit.
- `pnpm exec tsx src/index.ts`: run the standalone function-calling example.
- `pnpm exec tsc --noEmit`: check types without generating JavaScript.
- `pnpm exec drizzle-kit generate`: generate migrations from schema changes for review.
- `pnpm exec drizzle-kit migrate`: apply migrations to the configured database; verify the target first.

There is no build script. `pnpm test` is a placeholder that exits with an error.

## Coding Style & Naming Conventions

Use strict TypeScript and ESM, two-space indentation, explicit `.ts` extensions for relative imports, and type-only imports where appropriate. Match the surrounding file's quote and semicolon style; no formatter or linter is configured. Use camelCase for functions and variables, PascalCase for types, and snake_case for database identifiers. Keep examples simple and streaming/tool data flow observable.

## Testing Guidelines

No test framework or coverage threshold is configured. Run the type check and exercise the affected example with development credentials. For agent changes, verify streaming output, tool results, and session resume as applicable. Add automated tests when they provide meaningful regression coverage; document verification steps and any checks that could not run.

## Commit & Pull Request Guidelines

History includes `chore: 初始化仓库`, `update`, and `删除多余文件`; no uniform convention is established. Prefer concise, descriptive subjects identifying the change. PRs should explain the behavior changed, list verification results, link relevant issues, and call out schema or configuration changes.

## Security & Configuration

Configure `API_KEY`, `BASE_URL`, `MODEL_NAME`, and `DATABASE_URL` in a local `.env`. `DATABASE_URL` is the SQLite file path (default `./data/agent.db`); the directory is created automatically at runtime, and `.env` overrides any `DATABASE_URL` already exported in your shell. `data/` and `*.db` files are git-ignored. Never commit credentials or conversation dumps. The agent can execute shell commands and modify files; use a disposable workspace when exercising these tools. Keep migration generation separate from database application.
