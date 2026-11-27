import { styleText } from 'node:util'
import { getActiveModelConfig } from '../config.ts'
import { getLatestRoundUsage, loadHistory } from '../session.ts'
import type { SlashCommand } from './types.ts'

export const contextCommand: SlashCommand = {
  name: '/context',
  description: '查看当前模型、会话上下文构成与最近一轮 token 统计',
  execute: async (_input, ctx) => {
    const active = getActiveModelConfig()
    const sessionId = ctx.getSessionId()
    const history = sessionId ? await loadHistory(sessionId) : []

    const lines: string[] = [
      `当前模型：${active ? `${active.alias} (${active.modelId} @ ${active.providerName})` : '（尚未配置）'}`,
      `当前会话：${sessionId ?? '（尚未创建）'}`,
      `上下文消息数：${history.length}`,
    ]

    if (history.length > 0) {
      const byType = new Map<string, { count: number; chars: number }>()
      let totalChars = 0
      for (const item of history) {
        const type = item.type ?? 'unknown'
        const chars = JSON.stringify(item).length
        totalChars += chars
        const entry = byType.get(type) ?? { count: 0, chars: 0 }
        entry.count += 1
        entry.chars += chars
        byType.set(type, entry)
      }

      lines.push(`当前上下文总字符数（JSON）：${totalChars}`)
      const sorted = [...byType.entries()].sort((a, b) => b[1].chars - a[1].chars)
      for (const [type, stat] of sorted) {
        const pct = totalChars > 0 ? ((stat.chars / totalChars) * 100).toFixed(1) : '0.0'
        lines.push(`  - ${type}: ${stat.count} 条，${stat.chars} 字符（${pct}%）`)
      }
    }

    if (sessionId) {
      const latest = await getLatestRoundUsage(sessionId)
      if (latest) {
        const cached = latest.input_tokens_details?.cached_tokens ?? 0
        const hitRate = latest.input_tokens > 0
          ? ((cached / latest.input_tokens) * 100).toFixed(1)
          : '0.0'
        lines.push(
          `最近一轮实测（agent_round）：input_tokens=${latest.input_tokens}，cached_tokens=${cached}（命中率 ${hitRate}%），output_tokens=${latest.output_tokens}，input_item_count=${latest.input_item_count ?? 'null'}`,
        )
      } else {
        lines.push('最近一轮实测：暂无 agent_round 记账记录')
      }
    }

    process.stdout.write(styleText('blueBright', `${lines.join('\n')}\n`))
  },
}
