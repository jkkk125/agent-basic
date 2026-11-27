import { styleText } from 'node:util'
import { generateCompactSummary, toCompactionSummaryItem } from '../compact.ts'
import { loadHistory, saveCompactionSummary } from '../session.ts'
import type { SlashCommand } from './types.ts'

export const compactCommand: SlashCommand = {
  name: '/compact',
  description: '手动压缩当前会话上下文，用法：/compact [额外关注点]',
  execute: async ({ raw }, ctx) => {
    const runtime = ctx.getRuntime()
    if (!runtime) {
      process.stdout.write(styleText('yellowBright', '尚未配置默认模型，无法生成压缩摘要\n'))
      return
    }

    const sessionId = ctx.getSessionId()
    if (!sessionId) {
      process.stdout.write(styleText('blueBright', '当前还没有可压缩的对话历史\n'))
      return
    }

    const history = await loadHistory(sessionId)
    if (history.length === 0) {
      process.stdout.write(styleText('blueBright', '当前还没有可压缩的对话历史\n'))
      return
    }

    const focus = raw.slice('/compact'.length).trim() || undefined
    process.stdout.write(styleText('blueBright', '正在生成上下文摘要...\n'))
    try {
      const result = await generateCompactSummary(history, {
        client: runtime.client,
        model: runtime.config.modelId,
        instructions: runtime.instructions,
        tools: runtime.registry.specs,
        focus,
      })
      const beforeCount = history.length
      const summaryItem = toCompactionSummaryItem(result.summary)
      // 落库即生效：后续 loadHistory 会自动从最新 compaction_summary 起加载
      saveCompactionSummary(sessionId, summaryItem, result)

      process.stdout.write(styleText('greenBright', `\n--- 压缩摘要 ---\n${result.summary}\n--- 摘要结束 ---\n`))
      process.stdout.write(styleText('blueBright', `上下文已压缩：${beforeCount} 条 → 1 条\n`))
      if (result.usage) {
        const cached = result.usage.input_tokens_details?.cached_tokens ?? 0
        const hitRate = result.usage.input_tokens > 0
          ? ((cached / result.usage.input_tokens) * 100).toFixed(1)
          : '0.0'
        process.stdout.write(styleText(
          'blueBright',
          `摘要请求 usage：input_tokens=${result.usage.input_tokens}，cached_tokens=${cached}（命中率 ${hitRate}%），output_tokens=${result.usage.output_tokens}，input_item_count=${result.input_item_count}\n`,
        ))
      }
    } catch (e) {
      process.stdout.write(styleText('redBright', `生成摘要失败：${(e as Error).message}\n`))
    }
  },
}
