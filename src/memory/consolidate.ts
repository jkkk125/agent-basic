import type { OpenAI } from 'openai'
import { zodTextFormat } from 'openai/helpers/zod'
import { z } from 'zod'
import { resolveProjectRoot } from '../paths.ts'
import {
  archiveInboxFiles,
  assertSafeFileName,
  deleteMemoryEntry,
  listBucketRecords,
  slugifyEntryFileName,
  writeMemoryEntry,
} from './store.ts'
import {
  MEMORY_SCOPES,
  MEMORY_TYPES,
  type AppliedConsolidationAction,
  type ConsolidationAction,
  type ConsolidationPlan,
  type ConsolidationScopeResult,
  type MemoryRecord,
  type MemoryScope,
  type MemoryType,
} from './types.ts'

/**
 * 整理器结构化输出 Schema：
 * 采用“扁平单对象 + nullable 字段”，完全兼容 OpenAI strict json_schema（所有字段均在 required 中，避免复杂 union 兼容性坑）。
 */
const ConsolidationActionSchema = z.object({
  action: z.enum(['create', 'update', 'delete']),
  file: z.string().describe('update/delete 时填现有 entries 的精确文件名；create 时填简洁英文或中文 slug（如 prefer-pnpm）'),
  type: z.enum(MEMORY_TYPES).nullable().describe('create/update 时必填；delete 时填 null'),
  title: z.string().nullable().describe('create/update 时必填的单行标题；delete 时填 null'),
  description: z.string().nullable().describe('create/update 时必填的一句话摘要（供索引展示）；delete 时填 null'),
  content: z.string().nullable().describe('create/update 时必填的完整 Markdown 正文（保留原因与场景）；delete 时填 null'),
  reason: z.string().describe('简短说明执行该操作的原因，便于终端审计 diff'),
})

export const ConsolidationPlanSchema = z.object({
  summary: z.string().describe('本次整理的总体说明（用中文简述合并了哪些主题、解决了什么冲突、过滤了什么噪音）'),
  actions: z.array(ConsolidationActionSchema).describe('对 entries/ 要执行的有序文件操作；若全部 inbox 都是噪音或与现有 entries 完全重复，可返回空数组'),
})

export type ConsolidateScopeOptions = {
  client: OpenAI
  model: string
  scope: MemoryScope
  projectRoot?: string
  /** 演练模式：只产出并校验计划、打印 diff，不真正改动 entries/ 或 archive/ */
  dryRun?: boolean
}

export type ConsolidateAllOptions = {
  client: OpenAI
  model: string
  /** 指定只整理某个作用域；省略时依次整理 global 与 project */
  scopes?: MemoryScope[]
  projectRoot?: string
  dryRun?: boolean
}

/** 构造整理器系统提示：明确 4 类定义、反面清单、冲突解决规则与合并原则 */
function buildConsolidationInstructions(scope: MemoryScope): string {
  const scopeDesc = scope === 'global'
    ? 'global（用户级全局长期记忆，跨所有项目生效）'
    : 'project（当前项目专属长期记忆，只对当前仓库生效）'

  return [
    `你是长期记忆整理器，负责把「待整理收件箱 inbox」中的碎片笔记，合并整理进「正式长期记忆 entries」。`,
    `本次仅整理作用域：${scopeDesc}。`,
    '',
    '## 记忆分类（type）',
    '- user：用户画像、沟通风格、长期工具偏好',
    '- feedback：用户对助手的纠偏、行为红线与原因（高优先级，务必保留 Why）',
    '- project：代码里看不出的项目背景、架构取舍、踩坑实测',
    '- reference：外部文档、服务地址或数据入口指针',
    '',
    '## 核心整理原则',
    '1. **按时间顺序解决冲突**：inbox 按时间从早到晚排列。后记录的明确新决定覆盖早前的旧决定或旧 entry（例如从 npm 改用 pnpm，应直接更新或替换，绝不让矛盾信息并存）。',
    '2. **同类合零为整**：主题相近的多条 inbox 笔记应合并进同一篇结构清晰的 entry，控制 entries 总数精简，不要为每条碎片建单独文件。',
    '3. **优先复用已有 entry**：若新笔记属于现有某个 entry 的补充、修正或覆盖，使用 `update` 并填写原精确文件名；仅在确实是全新独立主题时才用 `create`。',
    '4. **严格过滤噪音（反面清单）**：以下内容直接忽略，不要写入 entries（若某条已有 entry 已被新事实证伪或彻底过时，可用 `delete` 移除）：',
    '   - 能直接从当前代码、package.json 或 git log 读出的瞬时实现细节',
    '   - 一次性的临时调试过程或已解决的偶发报错',
    '   - 与现有 entries 完全重复、没有新增信息的内容',
    '5. **保留原因与上下文**：`description` 写清一句话触发条件/要点，`content` 用中文写清结论 + 原因（Why）与适用场景，简练准确。',
    '6. **全部噪音或无需改动时**：`actions` 返回空数组 `[]`，并在 `summary` 说明原因。',
  ].join('\n')
}

