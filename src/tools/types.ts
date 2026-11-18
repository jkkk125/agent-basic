import type { OpenAI } from 'openai'
import { zodResponsesFunction } from 'openai/helpers/zod'
import type { z } from 'zod'

/** 需要记进 agent_usage.server_tool_use 的计数项 */
export type ToolUsageKey = 'tool_search' | 'tool_fetch' | 'tool_image_search'

/** 一个本地可执行的工具：给模型看的定义 + 执行函数放在一起，新增工具只需要改一处 */
export type AgentTool = {
  name: string
  /** 发给模型的定义 */
  spec: OpenAI.Responses.Tool
  /** input：function 工具是 JSON.parse 后的参数对象，custom 工具是模型给的原始字符串 */
  execute: (input: unknown) => Promise<string>
  /** 每成功发起一次调用，就给本轮 usage 的对应计数加一 */
  usageKey?: ToolUsageKey
}

/** 用 zod schema 定义一个 function 工具 */
export function defineFunctionTool<Parameters extends z.ZodType>(def: {
  name: string
  description: string
  parameters: Parameters
  execute: (args: z.infer<Parameters>) => string | Promise<string>
  usageKey?: ToolUsageKey
}): AgentTool {
  return {
    name: def.name,
    spec: zodResponsesFunction({
      name: def.name,
      description: def.description,
      parameters: def.parameters,
    }),
    // 参数只做 JSON.parse，不再过一遍 zod 校验；各工具自己在 execute 里检查必要字段
    execute: async (input) => def.execute(input as z.infer<Parameters>),
    usageKey: def.usageKey,
  }
}
