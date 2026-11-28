import { z } from 'zod'
import { appendInboxNote, readMemory } from '../memory/store.ts'
import {
  MEMORY_BUCKETS,
  MEMORY_SCOPES,
  MEMORY_TYPES,
  type MemoryBucket,
  type MemoryScope,
  type MemoryType,
} from '../memory/types.ts'
import { defineFunctionTool } from './types.ts'

/**
 * 在线写入工具：往对应作用域的 inbox/ 追加一条明文 Markdown 碎片笔记。
 * 只追加不覆盖，也不刷新当前会话的 instructions（保护 Prompt Cache 前缀不失效），
 * 后续由整理器统一完成去重、合并冲突并写入正式 entries/。
 */
export const memoryNoteTool = defineFunctionTool({
  name: 'memory_note',
  description: [
    '把一条值得跨会话保留的信息记入长期记忆收件箱（inbox，明文 Markdown），供后续整理并跨会话复用。',
    '适用类型（type）：',
    '- user：用户画像、沟通风格、长期工具偏好（通常 scope=global）',
    '- feedback：用户对你的纠偏、行为红线与原因（scope 视是否跨项目选 global 或 project）',
    '- project：代码里看不出来的项目背景、设计取舍、踩坑实测（仅 scope=project）',
    '- reference：外部文档、服务地址或数据入口指针',
    '绝对不要记录（反面清单）：',
    '- 能直接从当前代码、package.json 或 git log 读出的事实（容易过时腐烂）',
    '- 一次性的临时调试过程或报错流水',
    '- 已经在 AGENTS.md 里写死的静态规范',
  ].join('\n'),
  parameters: z.object({
    scope: z.enum(MEMORY_SCOPES).describe('作用域：global（跨项目通用）或 project（仅当前项目）'),
    type: z.enum(MEMORY_TYPES).describe('记忆分类：user / feedback / project / reference'),
    title: z.string().describe('简短单行标题，便于在索引里一眼识别主题'),
    content: z.string().describe('完整正文：尽量写清结论 + 原因（Why）或适用场景，不要只写一句无上下文的口号'),
  }),
  execute: async (args) => {
    const scope = args?.scope as MemoryScope | undefined
    const type = args?.type as MemoryType | undefined
    const title = args?.title?.trim() ?? ''
    const content = args?.content?.trim() ?? ''

    if (!scope || !(MEMORY_SCOPES as readonly string[]).includes(scope)) {
      return `scope 参数非法，可选值：${MEMORY_SCOPES.join(' / ')}`
    }
    if (!type || !(MEMORY_TYPES as readonly string[]).includes(type)) {
      return `type 参数非法，可选值：${MEMORY_TYPES.join(' / ')}`
    }
    if (!title) {
      return 'title 不能为空'
    }
    if (!content) {
      return 'content 不能为空'
    }

    try {
      const saved = await appendInboxNote({ scope, type, title, content })
      return [
        '已记入长期记忆收件箱（inbox，待后续整理）：',
        `- scope: ${saved.scope}`,
        `- type: ${saved.type}`,
        `- title: ${saved.title}`,
        `- file: ${saved.file}`,
        `- path: ${saved.path}`,
      ].join('\n')
    } catch (error) {
      return `memory_note 写入失败：${(error as Error).message}`
    }
  },
})

/**
 * 按需读取工具：对应系统提示中“长期记忆索引”列出的条目，读取完整 Markdown 正文。
 * 采用与 Skills 相同的渐进式披露策略，避免把所有记忆全文塞进 instructions 撑爆上下文。
 */
export const memoryReadTool = defineFunctionTool({
  name: 'memory_read',
  description: '读取一条长期记忆的完整正文。请传入系统提示「长期记忆」索引中列出的 scope、bucket 和 file。',
  parameters: z.object({
    scope: z.enum(MEMORY_SCOPES).describe('作用域：global 或 project'),
    bucket: z.enum(MEMORY_BUCKETS).describe('来源桶：entries（已整理）或 inbox（待整理）'),
    file: z.string().describe('索引里给出的纯文件名，例如 20261128-215012-345-a1b2-prefer-pnpm.md'),
  }),
  execute: async (args) => {
    const scope = args?.scope as MemoryScope | undefined
    const bucket = args?.bucket as MemoryBucket | undefined
    const file = args?.file?.trim() ?? ''

    if (!scope || !(MEMORY_SCOPES as readonly string[]).includes(scope)) {
      return `scope 参数非法，可选值：${MEMORY_SCOPES.join(' / ')}`
    }
    if (!bucket || !(MEMORY_BUCKETS as readonly string[]).includes(bucket)) {
      return `bucket 参数非法，可选值：${MEMORY_BUCKETS.join(' / ')}`
    }
    if (!file) {
      return '请提供要读取的 file 文件名'
    }

    try {
      const record = await readMemory({ scope, bucket, file })
      if (!record) {
        return `未找到记忆文件：scope=${scope}, bucket=${bucket}, file=${file}`
      }
      return record.raw
    } catch (error) {
      return `memory_read 读取失败：${(error as Error).message}`
    }
  },
})
