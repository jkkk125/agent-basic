import 'dotenv/config'
import { OpenAI } from 'openai'
import { createInterface } from 'readline/promises'
import { styleText } from 'node:util'
import { createToolRegistry } from './tools/registry.ts'
import { createSession, generateSessionNameByQuestion, loadHistory, getSessionInfo, saveTurn } from './session.ts'
import { renderEvent } from './render.ts'
import { buildInstructions } from './prompt.ts'
import { ask } from './loop.ts'
import type { ContextState } from './context.ts'

const rl = createInterface({
  input: process.stdin,
  output: process.stdout,
})

const openai = new OpenAI({
  apiKey: process.env.API_KEY,
  baseURL: process.env.BASE_URL,
});

const model = process.env.MODEL_NAME as string

async function main() {
  // 当前会话 = 下面三个变量，切换会话时必须整体替换；没有 sessionId 表示还没创建，第一次提问时才建
  let sessionId: string | undefined = undefined
  let history: OpenAI.Responses.ResponseInput = []
  // 上下文状态；切换会话后没有实测值（lastInputTokens=0），发一次请求后才会有
  let contextState: ContextState = { boundary: 0, lastInputTokens: 0 }

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
          contextState = { boundary: 0, lastInputTokens: 0 }
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

  
      // 每轮结束即落库。这里不能提前 history.push：ask 每轮请求用的是 [...history, ...items]，
      // 提前推进会让同一批 item 被重复发送，所以只记下一条消息的 position
      const currentSessionId = sessionId
      let nextPosition = history.length
      const { items, state } = await ask(question, history, contextState, {
        client: openai,
        model,
        instructions,
        registry,
        onEvent: (event) => {
          renderEvent(event)
          if (event.type === 'round_commit') {
            saveTurn(currentSessionId, nextPosition, event.items, [event.round])
            nextPosition += event.items.length
          }
        },
      })
      history.push(...items)
      contextState = state
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
