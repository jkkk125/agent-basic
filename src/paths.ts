import { homedir } from 'node:os';
import { join, resolve } from 'node:path';

/** 用户数据根目录：~/.coda */
export function getCodaHome(): string {
  return join(homedir(), '.coda');
}

/** SQLite 数据库文件路径：~/.coda/coda.db */
export function getDbPath(): string {
  return join(getCodaHome(), 'coda.db');
}

/**
 * Drizzle SQL 迁移目录。
 * 基于当前模块自身位置寻址，避免发到 npm 后在任意工作目录启动时找不到迁移文件。
 */
export function getMigrationsDir(): string {
  return resolve(import.meta.dirname, 'drizzle/migrations');
}
