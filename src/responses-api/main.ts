import 'dotenv/config'
import { OpenAI } from 'openai'
import { toResponseInputItems } from 'openai/lib/responses/ResponseInputItems'
import { createInterface } from 'readline/promises'
import { styleText } from 'node:util'
import { pgsql } from '../drizzle/index.ts'
import { agent_sessions, agent_messages, agent_usage } from '../drizzle/schema.ts'
import { asc, eq, sql } from 'drizzle-orm'
import { get, set } from 'lodash-es'
import { EXEC_TOOL, ALL_TOOLS_DEFINED, INIT_MCP, WORKSPACE_ROOT } from './tools.ts'
import { applyPatch } from './applyDiff.ts'

const rl = createInterface({
  input: process.stdin,
  output: process.stdout,
})

const openai = new OpenAI({
  apiKey: process.env.API_KEY,
  baseURL: process.env.BASE_URL,
});
const instructions = [
  `你是一个代码编辑助手由${process.env.MODEL_NAME}模型驱动，在用户的本地项目里工作。`,
  "## 工具",
  "- read_file：读取文件内容。",
  "- apply_patch：修改文件，支持新建、更新、删除。",
  "- 文档工具（搜索 / 抓取）：需要确认 API 用法、参数或版本行为时使用。",
  "- get_current_time：问题涉及当前日期时间时使用。",
  "## 规则",
  "1. 先读后改。没读过文件内容，就不要提交补丁。",
  "2. 改动要小。用精确替换，不要整文件重写。",
  "3. 补丁失败时重新 read_file 拿最新内容再试，不要原样重试。",
  "4. 需要 API 细节时查文档，不要凭记忆写代码。",
  "5. 完成后直接说明改了哪个文件、改了什么、为什么。过程不要汇报计划。",
  "6. 需求不清楚就先问，不要猜着改。",
  "7. 使用使用中文回答问题。"
].join('\n')

type AskResponse = {
  response_id: string
  output: OpenAI.Responses.ResponseInputItem[]
  usage: OpenAI.Responses.ResponseUsage | null
}

