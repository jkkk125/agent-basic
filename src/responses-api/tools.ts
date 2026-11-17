import { OpenAI } from "openai";
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client'
import { zodResponsesFunction } from 'openai/helpers/zod'
import { z } from 'zod'
import pfs from 'fs/promises'
import { spawn, type ChildProcess } from 'node:child_process'
import { isAbsolute, resolve, sep } from 'node:path'

/** 所有工具共用的默认根目录：相对路径都以它为基准；绝对路径可以直接指向其他目录 */
export const WORKSPACE_ROOT = process.cwd()

/** 相对路径锚定工作区，绝对路径原样使用；默认在工作区内，显式给绝对路径就能操作别的目录 */
export function resolveWorkspacePath(path: string): string {
  const trimmed = path.trim()
  return isAbsolute(trimmed) ? resolve(trimmed) : resolve(WORKSPACE_ROOT, trimmed)
}

const mcp = new Client({ name: 'docs-cli', version: '0.1.0' })
const transport = new StreamableHTTPClientTransport(
  new URL('https://developers.openai.com/mcp'),
)

const currentTimeTool = zodResponsesFunction({
  name: 'get_current_time',
  description: '查询指定时区的当前日期和时间',
  parameters: z.object({
    timezone: z.string().describe('时区名称，如 "Asia/Shanghai"'),
  }),
  function: (args) => {
    if (!args || !args.timezone) {
      return '请提供正确的时区名称'
    }
    const currentTime = new Date().toLocaleString('zh-CN', { timeZone: args.timezone })
    return `当前${args.timezone}的日期和时间：${currentTime}`
  }
})

const readFileTool = zodResponsesFunction({
  name: 'read_file',
  description: '读取文件内容。相对路径以项目根目录为基准，也可以传绝对路径读取其他目录的文件',
  parameters: z.object({
    path: z.string().describe('文件路径，相对路径以项目根目录为基准；绝对路径可指向项目外的目录'),
  }),
  function: async (args) => {
    if (!args.path) {
      return '请提供文件路径'
    }
    const path = resolveWorkspacePath(args.path)
    const stat = await pfs.stat(path).catch(() => null)
    if (!stat) {
      return `${path} 文件不存在`
    }
    if (!stat.isFile()) {
      return `${path} 不是文件，read_file 只能读取文件`
    }
    const content = await pfs.readFile(path, 'utf-8')
    return content
  }
})

const deepseekWebSearchQueryDescription = [
  '搜索词，1～128 个 Unicode 字符，不能全为空白，支持下方列出的搜索语法。',
  '搜索语法：',
  'query 中的搜索语法会原样传递给搜索服务。下列示例将操作符与搜索词组合使用；你可以在一个 query 中组合多个操作符。',

  `操作符：site:
示例：DeepSeek site:github.com
说明：将结果限制在指定站点，指定多个时用空格分隔并通过 OR 连接，例如 DeepSeek site:github.com OR site:huggingface.co。`,

  `操作符：-site:
示例：DeepSeek -site:example.com
说明：排除指定站点，指定多个时用空格分隔。`,

  `操作符：-
示例：DeepSeek -广告
说明：排除包含指定关键词的网页，指定多个时用空格分隔。`,

  `操作符：-"..."
示例：DeepSeek -"release notes"
说明：排除包含指定短语的网页，短语内可以包含空格，指定多个时用空格分隔。`,

  `操作符："..."
示例：DeepSeek "精确短语"
说明：精确匹配指定短语，指定多个时用空格分隔。`,

  `操作符：lang:
示例：DeepSeek lang:zh,en
说明：将结果限制在指定语言，多种语言用逗号分隔，例如 lang:zh,en。`,

  `操作符：after:
示例：DeepSeek after:2025 或 DeepSeek after:2025-01-01
说明：将结果限制在指定日期之后发布的网页。`,

  `操作符：before:
示例：DeepSeek before:2026 或 DeepSeek before:2026-06-01
说明：将结果限制在指定日期之前发布的网页。`,
];

