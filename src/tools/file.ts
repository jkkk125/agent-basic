import pfs from 'node:fs/promises'
import { z } from 'zod'
import { defineFunctionTool } from './types.ts'
import { resolveWorkspacePath } from './workspace.ts'

export const readFileTool = defineFunctionTool({
  name: 'read_file',
  description: '读取文件内容。相对路径以项目根目录为基准，也可以传绝对路径读取其他目录的文件',
  parameters: z.object({
    path: z.string().describe('文件路径，相对路径以项目根目录为基准；绝对路径可指向项目外的目录'),
  }),
  execute: async (args) => {
    if (!args.path) {
      return '请提供文件路径'
    }
    const path = resolveWorkspacePath(args.path)
    const stat = await pfs.stat(path).catch(() => null)
    if (!stat) {
      return `${path} 文件不存在`
    }
    if (!stat.isFile()) {
      return `${path} 不是文件，read_file 只能读取文件`
    }
    const content = await pfs.readFile(path, 'utf-8')
    return content
  }
})
