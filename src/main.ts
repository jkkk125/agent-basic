import 'dotenv/config'
import { OpenAI } from 'openai'
import { createInterface } from 'readline/promises'
import { styleText } from 'node:util'
import { createToolRegistry } from './tools/registry.ts'
import { createSession, generateSessionNameByQuestion, getLatestRoundUsage, getSessionInfo, loadHistory, saveTurn } from './session.ts'
import { renderEvent } from './render.ts'
import { buildInstructions } from './prompt.ts'
import { ask } from './loop.ts'
const rl = createInterface({
  input: process.stdin,
  output: process.stdout,
})

const openai = new OpenAI({
  apiKey: process.env.API_KEY,
  baseURL: process.env.BASE_URL,
});

const model = process.env.MODEL_NAME as string

async function printContextInfo(
  sessionId: string | undefined,
  history: OpenAI.Responses.ResponseInput,
) {
  const lines: string[] = [
    `当前会话：${sessionId ?? '（尚未创建）'}`,
    `上下文消息数：${history.length}`,
  ]

  if (history.length > 0) {
    const byType = new Map<string, { count: number, chars: number }>()
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

    lines.push(`内存上下文总字符数（JSON）：${totalChars}`)
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
}

async function main() {
  // 当前会话 = 下面两个变量，切换会话时必须整体替换；没有 sessionId 表示还没创建，第一次提问时才建
  let sessionId: string | undefined = undefined
  let history: OpenAI.Responses.ResponseInput = []

  const [registry, instructions] = await Promise.all([
    createToolRegistry(model),
    buildInstructions(model)
  ])

  try {
    while (true) {
      const question = await rl.question('你 > ').then(v => v.trim())

      if (!question) {
        process.stdout.write(styleText('blueBright', '输入为空，请重新输入\n'))
        continue
      }

      if (question === '/exit') {
        process.stdout.write(styleText('blueBright', '退出程序\n'))
        break
      }

      if (question === '/context') {
        await printContextInfo(sessionId, history)
        continue
      }

      if (question === '/compact') {
        console.log('compact')
        continue
      }

      const [command, targetId] = question.split(/\s+/)
      if (command === '/session') {
        if (!targetId) {
          process.stdout.write(styleText('blueBright', `当前会话：${sessionId ?? '（尚未创建）'}\n用法：/session <会话 id>\n`))
          continue
        }
        try {
          // 先加载，成功了再替换：loadHistory 在会话不存在时会抛错，失败时当前会话原样保留
          const [sessionInfo, sessionHistory] = await Promise.all([
            getSessionInfo(targetId),
            loadHistory(targetId),
          ])
          // const sessionName = 
          sessionId = targetId
          history = sessionHistory
          process.stdout.write(styleText('blueBright', `已切换到会话 sessionId: ${sessionId} name: ${sessionInfo.name}，共 ${history.length} 条消息\n`))
        } catch (e) {
          process.stdout.write(styleText('redBright', `切换会话失败：${(e as Error).message}\n`))
        }
        continue
      }

      if (!sessionId) {
        process.stdout.write(styleText('blueBright', '开始生成会话名称...'))
        const sessionName = await generateSessionNameByQuestion(openai, model, question)
        process.stdout.write(styleText('blueBright', `会话名称生成完成，会话名称：${sessionName.name}\n`))
        sessionId = await createSession(sessionName)
      }


      // 每轮结束即落库。这里仍不能提前 history.push：ask 每轮请求用的是 [...history, ...items]，
      // 提前推进会让同一批 item 被重复发送；落库 position 由 saveTurn 在事务内按 SQL 顺延
      const currentSessionId = sessionId
      const { items } = await ask(question, history, {
        client: openai,
        model,
        instructions,
        registry,
        onEvent: (event) => {
          renderEvent(event)
          if (event.type === 'round_commit') {
            saveTurn(currentSessionId, event.items, [event.round])
          }
        },
      })
      history.push(...items)
    }
  } finally {
    await registry.close()
  }
}


main().catch(e => {
  console.error(e)
  process.stdout.write(styleText('redBright', `异常退出程序: ${e.message}\n`))
}).finally(async () => {
  rl.close()
})

// 程序入口结束