const deepseekWebSearchTool = zodResponsesFunction({
  name: 'deepseek_web_search',
  description: '按 query 搜索网页，返回结构化结果',
  parameters: z.object({
    query: z.string().describe(deepseekWebSearchQueryDescription.join('\n')),
    count: z.number().describe('返回条数，1～50，默认 10'),
  }),
  function: async (args) => {
    const { query, count } = args
    if (!query) {
      return '请提供搜索关键词'
    }
    if (count < 1 || count > 50) {
      return '返回条数必须在 1～50 之间'
    }

    const apiKey = process.env.API_KEY
    if (!apiKey) {
      return '请配置 API_KEY 环境变量'
    }

    const DeepseekSearchResult = z.object({
      rerank_score: z.number(), // 0～3，≥1.5 为优质
      title: z.string(),
      url: z.string(),
      snippet: z.string(), // 短摘要，通常 100～200 字符
      summary: z.string(), // 长摘要，通常 600～800 字符
      content: z.string(), // need_content=false 或缺失时为 ""
      site_name: z.string().nullable(),
      site_icon: z.string().nullable(),
      date: z.string().nullable(), // RFC 3339 UTC，未知为 null
      authority: z.number().int(), // 0～4，-1 表示未知
    })
    
    const DeepseekSearchResponse = z.object({
      results: z.array(DeepseekSearchResult),
    })
    
    const response = await fetch('https://api.deepseek.com/v1/tools/search', {
      headers: {
        Authorization: `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
      },
      method: 'POST',
      body: JSON.stringify({
        query,
        count
      })
    }).then(res => res.json())

    const parsedResponse = DeepseekSearchResponse.parse(response)

    return JSON.stringify(parsedResponse, null, 2)
  }
})

const deepseekReadUrlTool = zodResponsesFunction({
  name: 'deepseek_read_url',
  description: '抓取单个网页，以 Markdown 文本返回页面内容。',
  parameters: z.object({
    url: z.string().describe('要抓取的网页地址，长度不超过 8192；必须为含 host 的 HTTP/HTTPS URL，且不能携带用户名或密码。')
  }),
  function: async (args) => {
    const { url } = args
    if (!url) {
      return '请提供网页地址'
    }
    if (url.length > 8192) {
      return '网页地址长度不能超过 8192 个字符'
    }
    if (!url.startsWith('http://') && !url.startsWith('https://')) {
      return '网页地址必须以 http:// 或 https:// 开头'
    }
    if (url.includes('@')) {
      return '网页地址不能包含用户名或密码'
    }
    const apiKey = process.env.API_KEY
    if (!apiKey) {
      return '请配置 API_KEY 环境变量'
    }
    const response = await fetch('https://api.deepseek.com/v1/tools/fetch', {
      headers: {
        Authorization: `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
      },
      method: 'POST',
      body: JSON.stringify({
        url
      })
    }).then(res => res.json())

    const DeepseekReadUrlResult = z.object({
      title: z.string(),
      content: z.string(),
    })

    const parsedResponse = DeepseekReadUrlResult.parse(response)

    return JSON.stringify(parsedResponse, null, 2)
  }
})


const DEFAULT_SHELL_TIMEOUT_MS = 60_000
const MAX_SHELL_TIMEOUT_MS = 300_000
const MAX_SHELL_OUTPUT_CHARS = 20_000
const SHELL_KILL_GRACE_MS = 2_000

type ShellResult = {
  cwd: string
  stdout: string
  stderr: string
  exitCode: number | null
  timedOut: boolean
  truncated: boolean
  timeoutMs: number
}

/** 相对 cwd 必须落在项目目录内；绝对路径视为用户显式指定，允许指向项目外的其他目录 */
function resolveShellCwd(cwd?: string): string {
  const raw = cwd?.trim()
  if (!raw) return WORKSPACE_ROOT
  if (isAbsolute(raw)) return resolve(raw)
  const target = resolve(WORKSPACE_ROOT, raw)
  if (target !== WORKSPACE_ROOT && !target.startsWith(WORKSPACE_ROOT + sep)) {
    throw new Error(
      `相对工作目录不能指向项目目录之外（${WORKSPACE_ROOT}），如需操作其他目录请传绝对路径，收到：${raw}`,
    )
  }
  return target
}

