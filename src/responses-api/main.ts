import 'dotenv/config'
import { OpenAI } from 'openai'
import { createInterface } from 'readline/promises'
import { styleText } from 'node:util'
import { createToolRegistry } from './tools/registry.ts'
import { createSession, generateSessionNameByQuestion, loadHistory, saveTurn } from './session.ts'
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

async function main() {
  const [key, value] = process.argv.slice(2)
  let sessionId: string | undefined = undefined
  let history: OpenAI.Responses.ResponseInput = []
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
      
  
      const { items, rounds } = await ask(question, history, {
        client: openai,
        model,
        instructions,
        registry,
        onEvent: renderEvent,
      })
      await saveTurn(sessionId!, history.length, items, rounds)
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
