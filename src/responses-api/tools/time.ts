import { z } from 'zod'
import { defineFunctionTool } from './types.ts'

export const currentTimeTool = defineFunctionTool({
  name: 'get_current_time',
  description: '查询指定时区的当前日期和时间',
  parameters: z.object({
    timezone: z.string().describe('时区名称，如 "Asia/Shanghai"'),
  }),
  execute: (args) => {
    if (!args || !args.timezone) {
      return '请提供正确的时区名称'
    }
    const currentTime = new Date().toLocaleString('zh-CN', { timeZone: args.timezone })
    return `当前${args.timezone}的日期和时间：${currentTime}`
  }
})