/** 杀掉以 child 为组长的整个进程组；只 kill 父进程会留下 build/watch 之类的孙进程 */
function killChildTree(child: ChildProcess) {
  if (child.pid === undefined) return
  try {
    process.kill(-child.pid, 'SIGKILL')
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ESRCH') {
      child.kill('SIGKILL')
    }
  }
}

async function runShellCommand(
  command: string,
  options: { cwd?: string, timeoutMs?: number } = {},
): Promise<ShellResult> {
  const cwd = resolveShellCwd(options.cwd)
  const cwdStat = await pfs.stat(cwd).catch(() => null)
  if (!cwdStat?.isDirectory()) {
    throw new Error(`工作目录不存在或不是目录：${cwd}`)
  }
  const timeoutMs = Math.min(
    Math.max(Math.trunc(options.timeoutMs ?? DEFAULT_SHELL_TIMEOUT_MS), 1_000),
    MAX_SHELL_TIMEOUT_MS,
  )

  return await new Promise<ShellResult>((resolvePromise, rejectPromise) => {
    const child = spawn('sh', ['-c', command], {
      cwd,
      detached: true, // 自成进程组，超时时可以整组杀掉
      stdio: ['ignore', 'pipe', 'pipe'], // stdin 置空，交互式命令会直接失败而不是挂住
    })

    let stdout = ''
    let stderr = ''
    let captured = 0
    let truncated = false
    let timedOut = false
    let settled = false
    let timer: NodeJS.Timeout | undefined
    let killTimer: NodeJS.Timeout | undefined

    // stdout/stderr 共享一个字符预算，避免 cat 大文件把上下文撑爆
    const append = (target: 'stdout' | 'stderr', chunk: string) => {
      if (captured >= MAX_SHELL_OUTPUT_CHARS) {
        truncated = true
        return
      }
      const remain = MAX_SHELL_OUTPUT_CHARS - captured
      const text = chunk.length > remain ? chunk.slice(0, remain) : chunk
      if (target === 'stdout') {
        stdout += text
      } else {
        stderr += text
      }
      captured += text.length
      if (text.length < chunk.length) truncated = true
    }

    child.stdout?.setEncoding('utf8')
    child.stderr?.setEncoding('utf8')
    child.stdout?.on('data', (chunk: string) => append('stdout', chunk))
    child.stderr?.on('data', (chunk: string) => append('stderr', chunk))

    const settle = (exitCode: number | null) => {
      if (settled) return
      settled = true
      if (timer) clearTimeout(timer)
      if (killTimer) clearTimeout(killTimer)
      resolvePromise({ cwd, stdout, stderr, exitCode, timedOut, truncated, timeoutMs })
    }

    timer = setTimeout(() => {
      timedOut = true
      killChildTree(child)
      // 万一有孙进程脱离了进程组、close 一直不来，兜底收尾
      killTimer = setTimeout(() => settle(null), SHELL_KILL_GRACE_MS)
    }, timeoutMs)

    child.on('error', (error) => {
      if (settled) return
      settled = true
      if (timer) clearTimeout(timer)
      if (killTimer) clearTimeout(killTimer)
      rejectPromise(error)
    })

    child.on('close', (code) => settle(code))
  })
}

function formatShellResult(result: ShellResult): string {
  const lines: string[] = []
  if (result.timedOut) {
    lines.push(`outcome: 超时（超过 ${result.timeoutMs}ms），命令已连同子进程被强制终止`)
  } else {
    lines.push(`exit_code: ${result.exitCode}`)
  }
  lines.push(`cwd: ${result.cwd}`)
  lines.push('stdout:')
  lines.push(result.stdout.trim() === '' ? '(空)' : result.stdout.trimEnd())
  lines.push('stderr:')
  lines.push(result.stderr.trim() === '' ? '(空)' : result.stderr.trimEnd())
  if (result.truncated) {
    lines.push(`[输出超过 ${MAX_SHELL_OUTPUT_CHARS} 字符，已截断]`)
  }
  return lines.join('\n')
}

