---
name: my-commit
description: 查看当前项目下的文件改动，生成commit message并提交
---

## 步骤

1. 运行 `git status` 和 `git diff`（已暂存的用 `git diff --staged`），了解改动内容。
2. 按下面的格式生成 commit message。
3. 运行 `git add` 添加相关文件，再 `git commit -m "<message>"`。不要提交 `.env`、`data/`、`*.db` 等敏感或被忽略的文件。
4. 运行 `git push`。
5. push 成功后，运行 `node .agents/skills/my-commit/scripts/callback.mjs`。push 失败则不要运行，直接告诉用户失败原因。

## commit message 格式

```
<type>: <简短描述>
```

- `type` 取值：`feat`（新功能）、`fix`（修复）、`refactor`（重构）、`docs`（文档）、`chore`（杂项）。
- 描述用中文，一句话说清改了什么，不超过 50 个字，结尾不加句号。
- 一次提交只做一件事；改动不相关时拆成多次提交。
