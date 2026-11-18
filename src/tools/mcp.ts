import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client'
import type { AgentTool } from './types.ts'

/** 连接一个 MCP 服务，把它提供的工具转换成和本地工具一样的 AgentTool */
export async function connectMcpTools(url: string): Promise<{
  tools: AgentTool[]
  close: () => Promise<void>
}> {
  const mcp = new Client({ name: 'docs-cli', version: '0.1.0' })
  const transport = new StreamableHTTPClientTransport(new URL(url))

  const close = async () => {
    await transport.terminateSession().finally(() => mcp.close())
  }

  await mcp.connect(transport)
  try {
    const mcpListResult = await mcp.listTools()
    const tools: AgentTool[] = mcpListResult.tools.map(tool => ({
      name: tool.name,
      spec: {
        type: 'function',
        name: tool.name,
        description: tool.description,
        parameters: tool.inputSchema,
        strict: false,
      },
      execute: async (input) => {
        const mcpToolResult = await mcp.callTool({
          name: tool.name,
          arguments: input as Record<string, unknown>,
        })
        return mcpToolResult.content.filter(v => v.type === 'text').map(v => v.text).join('\n')
      },
    }))
    return { tools, close }
  } catch (error) {
    await close().catch(() => {})
    throw error
  }
}