const runShellTool = zodResponsesFunction({
  name: 'run_shell',
  description: [
    '在用户的本地项目里执行一条 shell 命令（sh -c，非交互），返回 stdout、stderr 和退出码。',
    '限制与约定：',
    '- 每条命令都在全新进程里执行，`cd` 不会保留到下一次调用；请用 cwd 参数，或用绝对路径 / `&&` 串联。',
    '- 默认在当前项目目录下执行；要操作项目外的目录，cwd 或命令里请直接写绝对路径。',
    '- 不要执行交互式命令（vim、less、top、不带 -m 的 git commit、等待 stdin 的程序），它们会立即失败。',
    '- 读取文件内容优先用 read_file（会校验路径并给出更明确的错误），修改文件用 apply_patch，不要用 shell 重写整份文件。',
    '- 输出上限 20000 字符，超出会被截断；看大文件请配合 head / tail / grep。',
  ].join('\n'),
  parameters: z.object({
    command: z.string().describe('要执行的完整命令，例如 `git status --short` 或 `ls -la src`'),
    cwd: z.string().nullable().describe('工作目录，相对路径以项目根目录为基准且不能跳出项目；绝对路径可以指向项目外的其他目录'),
    timeout_ms: z.number().nullable().describe('超时毫秒数，默认 60000，最大 300000'),
  }),
  function: async (args) => {
    const command = args?.command?.trim()
    if (!command) {
      return '请提供要执行的命令'
    }
    try {
      const result = await runShellCommand(command, {
        cwd: args.cwd ?? undefined,
        timeoutMs: args.timeout_ms ?? undefined,
      })
      return formatShellResult(result)
    } catch (error) {
      return `run_shell 执行失败：${(error as Error).message}`
    }
  },
})

export const initTools = async (modelName: string) => {
  const tools: OpenAI.Responses.Tool[] = [
    currentTimeTool,
    readFileTool,
    runShellTool,
    
    {
      type: "custom",
      name: "apply_patch"
    }
  ]

  const TERMINATE_MCP = async () => {
    await transport.terminateSession().finally(() => mcp.close())
  }

  await mcp.connect(transport)
  try {
    const mcpListResult = await mcp.listTools()
    const mcpModelTools: OpenAI.Responses.FunctionTool[] = mcpListResult.tools.map(tool => ({
      type: 'function',
      name: tool.name,
      description: tool.description,
      parameters: tool.inputSchema,
      strict: false,
    }))
    tools.push(...mcpModelTools)
  } catch (error) {
    await TERMINATE_MCP().catch(() => {})
    throw error
  }

  if (modelName.endsWith('-pro')) {
    tools.push({
      type: 'web_search'
    })
  }

  if (modelName.endsWith('-flash')) {
    tools.push(deepseekWebSearchTool)
    tools.push(deepseekReadUrlTool)
  }

  return {
    tools,
    TERMINATE_MCP
  }
}


export const EXEC_TOOL = async (toolName: string, args: any) => {
  if (toolName === 'get_current_time') {
    return currentTimeTool.$callback ? currentTimeTool.$callback(args) : 'get_current_time 工具调用失败'
  }
  if (toolName === 'read_file') {
    return readFileTool.$callback ? readFileTool.$callback(args) : 'read_file 工具调用失败'
  }
  if (toolName === 'run_shell') {
    return runShellTool.$callback ? runShellTool.$callback(args) : 'run_shell 工具调用失败'
  }
  if (toolName === 'deepseek_web_search') {
    return deepseekWebSearchTool.$callback ? deepseekWebSearchTool.$callback(args) : 'deepseek_web_search 工具调用失败'
  }
  if (toolName === 'deepseek_read_url') {
    return deepseekReadUrlTool.$callback ? deepseekReadUrlTool.$callback(args) : 'deepseek_read_url 工具调用失败'
  }

  const mcpToolResult = await mcp.callTool({
    name: toolName,
    arguments: args,
  })
  return mcpToolResult.content.filter(v => v.type === 'text').map(v => v.text).join('\n')
}
