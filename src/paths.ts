import { createHash } from 'node:crypto';
import { existsSync, realpathSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';

/** 用户数据根目录：默认 ~/.coda，允许通过 CODA_HOME 覆盖以便隔离测试 */
export function getCodaHome(): string {
  const override = process.env.CODA_HOME?.trim();
  return override ? resolve(override) : join(homedir(), '.coda');
}

/** SQLite 数据库文件路径：~/.coda/coda.db */
export function getDbPath(): string {
  return join(getCodaHome(), 'coda.db');
}

/** 明文 Markdown 记忆根目录：~/.coda/memory */
export function getMemoryRoot(): string {
  return join(getCodaHome(), 'memory');
}

/**
 * 向上查找最近的 .git 作为项目根目录边界（同时兼容普通目录和 git worktree 的 .git 文件）。
 * 找不到 .git 时回退到 startDir 本身；先尝试 realpath，避免 macOS 上 /tmp 与 /private/tmp 算出不同项目 key。
 * 注意：此函数只用于“项目归属”（如项目级记忆），不改变 tools/workspace.ts 的 WORKSPACE_ROOT（仍为 process.cwd()）。
 */
export function resolveProjectRoot(startDir: string = process.cwd()): string {
  const resolved = resolve(startDir);
  let normalized = resolved;
  try {
    normalized = realpathSync(resolved);
  } catch {
    // 目录尚未创建或无权限时退回 resolve 结果
  }

  let current = normalized;
  while (true) {
    if (existsSync(join(current, '.git'))) {
      return current;
    }
    const parent = dirname(current);
    if (parent === current) {
      return normalized;
    }
    current = parent;
  }
}

/**
 * 把项目根目录绝对路径转为既可读又唯一的目录名：<清洗后的目录名>-<sha256前8位>。
 * 这样不同父目录下即使有同名的项目文件夹，也不会串到同一个记忆目录。
 */
export function getProjectKey(projectRoot: string): string {
  const rawName = basename(projectRoot)
    .replace(/[^a-zA-Z0-9._-]+/g, '-')
    .replace(/^-+|-+$/g, '');
  const slug = rawName || 'project';
  const hash = createHash('sha256').update(projectRoot).digest('hex').slice(0, 8);
  return `${slug}-${hash}`;
}

/**
 * 返回指定作用域对应的记忆目录：
 * - global  → ~/.coda/memory/global
 * - project → ~/.coda/memory/projects/<project-key>
 */
export function getScopeMemoryDir(
  scope: 'global' | 'project',
  projectRoot: string = resolveProjectRoot(),
): string {
  if (scope === 'global') {
    return join(getMemoryRoot(), 'global');
  }
  return join(getMemoryRoot(), 'projects', getProjectKey(projectRoot));
}

/**
 * Drizzle SQL 迁移目录。
 * 基于当前模块自身位置寻址，避免发到 npm 后在任意工作目录启动时找不到迁移文件。
 */
export function getMigrationsDir(): string {
  return resolve(import.meta.dirname, 'drizzle/migrations');
}
