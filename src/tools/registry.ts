import type { OpenAI } from 'openai'
import { applyPatchTool } from './apply-patch.ts'
import { createDeepseekReadUrlTool, createDeepseekWebSearchTool } from './deepseek.ts'
import { readFileTool } from './file.ts'
import { connectMcpTools } from './mcp.ts'
import { memoryNoteTool, memoryReadTool } from './memory.ts'
import { runShellTool } from './shell.ts'
import { currentTimeTool } from './time.ts'
import type { AgentTool } from './types.ts'

const DOCS_MCP_URL = 'https://developers.openai.com/mcp'

export type SharedMcpConnection = {
  tools: AgentTool[]
  close: () => Promise<void>
}

export type ToolRegistry = {
  /** 发给模型的全部工具定义 */
  specs: OpenAI.Responses.Tool[]
  /** 按名字查找本地可执行的工具；服务端执行的工具（如 web_search）查不到 */
  get: (name: string) => AgentTool | undefined
}

/** 进程级建立一次 MCP 连接，供热切换模型时复用，避免重复连接与泄漏 */
export async function connectSharedMcp(): Promise<SharedMcpConnection> {
  return connectMcpTools(DOCS_MCP_URL)
}

/** 根据当前模型和 API Key 组装本次可用的工具表：本地工具 + MCP 工具 + 按模型追加的联网工具 */
export function buildToolRegistry(options: {
  modelName: string
  apiKey: string
  mcpTools: AgentTool[]
}): ToolRegistry {
  const { modelName, apiKey, mcpTools } = options
  const getApiKey = () => apiKey

  // flash 没有服务端联网，用客户端搜索 / 抓取；其余默认挂 hosted web_search
  const isDeepseekFlash = modelName.startsWith('deepseek-flash')

  // 数组顺序就是发给模型的 tools 顺序，调整顺序会改变请求前缀、影响缓存命中
  const tools: AgentTool[] = [
    currentTimeTool,
    readFileTool,
    runShellTool,
    applyPatchTool,
    memoryNoteTool,
    memoryReadTool,
    ...mcpTools,
    ...(isDeepseekFlash
      ? [createDeepseekWebSearchTool(getApiKey), createDeepseekReadUrlTool(getApiKey)]
      : []),
  ]

  // hosted 工具只有定义、没有本地 execute；与 flash 客户端工具互斥
  const hostedSpecs: OpenAI.Responses.Tool[] = isDeepseekFlash
    ? []
    : [{ type: 'web_search' }]

  const byName = new Map<string, AgentTool>()
  for (const tool of tools) {
    if (byName.has(tool.name)) {
      throw new Error(`工具名重复：${tool.name}`)
    }
    byName.set(tool.name, tool)
  }

  return {
    specs: [...tools.map(tool => tool.spec), ...hostedSpecs],
    get: (name) => byName.get(name),
  }
}
