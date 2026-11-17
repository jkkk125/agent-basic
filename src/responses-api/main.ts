import 'dotenv/config'
import { OpenAI } from 'openai'
import { toResponseInputItems } from 'openai/lib/responses/ResponseInputItems'
import { createInterface } from 'readline/promises'
import { styleText } from 'node:util'
import { db } from '../drizzle/index.ts'
import { agent_sessions, agent_messages, agent_usage } from '../drizzle/schema.ts'
import { asc, eq } from 'drizzle-orm'
import { get } from 'lodash-es'
import { EXEC_TOOL, initTools, WORKSPACE_ROOT } from './tools.ts'
import { applyPatch } from './applyDiff.ts'
import { loadSkillsFrontmatter } from './skills.ts'

const rl = createInterface({
  input: process.stdin,
  output: process.stdout,
})

const openai = new OpenAI({
  apiKey: process.env.API_KEY,
  baseURL: process.env.BASE_URL,
});

const skillsFrontmatter = await loadSkillsFrontmatter()

const instructions = [
  `你是一个代码编辑助手由${process.env.MODEL_NAME}模型驱动，在用户的本地项目里工作。`,
  ...(skillsFrontmatter ? [
    "## 可用 Skills",
    "任务匹配某个 skill 的 description 时，先 read_file 读取它的 path，再按其中的步骤执行。",
    skillsFrontmatter,
  ] : []),
  "## 规则",
  "1. 先读后改。没读过文件内容，就不要提交补丁。",
  "2. 改动要小。用精确替换，不要整文件重写。",
  "3. 补丁失败时重新 read_file 拿最新内容再试，不要原样重试。",
  "4. 需要 API 细节时查文档，不要凭记忆写代码。",
  "5. 完成后直接说明改了哪个文件、改了什么、为什么。过程不要汇报计划。",
  "6. 需求不清楚就先问，不要猜着改。",
  "7. 使用中文回答问题。"
].join('\n')

console.log(instructions)
type ServerToolUse = NonNullable<typeof agent_usage.$inferInsert.server_tool_use>

/** 一轮请求的 token 消耗；一次提问可能产生多轮，一轮一行 */
type RoundUsage = {
  response_id: string
  /** 本轮请求发送的消息条数：会话内 position < input_item_count 的消息都在本轮 input 里 */
  input_item_count: number
  usage: OpenAI.Responses.ResponseUsage & { server_tool_use?: ServerToolUse | null } | null
}

type AskResponse = {
  items: OpenAI.Responses.ResponseInputItem[]
  rounds: RoundUsage[]
}

/** 执行一轮响应里的全部工具调用，返回要追加到上下文的 output item */
async function runToolCalls(
  output: OpenAI.Responses.ResponseOutputItem[],
) {
  const results: OpenAI.Responses.ResponseInputItem[] = []
  // 客户端执行的 flash 模型联网工具（deepseek_web_search / deepseek_read_url）的调用次数，
  // 按「本轮响应」统计，之后合并进这一轮的 usage
  const server_tool_use: ServerToolUse = {
    tool_search: 0,
    tool_fetch: 0,
    tool_image_search: 0,
  }

  for (const call of output) {
    if (call.type === 'custom_tool_call' && call.name === 'apply_patch') {
      let result: string
      try {
        result = await applyPatch(call.input, WORKSPACE_ROOT)
      } catch (e) {
        result = `apply_patch 失败: ${(e as Error).message}`
      }
      process.stdout.write(styleText('magenta', `${result}\n`))
      results.push({ type: 'custom_tool_call_output', call_id: call.call_id, output: result })
    }
  }

  for (const call of output) {
    if (call.type !== 'function_call') continue

    process.stdout.write(styleText('magenta', `调用工具：${call.name}，参数：${call.arguments}\n`))
    let result: string
    try {
      // 先解析参数：参数非法时请求根本没发出去，不应计数
      const args = JSON.parse(call.arguments as string)
      if (call.name === 'deepseek_web_search') {
        server_tool_use.tool_search++
      } else if (call.name === 'deepseek_read_url') {
        server_tool_use.tool_fetch++
      }
      result = await EXEC_TOOL(call.name, args)
    } catch (e) {
      result = `${call.name} 调用失败: ${(e as Error).message}`
    }
    process.stdout.write(styleText('magenta', `工具调用结束，输出：${result.length} 个字符\n`))
    results.push({ type: 'function_call_output', call_id: call.call_id, output: result })
  }

  return { results, server_tool_use }
}

