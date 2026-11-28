import { styleText } from 'node:util'
import { consolidateMemories } from '../memory/consolidate.ts'
import { listMemories, readMemory } from '../memory/store.ts'
import {
  MEMORY_BUCKETS,
  MEMORY_SCOPES,
  type ConsolidationScopeResult,
  type MemoryBucket,
  type MemoryRecordSummary,
  type MemoryScope,
} from '../memory/types.ts'
import type { CommandContext, SlashCommand } from './types.ts'

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

function renderConsolidationReport(result: ConsolidationScopeResult): void {
  const scopeLabel = result.scope === 'global' ? '全局记忆 (global)' : '项目记忆 (project)'
  if (result.skipped) {
    process.stdout.write(styleText('blueBright', `[${scopeLabel}] inbox 为空，跳过\n`))
    return
  }

  const modeTag = result.dryRun ? '（dry-run 演练，未改动磁盘）' : ''
  const lines: string[] = [
    `\n=== 整理结果：${scopeLabel}${modeTag} ===`,
    `总结：${result.summary}`,
    `参与整理的 inbox（${result.consumedInboxFiles.length} 条）：${result.consumedInboxFiles.join(', ')}`,
  ]

  if (result.appliedActions.length === 0) {
    lines.push('文件变更：无（inbox 内容已判定为噪音或重复，entries 保持不变）')
  } else {
    lines.push(`文件变更（${result.appliedActions.length} 项）：`)
    for (const act of result.appliedActions) {
      const verb = act.action.toUpperCase()
      const meta = act.action === 'delete'
        ? ''
        : ` [${act.type}] ${act.title}${act.description ? ` — ${act.description}` : ''}`
      lines.push(`  - ${verb} entries/${act.file}${meta}`)
      lines.push(`    原因：${act.reason}`)
    }
  }

  if (!result.dryRun) {
    lines.push(`已归档至 archive/（${result.archivedInboxFiles.length} 条）：${result.archivedInboxFiles.join(', ') || '无'}`)
  }

  if (result.usage) {
    const cached = result.usage.input_tokens_details?.cached_tokens ?? 0
    lines.push(
      `本次整理 usage：input_tokens=${result.usage.input_tokens}，cached_tokens=${cached}，output_tokens=${result.usage.output_tokens}，total_tokens=${result.usage.total_tokens}`,
    )
  }

  process.stdout.write(styleText('greenBright', `${lines.join('\n')}\n`))
}

async function handleConsolidate(args: string[], ctx: CommandContext): Promise<void> {
  const runtime = ctx.getRuntime()
  if (!runtime) {
    process.stdout.write(styleText('yellowBright', '尚未配置默认模型，无法执行记忆整理\n'))
    return
  }

  let dryRun = false
  let targetScope: MemoryScope | undefined
  for (const arg of args) {
    if (arg === '--dry-run') {
      dryRun = true
    } else if ((MEMORY_SCOPES as readonly string[]).includes(arg)) {
      if (targetScope) {
        process.stdout.write(styleText('yellowBright', '用法：/memory consolidate [global|project] [--dry-run]\n'))
        return
      }
      targetScope = arg as MemoryScope
    } else {
      process.stdout.write(styleText('yellowBright', `未知参数：${arg}。用法：/memory consolidate [global|project] [--dry-run]\n`))
      return
    }
  }

  const scopes: MemoryScope[] = targetScope ? [targetScope] : [...MEMORY_SCOPES]
  process.stdout.write(styleText(
    'blueBright',
    `开始整理长期记忆（作用域：${scopes.join('、')}${dryRun ? '，dry-run 模式' : ''}）...\n`,
  ))

  try {
    const results = await consolidateMemories({
      client: runtime.client,
      model: runtime.config.modelId,
      scopes,
      dryRun,
    })

    for (const res of results) {
      renderConsolidationReport(res)
    }

    const hadActualWrite = !dryRun && results.some((r) => !r.skipped)
    if (hadActualWrite) {
      if (!ctx.getSessionId()) {
        // 还没开始任何会话时，没有 Prompt Cache 前缀可破坏，顺手刷新 runtime 让新索引立刻生效
        await ctx.reloadRuntime()
        process.stdout.write(styleText('blueBright', '已刷新系统提示中的长期记忆索引。\n'))
      } else {
        // 已有活跃会话时保持当前 instructions 冻结，保护本会话 Prompt Cache 不失效
        process.stdout.write(styleText(
          'blueBright',
          '整理已落盘。为保护当前会话的 Prompt Cache，本会话系统提示保持不变，下次启动（或切模型）后新索引自动生效。\n',
        ))
      }
    }
  } catch (error) {
    process.stdout.write(styleText('redBright', `记忆整理失败（inbox 原文已完整保留，未丢失）：${(error as Error).message}\n`))
  }
}

export const memoryCommand: SlashCommand = {
  name: '/memory',
  description: '查看或整理长期记忆（/memory [list | show <scope> <bucket> <file> | consolidate [global|project] [--dry-run]]）',
  execute: async ({ args }, ctx) => {
    const sub = args[0] ?? 'list'

    if (sub === 'list') {
      const listing = await listMemories()
      const lines = [
        `当前项目边界（projectRoot）：${listing.projectRoot}`,
        `全局记忆目录：${listing.globalDir}`,
        ...formatBucketLines('正式记忆 entries', listing.global.entries),
        ...formatBucketLines('待整理收件箱 inbox', listing.global.inbox),
        ...(listing.global.archivedCount > 0 ? [`  已归档 archive：${listing.global.archivedCount} 条`] : []),
        `项目记忆目录：${listing.projectDir}`,
        ...formatBucketLines('正式记忆 entries', listing.project.entries),
        ...formatBucketLines('待整理收件箱 inbox', listing.project.inbox),
        ...(listing.project.archivedCount > 0 ? [`  已归档 archive：${listing.project.archivedCount} 条`] : []),
        '提示：所有记忆均为明文 Markdown，可用 /memory show <scope> <bucket> <file> 查看全文，或 /memory consolidate [--dry-run] 整理收件箱。',
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

    if (sub === 'consolidate') {
      await handleConsolidate(args.slice(1), ctx)
      return
    }

    process.stdout.write(styleText(
      'yellowBright',
      '用法：/memory [list | show <global|project> <entries|inbox> <文件名.md> | consolidate [global|project] [--dry-run]]\n',
    ))
  },
}
