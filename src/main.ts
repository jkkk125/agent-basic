import 'dotenv/config'
import { OpenAI } from 'openai'
import { createInterface } from 'readline/promises'
import { styleText } from 'node:util'
import { createToolRegistry } from './tools/registry.ts'
import { createSession, generateSessionNameByQuestion, loadHistory, saveTurn } from './session.ts'
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
  const [key, value] = process.argv.slice(2)
  let sessionId: string | undefined = undefined
  let history: OpenAI.Responses.ResponseInput = []
  // 上下文压缩状态；恢复会话时没有实测值（lastInputItemCount=0），
  // 第一次请求前会把整段历史按字符数估算，所以过长的历史不用等一次请求才被压缩
  let contextState: ContextState = { boundary: 0, lastInputTokens: 0, lastInputItemCount: 0 }
  if (key === '--session') {
    sessionId = value
    console.log(`[${sessionId}] 开始加载历史会话... \n`)
    history = await loadHistory(sessionId)
    console.log(`[${sessionId}] 历史会话加载完成，共 ${history.length} 条消息\n`)
  }

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
