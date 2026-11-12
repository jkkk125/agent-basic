import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client'
import type OpenAI from 'openai'

const mcp = new Client({ name: 'docs-cli', version: '0.1.0' })
const transport = new StreamableHTTPClientTransport(
  new URL('https://developers.openai.com/mcp'),
)

await mcp.connect(transport)



try {
  const { tools } = await mcp.listTools()
  const modelTools: OpenAI.Responses.FunctionTool[] = tools.map(tool => {
    return {
      type: 'function',
      name: tool.name,
      description: tool.description,
      parameters: tool.inputSchema,
      strict: false
    }
  })

  console.log(modelTools)
} catch (error) {
  console.error(error)
  await transport.terminateSession().finally(() => mcp.close())
}