import type { OpenAI } from 'openai'

/**
 * 由完整记录派生出本次请求要发给模型的 input。
 *
 * history 是之前各次提问落库的全部 item，items 是本次提问到目前为止产生的 item；
 * 两者都是完整记录，这里不能修改它们。
 * 现在原样拼接；裁剪旧工具输出、摘要等上下文管理都应该在这里做，只改变返回值。
 */
export function buildInput(
  history: OpenAI.Responses.ResponseInput,
  items: OpenAI.Responses.ResponseInputItem[],
): OpenAI.Responses.ResponseInput {
  return [...history, ...items]
}
