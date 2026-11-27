import { styleText } from 'node:util'
import { compactCommand } from './compact.ts'
import { contextCommand } from './context.ts'
import { modelCommand } from './model.ts'
import { sessionCommand } from './session.ts'
import type { CommandContext, CommandResult, SlashCommand } from './types.ts'

const exitCommand: SlashCommand = {
  name: '/exit',
  description: '退出程序',
  execute: () => {
    process.stdout.write(styleText('blueBright', '退出程序\n'))
    return 'exit'
  },
}

const commands: SlashCommand[] = [
  modelCommand,
  sessionCommand,
  contextCommand,
  compactCommand,
  exitCommand,
]

const helpCommand: SlashCommand = {
  name: '/help',
  description: '查看所有可用斜杠命令',
  execute: () => {
    const lines = [
      '可用命令：',
      ...allCommands.map((cmd) => `  ${cmd.name.padEnd(10)} ${cmd.description}`),
    ]
    process.stdout.write(styleText('blueBright', `${lines.join('\n')}\n`))
  },
}

const allCommands: SlashCommand[] = [...commands, helpCommand]
const byName = new Map<string, SlashCommand>(allCommands.map((cmd) => [cmd.name, cmd]))

/**
 * 尝试把用户输入作为斜杠命令分发。
 * - 不以 `/` 开头返回 `'not_command'`，交由主循环按普通提问处理；
 * - 未知的 `/` 命令直接提示并返回 `'continue'`，避免误发给模型浪费 token。
 */
export async function dispatchCommand(
  rawInput: string,
  ctx: CommandContext,
): Promise<CommandResult | 'not_command'> {
  if (!rawInput.startsWith('/')) {
    return 'not_command'
  }

  const [name, ...args] = rawInput.split(/\s+/)
  const command = byName.get(name)
  if (!command) {
    process.stdout.write(styleText('yellowBright', `未知命令：${name}，输入 /help 查看可用命令\n`))
    return 'continue'
  }

  const result = await command.execute({ raw: rawInput, args }, ctx)
  return result ?? 'continue'
}