async function ask(
  question: string, 
  history: OpenAI.Responses.ResponseInput
): Promise<AskResponse> {
  const input: OpenAI.Responses.ResponseInput = [
    ...history,
    {
      role: 'user',
      content: question,
      type: 'message'
    }
  ]

  const getAskResponse = (
    chunk: 
    OpenAI.Responses.ResponseIncompleteEvent | 
    OpenAI.Responses.ResponseFailedEvent | 
    OpenAI.Responses.ResponseCompletedEvent |
    OpenAI.Responses.Response
  ) => {
    return {
      response_id: 'response' in chunk ? chunk.response.id : chunk.id,
      output: input.slice(history.length),
      usage: ('response' in chunk ? chunk.response.usage : chunk.usage) ?? null
    }
  }
  
  let maxToolCalls = 20
  
  while (maxToolCalls--) {
    const stream = await openai.responses.create({
      model: process.env.MODEL_NAME as string,
      instructions,
      input,
      tools: ALL_TOOLS_DEFINED,
      stream: true,
    });

    for await (const chunk of stream) {
      switch (chunk.type) {
        case 'response.created': // 流式输出第一个事件
          process.stdout.write(styleText('blueBright', `开始生成回答； \n`))
          break

        case 'response.in_progress':
          process.stdout.write(styleText('blueBright', '响应正在生成中； \n'))
          break

        case 'response.output_item.added':
          process.stdout.write(styleText('greenBright', `开始构建output数组第 ${chunk.output_index } 位元素，类型为${chunk.item.type}； \n`))
          break

        case 'response.output_item.done':
          process.stdout.write(styleText('greenBright', `构建output数组第 ${chunk.output_index} 位元素，类型为${chunk.item.type}，构建结束（此时可以拿到此轮输出的output数组）； \n`))
          break
        
        case 'response.content_part.added':
          process.stdout.write(styleText('greenBright', `开始构建output数组第 ${chunk.output_index} 位元素的content数组第 ${chunk.content_index} 位元素，类型为${chunk.part.type}； \n`))
          break

        case 'response.content_part.done':
          process.stdout.write(styleText('greenBright', `构建output数组第 ${chunk.output_index} 位元素的content数组第 ${chunk.content_index} 位元素，类型为${chunk.part.type}，构建结束（此时可以拿到此轮输出的content数组）； \n`))
          break

        case 'response.reasoning_text.delta':
          process.stdout.write(styleText('cyan', chunk.delta))
          break
        case 'response.reasoning_text.done':
          process.stdout.write(styleText('cyan', `思考过程结束； \n`))
          break

        case 'response.output_text.delta':
          process.stdout.write(`${chunk.delta}`)
          break

        case 'response.output_text.done':
          process.stdout.write('回答文本结束； \n')
          break

        case 'response.function_call_arguments.delta':
          process.stdout.write(styleText('magenta', chunk.delta))
          break

        case 'response.function_call_arguments.done':
          process.stdout.write(styleText('magenta', `函数调用参数结束； \n`))
          break

        case 'response.custom_tool_call_input.delta':
          process.stdout.write(styleText('magenta', chunk.delta))
          break

        case 'response.custom_tool_call_input.done':
          process.stdout.write(styleText('magenta', `自定义工具调用输入结束； \n`))
          break

        case 'response.incomplete':
          process.stdout.write(styleText('yellow', '响应未完成（incomplete），本轮提前结束，保留已产生的中间过程\n'))
          console.log(chunk.response.usage)
          return getAskResponse(chunk)

        case 'response.failed':
          process.stdout.write(styleText('redBright', `响应失败：${chunk.response.error?.message ?? '未知错误'}\n`))
          return getAskResponse(chunk)

        case 'response.completed':
          console.log(chunk.response.usage)
          console.log(chunk.response.id)
          const response_id = chunk.response.id
          const newItems = toResponseInputItems(chunk.response.output)
          input.push(...newItems)
          const toolCalls = chunk.response.output.filter(v => v.type === 'function_call')
          const customeToolCalls = chunk.response.output.filter(v => v.type === 'custom_tool_call')

          for (const customeToolCall of customeToolCalls) {
            if (customeToolCall.name === 'apply_patch') {
              let output: string
              try {
                output = await applyPatch(customeToolCall.input, WORKSPACE_ROOT)
              } catch (e) {
                output = `apply_patch 失败: ${(e as Error).message}`
              }
              process.stdout.write(styleText('magenta', `${output}\n`))
              input.push({
                type: 'custom_tool_call_output',
                call_id: customeToolCall.call_id,
                output,
              })
            }
          }
          
          for (const toolCall of toolCalls) {
            process.stdout.write(styleText('magenta', `调用工具：${toolCall.name}，参数：${toolCall.arguments}\n`))

            let output: string
            try {
              const args = JSON.parse(toolCall.arguments as string)
              output = await EXEC_TOOL(toolCall.name, args)
            } catch (e) {
              output = `${toolCall.name} 调用失败: ${(e as Error).message}`
            }
            
            process.stdout.write(styleText('magenta', `工具调用结束，输出：${output.length} 个字符\n`))
            input.push({
              type: 'function_call_output',
              call_id: toolCall.call_id,
              output: output,
            })
          }
          process.stdout.write(styleText('blueBright', '本轮回答生成完成\n'))
          process.stdout.write(styleText('blueBright', `${'-'.repeat(100)}\n`))
          if (toolCalls.length === 0 && customeToolCalls.length === 0) {
            process.stdout.write(styleText('blueBright', `工具调用结束\n`))  
            return getAskResponse(chunk)
          }
          break
      }
    }
  }

  // 兜底：20 轮里始终没出现"无工具调用"的收尾轮时，也必须把已产生的中间过程交回去。
  process.stdout.write(styleText('yellow', '已达到最大轮数仍未得到最终回答，保留已产生的中间过程\n'))
  input.push({
    role: 'developer',
    type: 'message',
    content: '工具调用次数已达上限。不要再调用工具，仅根据已有结果用中文总结：已完成项、未完成项，以及继续时最关键的一步。信息不足就明确说未完成。',
  })
  const finalAnswer = await openai.responses.create({
    model: process.env.MODEL_NAME as string,
    instructions: instructions,
    input,
    tools: ALL_TOOLS_DEFINED,
    stream: false
  })

  input.push(...toResponseInputItems(finalAnswer.output))

  console.log(finalAnswer.output_text)

  return getAskResponse(finalAnswer)
}

