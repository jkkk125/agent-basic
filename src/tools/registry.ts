import type { OpenAI } from 'openai'
import { applyPatchTool } from './apply-patch.ts'
import { deepseekReadUrlTool, deepseekWebSearchTool } from './deepseek.ts'
import { readFileTool } from './file.ts'
import { connectMcpTools } from './mcp.ts'
import { runShellTool } from './shell.ts'
import { currentTimeTool } from './time.ts'
import type { AgentTool } from './types.ts'

const DOCS_MCP_URL = 'https://developers.openai.com/mcp'

export type ToolRegistry = {
  /** 发给模型的全部工具定义 */
  specs: OpenAI.Responses.Tool[]
  /** 按名字查找本地可执行的工具；服务端执行的工具（如 web_search）查不到 */
  get: (name: string) => AgentTool | undefined
  /** 释放工具占用的连接（目前只有 MCP） */
  close: () => Promise<void>
}

/** 汇总本次会话可用的工具：本地工具 + MCP 工具 + 按模型追加的联网工具 */
export async function createToolRegistry(modelName: string): Promise<ToolRegistry> {
  const mcp = await connectMcpTools(DOCS_MCP_URL)

  // 数组顺序就是发给模型的 tools 顺序，调整顺序会改变请求前缀、影响缓存命中
  const tools: AgentTool[] = [
    currentTimeTool,
    readFileTool,
    runShellTool,
    applyPatchTool,
    ...mcp.tools,
    // flash 模型没有服务端联网能力，用客户端执行的搜索 / 抓取工具补上
    ...(modelName.endsWith('-flash') ? [deepseekWebSearchTool, deepseekReadUrlTool] : []),
  ]

  // pro 模型的联网由服务端执行：只有定义，没有本地 execute
  const hostedSpecs: OpenAI.Responses.Tool[] = modelName.endsWith('-pro')
    ? [{ type: 'web_search' }]
    : []

  const byName = new Map<string, AgentTool>()
  for (const tool of tools) {
    if (byName.has(tool.name)) {
      await mcp.close().catch(() => {})
      throw new Error(`工具名重复：${tool.name}`)
    }
    byName.set(tool.name, tool)
  }

  return {
    specs: [...tools.map(tool => tool.spec), ...hostedSpecs],
    get: (name) => byName.get(name),
    close: mcp.close,
  }
}
