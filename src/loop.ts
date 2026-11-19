import type { OpenAI } from 'openai'
import { toResponseInputItems } from 'openai/lib/responses/ResponseInputItems'
import { buildInput, advanceBoundary, type ContextState } from './context.ts'
import type { ToolRegistry } from './tools/registry.ts'
import type { AgentEvent, RoundUsage, ServerToolUse } from './types.ts'

/** 跑一次循环需要的全部依赖；换一套 instructions 和 registry 就是另一个 agent */
export type AgentOptions = {
  client: OpenAI
  model: string
  instructions: string
  registry: ToolRegistry
  /** 循环通过它对外通知进展；循环自己不打印、不落库 */
  onEvent: (event: AgentEvent) => void
}

export type AskResponse = {
  /** 本次提问产生的全部 item；usage 已经通过 round_commit 事件逐轮交出，不在这里返回 */
  items: OpenAI.Responses.ResponseInputItem[]
  /** 更新后的压缩状态，调用方保存起来，下次提问传回来 */
  state: ContextState
}

/** 执行一轮响应里的全部工具调用，返回要追加到上下文的 output item */
async function runToolCalls(
  output: OpenAI.Responses.ResponseOutputItem[],
  registry: ToolRegistry,
  onEvent: (event: AgentEvent) => void,
) {
  const results: OpenAI.Responses.ResponseInputItem[] = []
  // 带 usageKey 的工具（客户端执行的 flash 联网工具）的调用次数，
  // 按「本轮响应」统计，之后合并进这一轮的 usage
  const server_tool_use: ServerToolUse = {
    tool_search: 0,
    tool_fetch: 0,
    tool_image_search: 0,
  }

  // 按模型输出的顺序逐个执行；function 和 custom 两种调用只在入参和回传的 item 类型上有区别
  for (const call of output) {
    if (call.type !== 'function_call' && call.type !== 'custom_tool_call') continue

    onEvent({ type: 'tool_start', call })
    let result: string
    try {
      const tool = registry.get(call.name)
      if (!tool) throw new Error('未知工具')
      // 先解析参数：参数非法时请求根本没发出去，不应计数
      const input = call.type === 'function_call' ? JSON.parse(call.arguments) : call.input
      if (tool.usageKey) server_tool_use[tool.usageKey]++
      result = await tool.execute(input)
    } catch (e) {
      result = `${call.name} 调用失败: ${(e as Error).message}`
    }

    onEvent({ type: 'tool_end', call, output: result })
    results.push(
      call.type === 'function_call'
        ? { type: 'function_call_output', call_id: call.call_id, output: result }
        : { type: 'custom_tool_call_output', call_id: call.call_id, output: result },
    )
  }

  return { results, server_tool_use }
}

/**
 * 处理一次提问：请求模型 → 执行它要求的工具 → 带着结果再请求，直到模型不再调用工具。
 * 每一轮结束时通过 round_commit 事件交出这一轮的增量，调用方据此即时保存；
 * 返回值是本次提问产生的全部 item（调用方用来更新内存里的历史）和更新后的压缩状态。
 */
export async function ask(
  question: string, 
  history: OpenAI.Responses.ResponseInput,
  state: ContextState,
  { client, model, instructions, registry, onEvent }: AgentOptions,
): Promise<AskResponse> {
  const tools = registry.specs
  // 唯一的上下文状态：本次提问产生的全部 item，input 由它派生
  const items: OpenAI.Responses.ResponseInputItem[] = [
    { role: 'user', content: question, type: 'message' },
  ]
  // 每次请求一条 usage，避免多轮工具调用时只记下最后一轮
  const rounds: RoundUsage[] = []
  // 压缩状态：从上次提问接着用，本次提问内部更新，结束时交回
  let { boundary, lastInputTokens } = state
  const finish = (): AskResponse => ({ items, state: { boundary, lastInputTokens } })

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
    // 下一轮判断是否压缩要用：这是实际发出去的上下文大小
    lastInputTokens = res.usage?.input_tokens ?? lastInputTokens
    const outItems = toResponseInputItems(res.output)
    pushItems(outItems)
    return outItems
  }
  // 已经通过 round_commit 交出去的 item 数；items[committed:] 就是下一次要提交的增量
  let committed = 0
  /**
   * 提交一轮：把上次提交之后新增的 item 和这一轮的 usage 一起发给监听方。
   * 所有出口都必须调用它，并且要在这一轮的 usage 和工具输出都定稿之后。
   */
  const commitRound = () => {
    onEvent({
      type: 'round_commit',
      items: items.slice(committed),
      round: rounds[rounds.length - 1],
    })
    committed = items.length
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
    const nextBoundary = advanceBoundary(history, items, lastInputTokens, boundary)
    if (nextBoundary !== boundary) {
      onEvent({ type: 'context_compacted', from: boundary, to: nextBoundary, input_tokens: lastInputTokens })
      boundary = nextBoundary
    }
    const input = buildInput(history, items, boundary)
    const stream = await client.responses.create({
      model,
      instructions,
      input,
      tools,
      stream: true,
    });

    for await (const chunk of stream) {
      // 每个流式事件都先交给监听方展示；下面只处理会改变循环状态的三种终态事件
      onEvent({ type: 'stream', event: chunk })

      switch (chunk.type) {
        case 'response.incomplete':
          // 未完成也要把已产出的 output 落库，否则库里只剩用户那条消息
          recordResponse(chunk.response)
          commitRound()
          return finish()

        case 'response.failed':
          recordResponse(chunk.response)
          commitRound()
          return finish()

        case 'response.completed': {
          const { response } = chunk
          recordResponse(response)

          const { results: toolOutputs, server_tool_use } = await runToolCalls(response.output, registry, onEvent)
          pushItems(toolOutputs)
          addServerToolUse(response.id, server_tool_use)
          // 工具输出和 server_tool_use 都已定稿，function_call 与它的输出一起提交
          commitRound()

          onEvent({ type: 'round_end' })
          const hasToolCall = response.output.some(
            v => v.type === 'function_call' || v.type === 'custom_tool_call'
          )
          if (!hasToolCall) {
            onEvent({ type: 'turn_end' })
            return finish()
          }
          break
        }
      }
    }
  }

  // 兜底：50 轮里始终没出现"无工具调用"的收尾轮时，也必须把已产生的中间过程交回去。
  onEvent({ type: 'max_rounds_reached' })
  pushItems([{
    role: 'developer',
    type: 'message',
    content: '工具调用次数已达上限。不要再调用工具，仅根据已有结果用中文总结：已完成项、未完成项，以及继续时最关键的一步。信息不足就明确说未完成。',
  }])
  const finalAnswer = await client.responses.create({
    model,
    instructions: instructions,
    input: buildInput(history, items, boundary),
    tools,
    stream: false
  })
  recordResponse(finalAnswer)
  commitRound()

  onEvent({ type: 'summary', text: finalAnswer.output_text })

  return finish()
}