async function saveTurn(
  sessionId: string, 
  startPosition: number, 
  saveMessages: OpenAI.Responses.ResponseInputItem[],
  response_id: string,
  usage: OpenAI.Responses.ResponseUsage | null
) {
  await pgsql.transaction(async (tx) => {
    await tx.insert(agent_messages).values(
      saveMessages.map((v, idx) => {
        return {
          session_id: sessionId,
          response_id,
          position: startPosition + idx,
          type: v.type as string,
          role: get(v, 'role', null),
          tool_name: get(v, 'name', null),
          call_id: get(v, 'call_id', null),
          item: v,
        }
      })
    )

    if (usage) {
      await tx.insert(agent_usage).values({
        session_id: sessionId,
        response_id,
        input_tokens: usage.input_tokens,
        output_tokens: usage.output_tokens,
        total_tokens: usage.total_tokens,
        input_tokens_details: usage.input_tokens_details,
        output_tokens_details: usage.output_tokens_details,
      })
    }

    await tx.update(agent_sessions).set({
      updated_at: sql`now()`,
    }).where(eq(agent_sessions.id, sessionId))
  })
}

async function loadHistory(sessionId: string) {
  console.log(`[${sessionId}] 开始加载历史会话... \n`)
  const session = await pgsql.select().from(agent_sessions).where(
    eq(agent_sessions.id, sessionId)
  )
  
  if (session.length === 0) {
    throw new Error(`Session ${sessionId} not found`)
  }

  const messages = await pgsql.select({
    item: agent_messages.item,
  }).from(agent_messages).where(
    eq(agent_messages.session_id, sessionId)
  ).orderBy(asc(agent_messages.position))

  console.log(`[${sessionId}] 历史会话加载完成，共 ${messages.length} 条消息\n`)
  return messages.map(v => v.item)
}

async function generateSessionNameByQuestion(question: string) {
  process.stdout.write(styleText('blueBright', '开始生成会话名称...'))
  const response = await openai.responses.create({
    model: process.env.MODEL_NAME as string,
    instructions: '根据用户的首条消息概括会话主题。只输出一行简短标题，无需回答问题，也无需添加引号。',
    input: [
      {
        role: 'user',
        content: question
      }
    ],
    stream: false
  })

  process.stdout.write(styleText('blueBright', `会话名称生成完成，会话名称：${response.output_text.trim()}\n`))
  return response.output_text.trim()
}

async function main() {
  const [key, value, ...others] = process.argv.slice(2)
  let sessionId: string | undefined = undefined
  let history: OpenAI.Responses.ResponseInput = []
  if (key === '--session') {
    sessionId = value
    history = await loadHistory(sessionId)
  }

  const { TERMINATE_MCP } = await INIT_MCP()

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
        const sessionName = await generateSessionNameByQuestion(question)
        sessionId = await pgsql.insert(agent_sessions).values({
          name: sessionName,
        }).returning({
          id: agent_sessions.id
        }).then(v => v[0].id)
      }
  
      const { response_id, output: newItems, usage } = await ask(question, history)
      if (newItems) {
        const startPosition = history.length
        await saveTurn(sessionId!, startPosition, newItems, response_id, usage)
        history.push(...newItems)
      }
    }
  } finally {
    await TERMINATE_MCP()
  }
}


main().catch(e => {
  console.error(e)
  process.stdout.write(styleText('redBright', `异常退出程序: ${e.message}\n`))
}).finally(async () => {
  rl.close()
})