/** 把现有 entries 快照和按时间排序的 inbox 快照格式化为整理输入 */
function buildConsolidationInput(entries: MemoryRecord[], inbox: MemoryRecord[]): string {
  const sections: string[] = []

  sections.push('## 一、当前正式记忆（entries/）')
  if (entries.length === 0) {
    sections.push('（当前为空）')
  } else {
    for (const entry of entries) {
      sections.push(
        `### FILE: ${entry.file}`,
        `- type: ${entry.type}`,
        `- title: ${entry.title}`,
        ...(entry.description ? [`- description: ${entry.description}`] : []),
        `- updated_at: ${entry.timestamp || '未知'}`,
        '',
        entry.content,
        '',
      )
    }
  }

  sections.push('## 二、待整理收件箱（inbox/，按记录时间从早到晚排序）')
  for (const [idx, note] of inbox.entries()) {
    sections.push(
      `### INBOX #${idx + 1}: ${note.file}`,
      `- type: ${note.type}`,
      `- title: ${note.title}`,
      `- created_at: ${note.timestamp || '未知'}`,
      '',
      note.content,
      '',
    )
  }

  sections.push('请输出严格符合 JSON Schema 的整理计划（仅输出 JSON）。')
  return sections.join('\n')
}

/** 剥离某些模型偶尔包裹的 ```json 代码块后做 JSON.parse + Zod 校验 */
function parseConsolidationPlan(rawText: string): ConsolidationPlan {
  const trimmed = rawText.trim()
  const fenced = trimmed.match(/^```(?:json)?\s*\r?\n([\s\S]*?)\r?\n```$/i)
  const jsonText = fenced ? fenced[1].trim() : trimmed

  let parsed: unknown
  try {
    parsed = JSON.parse(jsonText)
  } catch (error) {
    throw new Error(`整理器返回的不是合法 JSON：${(error as Error).message}`)
  }

  return ConsolidationPlanSchema.parse(parsed)
}

/**
 * 校验并归一化模型返回的全部动作，防止模型幻觉编造文件名、越界删文件或写入空正文。
 * 在真正修改磁盘前完成全量校验（All-or-Nothing），避免写到一半才报错留下半成品。
 */
type ValidatedOperation =
  | {
    action: 'create' | 'update'
    file: string
    type: MemoryType
    title: string
    description: string
    content: string
    createdAt?: string
    reason: string
  }
  | {
    action: 'delete'
    file: string
    reason: string
  }

function validateAndNormalizeActions(
  actions: ConsolidationAction[],
  existingEntries: MemoryRecord[],
): ValidatedOperation[] {
  const existingMap = new Map(existingEntries.map((entry) => [entry.file, entry]))
  // 跟踪模拟执行后的在场文件名集合，避免 create 意外覆盖已有条目或同批重名
  const liveFiles = new Set(existingEntries.map((entry) => entry.file))
  const operations: ValidatedOperation[] = []

  const allocateUniqueCreateFile = (rawFile: string, fallbackTitle: string): string => {
    const baseName = slugifyEntryFileName(rawFile, fallbackTitle)
    if (!liveFiles.has(baseName)) return baseName

    const stem = baseName.replace(/\.md$/, '')
    let idx = 2
    while (liveFiles.has(`${stem}-${idx}.md`)) {
      idx += 1
    }
    return `${stem}-${idx}.md`
  }

  for (const [idx, item] of actions.entries()) {
    const label = `actions[${idx}] (${item.action} ${item.file})`

    if (item.action === 'delete') {
      const safeFile = assertSafeFileName(item.file)
      if (!liveFiles.has(safeFile)) {
        throw new Error(`${label} 目标文件不存在，拒绝删除（可能为模型幻觉）`)
      }
      liveFiles.delete(safeFile)
      operations.push({
        action: 'delete',
        file: safeFile,
        reason: item.reason.trim() || '删除过时记忆',
      })
      continue
    }

    const type = item.type
    const title = item.title?.trim() ?? ''
    const description = item.description?.trim() ?? ''
    const content = item.content?.trim() ?? ''

    if (!type || !(MEMORY_TYPES as readonly string[]).includes(type)) {
      throw new Error(`${label} 缺少合法 type`)
    }
    if (!title) {
      throw new Error(`${label} 缺少非空 title`)
    }
    if (!content) {
      throw new Error(`${label} 缺少非空 content`)
    }

    if (item.action === 'update') {
      const safeFile = assertSafeFileName(item.file)
      if (!liveFiles.has(safeFile)) {
        throw new Error(`${label} 目标文件不存在，无法 update（可能为模型幻觉）`)
      }
      operations.push({
        action: 'update',
        file: safeFile,
        type,
        title,
        description,
        content,
        createdAt: existingMap.get(safeFile)?.createdAt,
        reason: item.reason.trim() || '更新已有记忆',
      })
      continue
    }

    // create：清洗为安全文件名，并防止撞名覆盖已有条目
    const uniqueFile = allocateUniqueCreateFile(item.file, title)
    liveFiles.add(uniqueFile)
    operations.push({
      action: 'create',
      file: uniqueFile,
      type,
      title,
      description,
      content,
      reason: item.reason.trim() || '新建长期记忆',
    })
  }

  return operations
}

