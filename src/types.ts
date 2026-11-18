import type { OpenAI } from 'openai'
import type { agent_usage } from '../drizzle/schema.ts'

/** 客户端统计的联网工具调用次数，形状与 agent_usage.server_tool_use 列一致 */
export type ServerToolUse = NonNullable<typeof agent_usage.$inferInsert.server_tool_use>

/** 模型发起、需要客户端执行的工具调用 */
export type ToolCall = Extract<
  OpenAI.Responses.ResponseOutputItem,
  { type: 'function_call' | 'custom_tool_call' }
>

/** agent 循环对外发出的事件：循环只说明发生了什么，怎么展示由监听方决定 */
export type AgentEvent =
  /** 模型的流式事件，原样转发 */
  | { type: 'stream', event: OpenAI.Responses.ResponseStreamEvent }
  /** 即将执行一个工具调用 */
  | { type: 'tool_start', call: ToolCall }
  /** 一个工具调用执行完毕；output 是回传给模型的完整内容 */
  | { type: 'tool_end', call: ToolCall, output: string }
  /** 一轮请求连同它的工具调用全部结束 */
  | { type: 'round_end' }
  /** 模型不再调用工具，本次提问结束 */
  | { type: 'turn_end' }
  /** 达到最大轮数，接下来会要求模型直接总结 */
  | { type: 'max_rounds_reached' }
  /** 达到最大轮数后的总结（非流式，一次给出全文） */
  | { type: 'summary', text: string }

/** 一轮请求的 token 消耗；一次提问可能产生多轮，一轮一行 */
export type RoundUsage = {
  response_id: string
  /** 本轮请求发送的消息条数：会话内 position < input_item_count 的消息都在本轮 input 里 */
  input_item_count: number
  usage: OpenAI.Responses.ResponseUsage & { server_tool_use?: ServerToolUse | null } | null
}