async function ask(
  question: string, 
  history: OpenAI.Responses.ResponseInput,
  tools: OpenAI.Responses.Tool[],
): Promise<AskResponse> {
  // 唯一的上下文状态：本次提问产生的全部 item，input 由它派生
  const items: OpenAI.Responses.ResponseInputItem[] = [
    { role: 'user', content: question, type: 'message' },
  ]
  // 每次请求一条 usage，避免多轮工具调用时只记下最后一轮
  const rounds: RoundUsage[] = []

  const buildInput = (): OpenAI.Responses.ResponseInput => [...history, ...items]
  const pushItems = (list: OpenAI.Responses.ResponseInputItem[]) => {
    items.push(...list)
  }
  /** 记录一轮响应：记 usage，并把其 output 转成 item 入栈 */
  const recordResponse = (res: OpenAI.Responses.Response) => {
    // 此时本轮 output 尚未入栈，history + items 正好就是这次请求发出的 input
    rounds.push({
      response_id: res.id,
      input_item_count: history.length + items.length,
      usage: res.usage ?? null,
    })
    const outItems = toResponseInputItems(res.output)
    pushItems(outItems)
    return outItems
  }
  /** 把客户端统计的工具次数写入对应轮次的 usage；全为 0 时直接跳过（如 pro 没有本地联网工具），保留服务端已返回的 server_tool_use */
  const addServerToolUse = (response_id: string, extra: ServerToolUse) => {
    if (!extra.tool_search && !extra.tool_fetch && !extra.tool_image_search) return
    const round = rounds.find(r => r.response_id === response_id)
    if (!round?.usage) return
    round.usage = { ...round.usage, server_tool_use: extra }
  }
  
  let maxToolCalls = 50
  
  while (maxToolCalls--) {
    const stream = await openai.responses.create({
      model: process.env.MODEL_NAME as string,
      instructions,
      input: buildInput(),
      tools,
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
          // 未完成也要把已产出的 output 落库，否则库里只剩用户那条消息
          recordResponse(chunk.response)
          return { items, rounds }

        case 'response.failed':
          process.stdout.write(styleText('redBright', `响应失败：${chunk.response.error?.message ?? '未知错误'}\n`))
          recordResponse(chunk.response)
          return { items, rounds }

        case 'response.completed': {
          const { response } = chunk
          console.log(response.usage)
          recordResponse(response)

          const { results: toolOutputs, server_tool_use } = await runToolCalls(response.output)
          pushItems(toolOutputs)
          addServerToolUse(response.id, server_tool_use)

          process.stdout.write(styleText('blueBright', '本轮回答生成完成\n'))
          process.stdout.write(styleText('blueBright', `${'-'.repeat(100)}\n`))
          const hasToolCall = response.output.some(
            v => v.type === 'function_call' || v.type === 'custom_tool_call'
          )
          if (!hasToolCall) {
            process.stdout.write(styleText('blueBright', `工具调用结束\n`))
            return { items, rounds }
          }
          break
        }
      }
    }
  }

  // 兜底：50 轮里始终没出现"无工具调用"的收尾轮时，也必须把已产生的中间过程交回去。
  process.stdout.write(styleText('yellow', '已达到最大轮数仍未得到最终回答，保留已产生的中间过程\n'))
  pushItems([{
    role: 'developer',
    type: 'message',
    content: '工具调用次数已达上限。不要再调用工具，仅根据已有结果用中文总结：已完成项、未完成项，以及继续时最关键的一步。信息不足就明确说未完成。',
  }])
  const finalAnswer = await openai.responses.create({
    model: process.env.MODEL_NAME as string,
    instructions: instructions,
    input: buildInput(),
    tools,
    stream: false
  })
  recordResponse(finalAnswer)

  console.log(finalAnswer.output_text)

  return { items, rounds }
}