/**
 * 整理单个作用域（global 或 project）：
 * 1. 读取当前 inbox 与 entries 快照；inbox 为空则短路跳过（0 token）
 * 2. 调模型生成结构化整理计划并做本地全量安全校验
 * 3. 非 dryRun 时原子更新 entries/，全部完成后才将本次快照里的 inbox 文件移入 archive/
 */
export async function consolidateScope(
  options: ConsolidateScopeOptions,
): Promise<ConsolidationScopeResult> {
  const { client, model, scope, dryRun = false } = options
  const projectRoot = options.projectRoot ?? resolveProjectRoot()

  const [entries, inbox] = await Promise.all([
    listBucketRecords(scope, 'entries', projectRoot),
    listBucketRecords(scope, 'inbox', projectRoot),
  ])

  // 空收件箱直接短路，不花任何 token
  if (inbox.length === 0) {
    return {
      scope,
      skipped: true,
      dryRun,
      consumedInboxFiles: [],
      archivedInboxFiles: [],
      summary: 'inbox 为空，跳过整理',
      appliedActions: [],
      responseId: null,
      model,
      usage: null,
    }
  }

  const inboxSnapshotFiles = inbox.map((note) => note.file)

  const response = await client.responses.create({
    model,
    instructions: buildConsolidationInstructions(scope),
    input: [
      {
        type: 'message',
        role: 'user',
        content: buildConsolidationInput(entries, inbox),
      },
    ],
    text: {
      format: zodTextFormat(ConsolidationPlanSchema, 'memory_consolidation_plan'),
    },
    stream: false,
  })

  const rawText = response.output_text.trim()
  if (!rawText) {
    throw new Error(`整理器未返回任何文本（status=${response.status}）`)
  }

  const plan = parseConsolidationPlan(rawText)
  const operations = validateAndNormalizeActions(plan.actions, entries)

  const appliedActions: AppliedConsolidationAction[] = operations.map((op) => (
    op.action === 'delete'
      ? { action: 'delete', file: op.file, reason: op.reason }
      : {
        action: op.action,
        file: op.file,
        type: op.type,
        title: op.title,
        description: op.description || undefined,
        reason: op.reason,
      }
  ))

  let archivedInboxFiles: string[] = []
  if (!dryRun) {
    // 先全部落盘 entries/，任何一步失败都不归档 inbox，确保重试零丢失
    for (const op of operations) {
      if (op.action === 'delete') {
        await deleteMemoryEntry({ scope, file: op.file, projectRoot })
      } else {
        await writeMemoryEntry({
          scope,
          file: op.file,
          type: op.type,
          title: op.title,
          description: op.description,
          content: op.content,
          createdAt: op.createdAt,
          projectRoot,
        })
      }
    }

    // 只归档本次快照处理过的 inbox 文件，不误伤整理期间并发新写入的 note
    archivedInboxFiles = await archiveInboxFiles(scope, inboxSnapshotFiles, projectRoot)
  }

  return {
    scope,
    skipped: false,
    dryRun,
    consumedInboxFiles: inboxSnapshotFiles,
    archivedInboxFiles,
    summary: plan.summary.trim() || '整理完成',
    appliedActions,
    responseId: response.id,
    model,
    usage: response.usage ?? null,
  }
}

/** 依次整理指定作用域（默认 global 与 project） */
export async function consolidateMemories(
  options: ConsolidateAllOptions,
): Promise<ConsolidationScopeResult[]> {
  const scopes = options.scopes ?? [...MEMORY_SCOPES]
  const results: ConsolidationScopeResult[] = []

  for (const scope of scopes) {
    const result = await consolidateScope({
      client: options.client,
      model: options.model,
      scope,
      projectRoot: options.projectRoot,
      dryRun: options.dryRun,
    })
    results.push(result)
  }

  return results
}
