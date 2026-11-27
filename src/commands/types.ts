import type { Interface } from 'node:readline/promises'
import type { OpenAI } from 'openai'
import type { ActiveModelConfig } from '../config.ts'
import type { ToolRegistry } from '../tools/registry.ts'

/** 当前生效的模型运行时：切模型时整体替换，避免 client / registry / instructions 不一致 */
export type AgentRuntime = {
  config: ActiveModelConfig
  client: OpenAI
  registry: ToolRegistry
  instructions: string
}

export type CommandResult = 'continue' | 'exit'

/**
 * 斜杠命令共享的最小进程态上下文。
 * 持久化数据（历史消息、模型配置、usage）由各命令按需直接查 SQLite，不在这里维护副本。
 */
export type CommandContext = {
  rl: Interface
  getSessionId: () => string | undefined
  setSessionId: (sessionId: string | undefined) => void
  getRuntime: () => AgentRuntime | null
  reloadRuntime: () => Promise<void>
}

export type CommandInput = {
  /** 用户输入的原始整行文本（已 trim） */
  raw: string
  /** 命令名之后按空白拆分的参数列表 */
  args: string[]
}

export type SlashCommand = {
  name: string
  description: string
  execute: (input: CommandInput, ctx: CommandContext) => Promise<CommandResult | void> | CommandResult | void
}