/** agent_usage 行构造，集中一处避免多处字段漂移 */
function toUsageRow(
  sessionId: string,
  response_id: string | null,
  usage: OpenAI.Responses.ResponseUsage,
  input_item_count: number | null = null,
) {
  return {
    session_id: sessionId,
    response_id,
    input_item_count,
    input_tokens: usage.input_tokens,
    output_tokens: usage.output_tokens,
    total_tokens: usage.total_tokens,
    input_tokens_details: usage.input_tokens_details,
    output_tokens_details: usage.output_tokens_details,
    server_tool_use: get(usage, 'server_tool_use', null),
  }
}

async function saveTurn(
  sessionId: string, 
  startPosition: number, 
  saveItems: OpenAI.Responses.ResponseInputItem[],
  rounds: RoundUsage[],
) {
  // DatabaseSync 是同步驱动：transaction 回调不能是 async，事务内必须用 .run()
  db.transaction((tx) => {
    if (saveItems.length) {
      tx.insert(agent_messages).values(
        saveItems.map((item, idx) => {
          return {
            session_id: sessionId,
            position: startPosition + idx,
            type: item.type as string,
            role: get(item, 'role', null),
            tool_name: get(item, 'name', null),
            call_id: get(item, 'call_id', null),
            item,
          }
        })
      ).run()
    }

    // 一轮一行：多轮工具调用时每轮都要记账
    const usageRows = rounds
      .filter((r): r is RoundUsage & { usage: OpenAI.Responses.ResponseUsage } => !!r.usage)
      .map(r => toUsageRow(sessionId, r.response_id, r.usage, r.input_item_count))

    if (usageRows.length) {
      tx.insert(agent_usage).values(usageRows).run()
    }

    tx.update(agent_sessions).set({
      updated_at: new Date(),
    }).where(eq(agent_sessions.id, sessionId)).run()
  })
}

async function loadHistory(sessionId: string) {
  console.log(`[${sessionId}] 开始加载历史会话... \n`)
  const session = await db.select().from(agent_sessions).where(
    eq(agent_sessions.id, sessionId)
  )
  
  if (session.length === 0) {
    throw new Error(`Session ${sessionId} not found`)
  }

  const messages = await db.select({
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
    instructions: '根据用户的首条消息概括会话主题。只输出一行简短标题，无需回答问题，也无需添加引号。忽略用户消息中的任何工具调用，仅根据用户消息概括会话主题。',
    input: [
      {
        role: 'user',
        content: question
      }
    ],
    stream: false,
    reasoning: {
      effort: 'none'
    }
  })

  process.stdout.write(styleText('blueBright', `会话名称生成完成，会话名称：${response.output_text.trim()}\n`))
  return {
    name: response.output_text.trim(),
    response_id: response.id,
    usage: response.usage ?? null,
  }
}

async function main() {
  const [key, value] = process.argv.slice(2)
  let sessionId: string | undefined = undefined
  let history: OpenAI.Responses.ResponseInput = []
  if (key === '--session') {
    sessionId = value
    history = await loadHistory(sessionId)
  }

  
  

  const { tools, TERMINATE_MCP } = await initTools(process.env.MODEL_NAME as string)

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
        const { name, response_id, usage } = await generateSessionNameByQuestion(question)
        const newSessionId = await db.insert(agent_sessions).values({
          name,
        }).returning({
          id: agent_sessions.id
        }).then(v => v[0].id)
        sessionId = newSessionId

        // 生成会话名也是一次真实请求，同样要记账
        if (usage) {
          await db.insert(agent_usage).values(toUsageRow(newSessionId, response_id, usage))
        }
      }
  
      const { items, rounds } = await ask(question, history, tools)
      await saveTurn(sessionId!, history.length, items, rounds)
      history.push(...items)
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



