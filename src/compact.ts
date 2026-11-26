import type { OpenAI } from 'openai'

/** agent_messages.type 里用于标记压缩摘要边界的专用值，避免与 OpenAI 原生 item.type 冲突 */
export const COMPACTION_SUMMARY_TYPE = 'compaction_summary' as const

export type CompactOptions = {
  client: OpenAI
  model: string
  instructions: string
  tools: OpenAI.Responses.Tool[]
  /** 用户在 /compact 后附加的额外关注点，例如 `/compact 保留 schema 细节` */
  focus?: string
}

export type CompactResult = {
  summary: string
  response_id: string
  input_item_count: number
  usage: OpenAI.Responses.ResponseUsage | null
}

function buildCompactPrompt(focus?: string): string {
  const lines = [
    '请把上面这段对话压缩成一份简洁、准确的工作交接摘要，供后续继续在同一会话里工作。',
    '不要调用任何工具，也不要继续执行任务，只输出摘要正文。',
    '',
    '请按以下结构用中文总结：',
    '1. 用户目标与当前进度：要解决什么问题、已完成项、未完成项。',
    '2. 关键结论与约束：已经确认的设计决策、取舍理由、用户明确提出的要求。',
    '3. 涉及的文件与改动：关键文件路径、函数/符号名、已做的修改及原因。',
    '4. 待处理问题与下一步：尚未验证的项、报错信息、继续时最关键的一步。',
    '',
    '要求：保留精确的文件路径、命令、标识符和关键数据；去掉冗余的工具长输出原文；不要复述系统提示里已有的固定规则、工具列表和 skills 清单（后续请求仍会携带系统提示）。',
  ]

  if (focus) {
    lines.push('', `额外关注点（请重点保留相关信息）：${focus}`)
  }

  return lines.join('\n')
}

/**
 * A1 策略：原样沿用当前会话的 instructions、tools 和 history，只在末尾追加总结指令。
 * 这样前缀与上一轮请求完全一致，有机会直接命中 Prompt Cache（cached_tokens）。
 */
export async function generateCompactSummary(
  history: OpenAI.Responses.ResponseInput,
  { client, model, instructions, tools, focus }: CompactOptions,
): Promise<CompactResult> {
  const input: OpenAI.Responses.ResponseInput = [
    ...history,
    {
      type: 'message',
      role: 'user',
      content: buildCompactPrompt(focus),
    },
  ]

  // 刻意不传 tool_choice: 'none'：部分接口在 none 时会把 tools 定义从 prompt 中剥离，
  // 导致前缀在 instructions 之后分叉、整段 history 的 KV Cache 失效；改由提示词约束模型不调用工具。
  const response = await client.responses.create({
    model,
    instructions,
    input,
    tools,
    stream: false,
  })

  const summary = response.output_text.trim()
  if (!summary) {
    const types = response.output.map(item => item.type).join(', ') || '无'
    throw new Error(`模型未返回摘要文本（status=${response.status}, output=[${types}]）`)
  }

  return {
    summary,
    response_id: response.id,
    input_item_count: input.length,
    usage: response.usage ?? null,
  }
}

/** 把摘要文本包装成可放进 history 开头的 developer 消息 */
export function toCompactionSummaryItem(summary: string): OpenAI.Responses.ResponseInputItem {
  return {
    type: 'message',
    role: 'developer',
    content: `以下是此前对话的压缩摘要，请据此继续与用户协作：\n\n${summary}`,
  }
}
