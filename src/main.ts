import { OpenAI } from 'openai'
import { createInterface } from 'readline/promises'
import { styleText } from 'node:util'
import { buildToolRegistry, connectSharedMcp } from './tools/registry.ts'
import type { AgentTool } from './tools/types.ts'
import { createSession, generateSessionNameByQuestion, loadHistory, saveTurn } from './session.ts'
import { renderEvent } from './render.ts'
import { buildInstructions } from './prompt.ts'
import { ask } from './loop.ts'
import { getActiveModelConfig, type ActiveModelConfig } from './config.ts'
import { dispatchCommand } from './commands/index.ts'
import type { AgentRuntime, CommandContext } from './commands/types.ts'

const rl = createInterface({
  input: process.stdin,
  output: process.stdout,
})

async function createRuntime(
  config: ActiveModelConfig,
  mcpTools: AgentTool[],
): Promise<AgentRuntime> {
  const client = new OpenAI({
    apiKey: config.apiKey,
    baseURL: config.baseUrl,
  })
  const registry = buildToolRegistry({
    modelName: config.modelId,
    apiKey: config.apiKey,
    mcpTools,
  })
  const instructions = await buildInstructions(config.modelId)
  return { config, client, registry, instructions }
}

async function main() {
  // 进程私有状态：当前终端停留在哪个会话（undefined 表示尚未创建）；历史消息以 SQLite 为唯一事实来源
  let sessionId: string | undefined = undefined

  const mcp = await connectSharedMcp()
  const loadRuntime = async (): Promise<AgentRuntime | null> => {
    const active = getActiveModelConfig()
    return active ? createRuntime(active, mcp.tools) : null
  }

  let runtime: AgentRuntime | null = await loadRuntime()
  if (runtime) {
    process.stdout.write(styleText(
      'blueBright',
      `当前模型：${runtime.config.alias} (${runtime.config.modelId} @ ${runtime.config.providerName})\n`,
    ))
  } else {
    process.stdout.write(styleText(
      'yellowBright',
      '尚未配置默认模型。请先运行 /model add 添加供应商与模型，或输入 /help 查看全部命令。\n',
    ))
  }

  const commandCtx: CommandContext = {
    rl,
    getSessionId: () => sessionId,
    setSessionId: (nextId) => {
      sessionId = nextId
    },
    getRuntime: () => runtime,
    reloadRuntime: async () => {
      runtime = await loadRuntime()
    },
  }

  try {
    while (true) {
      const question = await rl.question('你 > ').then(v => v.trim())

      if (!question) {
        process.stdout.write(styleText('blueBright', '输入为空，请重新输入\n'))
        continue
      }

      const cmdResult = await dispatchCommand(question, commandCtx)
      if (cmdResult === 'exit') break
      if (cmdResult === 'continue') continue

      if (!runtime) {
        process.stdout.write(styleText('yellowBright', '尚未配置默认模型，请先运行 /model add 添加配置后再提问\n'))
        continue
      }

      // 每次提问直接从 SQLite 读取当前生效视图（含 /compact 边界），消除内存副本同步问题
      const history = sessionId ? await loadHistory(sessionId) : []

      if (!sessionId) {
        process.stdout.write(styleText('blueBright', '开始生成会话名称...'))
        const sessionName = await generateSessionNameByQuestion(runtime.client, runtime.config.modelId, question)
        process.stdout.write(styleText('blueBright', `会话名称生成完成，会话名称：${sessionName.name}\n`))
        sessionId = await createSession(sessionName)
      }

      const currentSessionId = sessionId
      await ask(question, history, {
        client: runtime.client,
        model: runtime.config.modelId,
        instructions: runtime.instructions,
        registry: runtime.registry,
        onEvent: (event) => {
          renderEvent(event)
          if (event.type === 'round_commit') {
            saveTurn(currentSessionId, event.items, [event.round])
          }
        },
      })
    }
  } finally {
    await mcp.close()
  }
}

main().catch(e => {
  console.error(e)
  process.stdout.write(styleText('redBright', `异常退出程序: ${e.message}\n`))
}).finally(async () => {
  rl.close()
})
