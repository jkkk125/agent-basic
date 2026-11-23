import type { OpenAI } from 'openai'

type Item = OpenAI.Responses.ResponseInputItem
type ToolOutputItem = Extract<Item, { type: 'function_call_output' | 'custom_tool_call_output' }>

/** 太短的输出不值得替换（占位符本身也要几十个字符） */
const MIN_COMPACT_CHARS = 200

/**
 * 跨提问保留的上下文状态，每个会话一份。
 * 目前没有任何代码会推进 boundary，它恒为 0，buildInput 等于原样返回；
 * 保留它是因为后面做 /compact 时，替换旧工具输出这一步还要用。
 * boundary：拼接后的数组（history + items）里，下标小于它的工具输出显示为占位符。
 * lastInputTokens：上一轮请求的 input_tokens，也就是实际发出去的上下文大小；恢复会话后是 0，表示还没有实测值。
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
