import { styleText } from 'node:util'
import { getSessionInfo, loadHistory } from '../session.ts'
import type { SlashCommand } from './types.ts'

export const sessionCommand: SlashCommand = {
  name: '/session',
  description: '查看当前会话或切换到历史会话，用法：/session <会话 id>',
  execute: async ({ args }, ctx) => {
    const targetId = args[0]
    if (!targetId) {
      process.stdout.write(styleText(
        'blueBright',
        `当前会话：${ctx.getSessionId() ?? '（尚未创建）'}\n用法：/session <会话 id>\n`,
      ))
      return
    }

    try {
      // 先校验并加载，成功后再切换 sessionId；失败时当前会话原样保留
      const [sessionInfo, sessionHistory] = await Promise.all([
        getSessionInfo(targetId),
        loadHistory(targetId),
      ])
      ctx.setSessionId(targetId)
      process.stdout.write(styleText(
        'blueBright',
        `已切换到会话 sessionId: ${targetId} name: ${sessionInfo.name}，共 ${sessionHistory.length} 条消息\n`,
      ))
    } catch (e) {
      process.stdout.write(styleText('redBright', `切换会话失败：${(e as Error).message}\n`))
    }
  },
}
