import type { OpenAI } from 'openai'

type Item = OpenAI.Responses.ResponseInputItem
type ToolOutputItem = Extract<Item, { type: 'function_call_output' | 'custom_tool_call_output' }>

/**
 * 触发压缩的默认阈值：上一轮请求的 input_tokens 超过它，就推进边界；可用环境变量 COMPACT_HIGH_TOKENS 覆盖。
 * 模型窗口是 1M，窗口不是瓶颈，这里按费用、延迟和长上下文下的注意力质量来定；调试时设成 8000 左右更容易触发。
 */
const DEFAULT_HIGH_TOKENS = 100_000
/** 推进边界时，保留最近这么多个工具输出的原文 */
const KEEP_RECENT_OUTPUTS = 8
/** 太短的输出不值得替换（占位符本身也要几十个字符） */
const MIN_COMPACT_CHARS = 200

/**
 * 跨提问保留的压缩状态，每个会话一份。
 * boundary：拼接后的数组（history + items）里，下标小于它的工具输出显示为占位符。只增不减。
 * lastInputTokens：上一轮请求的 input_tokens，也就是实际发出去的上下文大小。
 */
export type ContextState = {
  boundary: number
  lastInputTokens: number
}

function isToolOutput(item: Item): item is ToolOutputItem {
  return item.type === 'function_call_output' || item.type === 'custom_tool_call_output'
}

/**
 * 由完整记录派生出本次请求要发给模型的 input。
 *
 * history 是之前各次提问落库的全部 item，items 是本次提问到目前为止产生的 item；
 * 两者都是完整记录，这里不能修改它们，只改变返回值。
 * 纯函数：只按 boundary 替换旧工具输出，不看 token，所以边界不变时前缀完全稳定，缓存可以命中。
 * 只改 output，保留 call_id，function_call 与它的输出仍然配对。
 */
export function buildInput(
  history: OpenAI.Responses.ResponseInput,
  items: Item[],
  boundary: number,
): OpenAI.Responses.ResponseInput {
  return [...history, ...items].map((item, index) => {
    if (index >= boundary || !isToolOutput(item)) return item
    if (typeof item.output !== 'string' || item.output.length <= MIN_COMPACT_CHARS) return item
    return {
      ...item,
      output: `[旧工具输出已省略，原长 ${item.output.length} 个字符；如需内容请重新调用工具]`,
    }
  })
}

/**
 * 决定要不要把边界往前推。
 * 没超过阈值就原样返回；超过了，就推进到“最近 KEEP_RECENT_OUTPUTS 个工具输出”之前。
 * 边界只会前进，不会后退。
 */
export function advanceBoundary(
  history: OpenAI.Responses.ResponseInput,
  items: Item[],
  lastInputTokens: number,
  boundary: number,
): number {
  const highTokens = Number(process.env.COMPACT_HIGH_TOKENS) || DEFAULT_HIGH_TOKENS
  if (lastInputTokens <= highTokens) return boundary

  const outputIndexes: number[] = []
  ;[...history, ...items].forEach((item, index) => {
    if (isToolOutput(item)) outputIndexes.push(index)
  })
  if (outputIndexes.length <= KEEP_RECENT_OUTPUTS) return boundary

  return Math.max(boundary, outputIndexes[outputIndexes.length - KEEP_RECENT_OUTPUTS])
}
