import { styleText } from 'node:util'
import { listMemories, readMemory } from '../memory/store.ts'
import {
  MEMORY_BUCKETS,
  MEMORY_SCOPES,
  type MemoryBucket,
  type MemoryRecordSummary,
  type MemoryScope,
} from '../memory/types.ts'
import type { SlashCommand } from './types.ts'

function formatBucketLines(label: string, items: MemoryRecordSummary[]): string[] {
  if (items.length === 0) {
    return [`  ${label}：无`]
  }
  return [
    `  ${label}（${items.length} 条）：`,
    ...items.map((item) => {
      const desc = item.description ? ` — ${item.description}` : ''
      return `    - [${item.type}] ${item.title}${desc} (${item.file})`
    }),
  ]
}

export const memoryCommand: SlashCommand = {
  name: '/memory',
  description: '查看当前全局与项目长期记忆（/memory [list | show <scope> <bucket> <file>]）',
  execute: async ({ args }) => {
    const sub = args[0] ?? 'list'

    if (sub === 'list') {
      const listing = await listMemories()
      const lines = [
        `当前项目边界（projectRoot）：${listing.projectRoot}`,
        `全局记忆目录：${listing.globalDir}`,
        ...formatBucketLines('正式记忆 entries', listing.global.entries),
        ...formatBucketLines('待整理收件箱 inbox', listing.global.inbox),
        `项目记忆目录：${listing.projectDir}`,
        ...formatBucketLines('正式记忆 entries', listing.project.entries),
        ...formatBucketLines('待整理收件箱 inbox', listing.project.inbox),
        '提示：所有记忆均为明文 Markdown，可直接打开上述目录编辑/删除，或用 /memory show <scope> <bucket> <file> 查看全文。',
      ]
      process.stdout.write(styleText('blueBright', `${lines.join('\n')}\n`))
      return
    }

    if (sub === 'show') {
      const [, scopeArg, bucketArg, fileArg] = args
      if (
        !scopeArg
        || !bucketArg
        || !fileArg
        || !(MEMORY_SCOPES as readonly string[]).includes(scopeArg)
        || !(MEMORY_BUCKETS as readonly string[]).includes(bucketArg)
      ) {
        process.stdout.write(styleText('yellowBright', '用法：/memory show <global|project> <entries|inbox> <文件名.md>\n'))
        return
      }

      try {
        const record = await readMemory({
          scope: scopeArg as MemoryScope,
          bucket: bucketArg as MemoryBucket,
          file: fileArg,
        })
        if (!record) {
          process.stdout.write(styleText('yellowBright', `未找到记忆文件：${scopeArg}/${bucketArg}/${fileArg}\n`))
          return
        }
        process.stdout.write(styleText('blueBright', `路径：${record.path}\n`))
        process.stdout.write(`${record.raw}\n`)
      } catch (error) {
        process.stdout.write(styleText('redBright', `读取记忆失败：${(error as Error).message}\n`))
      }
      return
    }

    process.stdout.write(styleText('yellowBright', '用法：/memory 或 /memory show <global|project> <entries|inbox> <文件名.md>\n'))
  },
}
