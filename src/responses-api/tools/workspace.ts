import { isAbsolute, resolve } from 'node:path'

/** 所有工具共用的默认根目录：相对路径都以它为基准；绝对路径可以直接指向其他目录 */
export const WORKSPACE_ROOT = process.cwd()

/** 相对路径锚定工作区，绝对路径原样使用；默认在工作区内，显式给绝对路径就能操作别的目录 */
export function resolveWorkspacePath(path: string): string {
  const trimmed = path.trim()
  return isAbsolute(trimmed) ? resolve(trimmed) : resolve(WORKSPACE_ROOT, trimmed)
}
