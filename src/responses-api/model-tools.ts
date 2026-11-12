import { OpenAI } from "openai";
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client'
import { zodResponsesFunction } from 'openai/helpers/zod'
import { z } from 'zod'
import pfs from 'fs/promises'
import { spawn, type ChildProcess } from 'node:child_process'
import { resolve, sep } from 'node:path'

/** 所有工具共用的根目录：read_file / apply_patch 的相对路径、run_shell 的 cwd 都以它为基准 */
export const WORKSPACE_ROOT = process.cwd()

const mcp = new Client({ name: 'docs-cli', version: '0.1.0' })
const transport = new StreamableHTTPClientTransport(
  new URL('https://developers.openai.com/mcp'),
)

// 手写工具声明
// const currentTimeTool: OpenAI.Responses.FunctionTool = {
//   name: 'get_current_time', // 工具名称
//   type: 'function', // 类型定义 固定为 function
//   description: '查询指定时区的当前日期和时间', // 工具描述
//   parameters: {
//     type: 'object',
//     properties: {
//       timezone: {
//         type: 'string',
//         description: '时区名称，如 "Asia/Shanghai"',
//       }
//     },
//     required: ['timezone'], // 规定参数必填
//     additionalProperties: false, // 是否允许额外属性
//   },
//   strict: false, // 是否严格验证参数
// }


// function get_current_time(args: { timezone: string }) {
//   if (!args || !args.timezone) {
//     return '请提供正确的时区名称'
//   }
//   const currentTime = new Date().toLocaleString('zh-CN', { timeZone: args.timezone })
//   return `当前${args.timezone}的日期和时间：${currentTime}`
// }

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
  description: '读取文件内容',
  parameters: z.object({
    path: z.string().describe('文件路径'),
  }),
  function: async (args) => {
    if (!args.path) {
      return '请提供文件路径'
    }
    const path = resolve(WORKSPACE_ROOT, args.path)
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

/** cwd 必须落在项目目录内，防止模型 cd 到项目外面 */
function resolveShellCwd(cwd?: string): string {
  const target = resolve(WORKSPACE_ROOT, cwd && cwd.trim() ? cwd.trim() : '.')
  if (target !== WORKSPACE_ROOT && !target.startsWith(WORKSPACE_ROOT + sep)) {
    throw new Error(`工作目录必须位于项目目录内（${WORKSPACE_ROOT}），收到：${target}`)
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

function runShellCommand(
  command: string,
  options: { cwd?: string, timeoutMs?: number } = {},
): Promise<ShellResult> {
  const cwd = resolveShellCwd(options.cwd)
  const timeoutMs = Math.min(
    Math.max(Math.trunc(options.timeoutMs ?? DEFAULT_SHELL_TIMEOUT_MS), 1_000),
    MAX_SHELL_TIMEOUT_MS,
  )

  return new Promise<ShellResult>((resolvePromise, rejectPromise) => {
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
    '- 不要执行交互式命令（vim、less、top、不带 -m 的 git commit、等待 stdin 的程序），它们会立即失败。',
    '- 读取文件内容优先用 read_file（会校验路径并给出更明确的错误），修改文件用 apply_patch，不要用 shell 重写整份文件。',
    '- 输出上限 20000 字符，超出会被截断；看大文件请配合 head / tail / grep。',
  ].join('\n'),
  parameters: z.object({
    command: z.string().describe('要执行的完整命令，例如 `git status --short` 或 `ls -la src`'),
    cwd: z.string().nullable().describe('工作目录，相对路径以项目根目录为基准，不能指向项目目录之外'),
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

export let ALL_TOOLS_DEFINED: OpenAI.Responses.Tool[] = [
  currentTimeTool,
  readFileTool,
  runShellTool,
  {
    type: "custom",
    name: "apply_patch"
  }
]

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
  const mcpToolResult = await mcp.callTool({
    name: toolName,
    arguments: args,
  })
  return mcpToolResult.content.filter(v => v.type === 'text').map(v => v.text).join('\n')
}

export const TERMINATE_MCP = async () => {
  await transport.terminateSession().finally(() => mcp.close())
}

export const INIT_MCP = async () => {
  await mcp.connect(transport)
  try {
    const { tools } = await mcp.listTools()
    const mcpModelTools: OpenAI.Responses.FunctionTool[] = tools.map(tool => ({
      type: 'function',
      name: tool.name,
      description: tool.description,
      parameters: tool.inputSchema,
      strict: false,
    }))
    ALL_TOOLS_DEFINED.push(...mcpModelTools)
  } catch (error) {
    await TERMINATE_MCP().catch(() => {})
    throw error
  }

  return {
    TERMINATE_MCP
  }
}

