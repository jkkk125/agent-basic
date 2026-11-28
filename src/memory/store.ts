import { randomBytes } from 'node:crypto'
import pfs from 'node:fs/promises'
import path from 'node:path'
import { getScopeMemoryDir, resolveProjectRoot } from '../paths.ts'
import {
  MEMORY_SCOPES,
  MEMORY_TYPES,
  type AppendInboxNoteInput,
  type MemoryBucket,
  type MemoryListing,
  type MemoryRecord,
  type MemoryRecordSummary,
  type MemoryScope,
  type MemoryType,
  type WriteMemoryEntryInput,
} from './types.ts'

const MEMORY_DIR_MODE = 0o700
const MEMORY_FILE_MODE = 0o600
const MAX_SLUG_CHARS = 32
const MAX_ENTRY_SLUG_CHARS = 48

/** 把 frontmatter 里的单行字段值洗掉换行，防止模型传入多行标题撑坏 YAML 头 */
function sanitizeSingleLine(value: string): string {
  return value.replace(/\r?\n+/g, ' ').trim()
}

/**
 * 格式化 UTC 时间戳为文件名友好前缀：YYYYMMDD-HHmmss-SSS。
 * 让 inbox 文件按文件名字典序排序就天然等价于时间先后顺序，方便后续整理器判断新旧覆盖。
 */
function formatFileTimestamp(date: Date): string {
  const pad = (n: number, len = 2) => String(n).padStart(len, '0')
  return [
    `${date.getUTCFullYear()}${pad(date.getUTCMonth() + 1)}${pad(date.getUTCDate())}`,
    `${pad(date.getUTCHours())}${pad(date.getUTCMinutes())}${pad(date.getUTCSeconds())}`,
    pad(date.getUTCMilliseconds(), 3),
  ].join('-')
}

/**
 * 从标题或建议文件名生成可读且跨平台安全的 slug（保留中文、字母、数字，去掉路径分隔符和非法符号）。
 * 人类 ls 查看目录时能直接看懂每条记忆的主题。
 */
function slugifyName(raw: string, maxChars: number, fallback: string): string {
  const cleaned = sanitizeSingleLine(raw)
    .replace(/\.md$/i, '')
    .replace(/[\\/:*?"<>|\s]+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, maxChars)
    .replace(/-+$/g, '')
  return cleaned || fallback
}

/** 把整理器建议的 create 文件名/slug 归一化为安全的 `<slug>.md` */
export function slugifyEntryFileName(rawName: string, fallbackTitle = 'memory'): string {
  const base = slugifyName(rawName, MAX_ENTRY_SLUG_CHARS, '')
    || slugifyName(fallbackTitle, MAX_ENTRY_SLUG_CHARS, 'memory')
  return `${base}.md`
}

/** 校验文件名只指向当前桶内的单个 .md 文件，防止 ../ 等路径穿越 */
export function assertSafeFileName(file: string): string {
  const trimmed = file.trim()
  if (
    !trimmed
    || trimmed.includes('/')
    || trimmed.includes('\\')
    || trimmed.includes('..')
    || !trimmed.endsWith('.md')
  ) {
    throw new Error(`非法记忆文件名：${file}（必须是单个 .md 文件名，不能包含路径分隔符）`)
  }
  return trimmed
}

/**
 * 原子写入：先写同目录临时文件，再用 rename 替换目标路径。
 * 这样以后后台整理并发扫目录时，永远不会读到写了一半的残缺 Markdown 文件。
 */
async function atomicWriteFile(filePath: string, content: string): Promise<void> {
  const tmpPath = `${filePath}.${randomBytes(4).toString('hex')}.tmp`
  await pfs.writeFile(tmpPath, content, { encoding: 'utf8', mode: MEMORY_FILE_MODE })
  try {
    await pfs.rename(tmpPath, filePath)
  } catch (error) {
    await pfs.unlink(tmpPath).catch(() => {})
    throw error
  }
}

/**
 * 解析极简 YAML frontmatter（与 src/skills.ts 同风格）：
 * 只按每行第一个冒号切分，避免值里面包含冒号（如 ISO 时间戳、URL）时被截断。
 */
function parseFrontmatter(raw: string): { meta: Record<string, string>; body: string } {
  const match = raw.match(/^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/)
  if (!match) {
    return { meta: {}, body: raw.trim() }
  }

  const meta: Record<string, string> = {}
  for (const line of match[1].split(/\r?\n/)) {
    const colonIdx = line.indexOf(':')
    if (colonIdx <= 0) continue
    const key = line.slice(0, colonIdx).trim()
    const val = line.slice(colonIdx + 1).trim()
    if (key) meta[key] = val
  }

  const body = raw.slice(match[0].length).trim()
  return { meta, body }
}

/** 校验并归一化 type 字段；人工手动编辑漏写时优雅回退，不让加载崩溃 */
function normalizeMemoryType(rawType: string | undefined, scope: MemoryScope): MemoryType {
  if (rawType && (MEMORY_TYPES as readonly string[]).includes(rawType)) {
    return rawType as MemoryType
  }
  return scope === 'global' ? 'user' : 'project'
}

/**
 * 确保指定作用域的 inbox/、entries/、archive/ 目录存在（收紧权限 0o700）。
 * 项目作用域额外写一个 .project-root 标记文件，方便人工查看 ~/.coda/memory/projects/ 时知道对应哪个仓库。
 */
async function ensureScopeDirs(scope: MemoryScope, projectRoot: string): Promise<string> {
  const scopeDir = getScopeMemoryDir(scope, projectRoot)
  await pfs.mkdir(path.join(scopeDir, 'inbox'), { recursive: true, mode: MEMORY_DIR_MODE })
  await pfs.mkdir(path.join(scopeDir, 'entries'), { recursive: true, mode: MEMORY_DIR_MODE })
  await pfs.mkdir(path.join(scopeDir, 'archive'), { recursive: true, mode: MEMORY_DIR_MODE })

  if (scope === 'project') {
    const markerPath = path.join(scopeDir, '.project-root')
    // 只在不存在时写入，避免每次写入都重复覆盖
    await pfs.writeFile(markerPath, `${projectRoot}\n`, {
      encoding: 'utf8',
      mode: MEMORY_FILE_MODE,
      flag: 'wx',
    }).catch((error: NodeJS.ErrnoException) => {
      if (error.code !== 'EEXIST') throw error
    })
  }

  return scopeDir
}

/** 读取某个桶（entries 或 inbox）下的全部完整记录（含正文），供摘要列表与整理器共用 */
export async function listBucketRecords(
  scope: MemoryScope,
  bucket: MemoryBucket,
  projectRoot: string = resolveProjectRoot(),
): Promise<MemoryRecord[]> {
  const scopeDir = getScopeMemoryDir(scope, projectRoot)
  const bucketDir = path.join(scopeDir, bucket)
  const dirEntries = await pfs.readdir(bucketDir, { withFileTypes: true }).catch(() => [])
  const mdFiles = dirEntries
    .filter((entry) => entry.isFile() && entry.name.endsWith('.md'))
    .map((entry) => entry.name)
    .sort()

  const records = await Promise.all(
    mdFiles.map(async (file): Promise<MemoryRecord | null> => {
      const fullPath = path.join(bucketDir, file)
      const raw = await pfs.readFile(fullPath, 'utf8').catch(() => null)
      if (raw === null) return null

      const { meta, body } = parseFrontmatter(raw)
      return {
        scope,
        bucket,
        file,
        path: fullPath,
        type: normalizeMemoryType(meta.type, scope),
        title: meta.title || file.replace(/\.md$/, ''),
        description: meta.description || undefined,
        timestamp: meta.updated_at || meta.created_at || '',
        createdAt: meta.created_at || undefined,
        content: body,
        raw,
      }
    }),
  )

  return records.filter((item): item is MemoryRecord => item !== null)
}

/** 去掉完整正文，转成轻量摘要 */
function toSummary(record: MemoryRecord): MemoryRecordSummary {
  return {
    scope: record.scope,
    bucket: record.bucket,
    file: record.file,
    path: record.path,
    type: record.type,
    title: record.title,
    description: record.description,
    timestamp: record.timestamp,
  }
}

/** 统计已归档的历史 inbox 笔记数量，供 /memory 观测展示 */
async function countArchivedNotes(scope: MemoryScope, projectRoot: string): Promise<number> {
  const archiveDir = path.join(getScopeMemoryDir(scope, projectRoot), 'archive')
  const entries = await pfs.readdir(archiveDir, { withFileTypes: true }).catch(() => [])
  return entries.filter((entry) => entry.isFile() && entry.name.endsWith('.md')).length
}

/**
 * 在线通道写入入口：往对应作用域的 inbox/ 追加一条明文 Markdown 碎片笔记。
 * 只追加新文件、绝不改写旧文件或 entries/，保证在线写入快且与未来后台整理无写冲突。
 */
export async function appendInboxNote(input: AppendInboxNoteInput): Promise<MemoryRecordSummary> {
  if (!(MEMORY_SCOPES as readonly string[]).includes(input.scope)) {
    throw new Error(`非法 scope：${input.scope}`)
  }
  if (!(MEMORY_TYPES as readonly string[]).includes(input.type)) {
    throw new Error(`非法 type：${input.type}`)
  }

  const title = sanitizeSingleLine(input.title)
  const content = input.content.trim()
  if (!title) throw new Error('标题 title 不能为空')
  if (!content) throw new Error('正文 content 不能为空')

  const projectRoot = input.projectRoot ?? resolveProjectRoot()
  const scopeDir = await ensureScopeDirs(input.scope, projectRoot)

  const now = new Date()
  const createdAt = now.toISOString()
  // 时间戳 + 4 位随机 hex，防止同一毫秒内模型连续调两次 memory_note 撞文件名
  const suffix = randomBytes(2).toString('hex')
  const file = `${formatFileTimestamp(now)}-${suffix}-${slugifyName(title, MAX_SLUG_CHARS, 'note')}.md`
  const fullPath = path.join(scopeDir, 'inbox', file)

  const markdown = [
    '---',
    `scope: ${input.scope}`,
    `type: ${input.type}`,
    `title: ${title}`,
    `created_at: ${createdAt}`,
    '---',
    '',
    content,
    '',
  ].join('\n')

  await atomicWriteFile(fullPath, markdown)

  return {
    scope: input.scope,
    bucket: 'inbox',
    file,
    path: fullPath,
    type: input.type,
    title,
    timestamp: createdAt,
  }
}

/**
 * 整理器写入入口：原子创建或更新一条正式长期记忆（entries/<file>）。
 * update 场景会保留原文件的 created_at，只推进 updated_at。
 */
export async function writeMemoryEntry(input: WriteMemoryEntryInput): Promise<MemoryRecordSummary> {
  if (!(MEMORY_SCOPES as readonly string[]).includes(input.scope)) {
    throw new Error(`非法 scope：${input.scope}`)
  }
  if (!(MEMORY_TYPES as readonly string[]).includes(input.type)) {
    throw new Error(`非法 type：${input.type}`)
  }

  const safeFile = assertSafeFileName(input.file)
  const title = sanitizeSingleLine(input.title)
  const description = sanitizeSingleLine(input.description)
  const content = input.content.trim()
  if (!title) throw new Error('正式记忆 title 不能为空')
  if (!content) throw new Error('正式记忆 content 不能为空')

  const projectRoot = input.projectRoot ?? resolveProjectRoot()
  const scopeDir = await ensureScopeDirs(input.scope, projectRoot)
  const fullPath = path.join(scopeDir, 'entries', safeFile)

  const nowIso = new Date().toISOString()
  const createdAt = input.createdAt?.trim() || nowIso

  const lines = [
    '---',
    `scope: ${input.scope}`,
    `type: ${input.type}`,
    `title: ${title}`,
    ...(description ? [`description: ${description}`] : []),
    `created_at: ${createdAt}`,
    `updated_at: ${nowIso}`,
    '---',
    '',
    content,
    '',
  ]

  await atomicWriteFile(fullPath, lines.join('\n'))

  return {
    scope: input.scope,
    bucket: 'entries',
    file: safeFile,
    path: fullPath,
    type: input.type,
    title,
    description: description || undefined,
    timestamp: nowIso,
  }
}

/** 整理器删除入口：安全删除 entries/ 下指定的过时或已被合并的正式记忆 */
export async function deleteMemoryEntry(params: {
  scope: MemoryScope
  file: string
  projectRoot?: string
}): Promise<boolean> {
  const safeFile = assertSafeFileName(params.file)
  const projectRoot = params.projectRoot ?? resolveProjectRoot()
  const fullPath = path.join(getScopeMemoryDir(params.scope, projectRoot), 'entries', safeFile)
  try {
    await pfs.unlink(fullPath)
    return true
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false
    throw error
  }
}

/**
 * 归档本次整理已消费的 inbox 文件（inbox/<file> → archive/<file>）。
 * 关键点：只移动本次快照里的明确文件列表，绝不清空整个 inbox/ 目录，
 * 避免整理期间前台并发写入的新 note 被误删；同时保留原文供人工审计回溯。
 */
export async function archiveInboxFiles(
  scope: MemoryScope,
  files: string[],
  projectRoot: string = resolveProjectRoot(),
): Promise<string[]> {
  if (files.length === 0) return []
  const scopeDir = await ensureScopeDirs(scope, projectRoot)
  const archived: string[] = []

  for (const file of files) {
    const safeFile = assertSafeFileName(file)
    const src = path.join(scopeDir, 'inbox', safeFile)
    const dst = path.join(scopeDir, 'archive', safeFile)
    try {
      await pfs.rename(src, dst)
      archived.push(safeFile)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
    }
  }

  return archived
}

/** 列出当前生效的 global + project 全部记忆摘要（按 entries / inbox 分组） */
export async function listMemories(projectRoot: string = resolveProjectRoot()): Promise<MemoryListing> {
  const globalDir = getScopeMemoryDir('global', projectRoot)
  const projectDir = getScopeMemoryDir('project', projectRoot)

  const [
    globalEntries,
    globalInbox,
    globalArchivedCount,
    projectEntries,
    projectInbox,
    projectArchivedCount,
  ] = await Promise.all([
    listBucketRecords('global', 'entries', projectRoot),
    listBucketRecords('global', 'inbox', projectRoot),
    countArchivedNotes('global', projectRoot),
    listBucketRecords('project', 'entries', projectRoot),
    listBucketRecords('project', 'inbox', projectRoot),
    countArchivedNotes('project', projectRoot),
  ])

  return {
    projectRoot,
    globalDir,
    projectDir,
    global: {
      entries: globalEntries.map(toSummary),
      inbox: globalInbox.map(toSummary),
      archivedCount: globalArchivedCount,
    },
    project: {
      entries: projectEntries.map(toSummary),
      inbox: projectInbox.map(toSummary),
      archivedCount: projectArchivedCount,
    },
  }
}

/** 读取单条记忆的完整 Markdown 内容；文件不存在时返回 null */
export async function readMemory(params: {
  scope: MemoryScope
  bucket: MemoryBucket
  file: string
  projectRoot?: string
}): Promise<MemoryRecord | null> {
  const safeFile = assertSafeFileName(params.file)
  const projectRoot = params.projectRoot ?? resolveProjectRoot()
  const scopeDir = getScopeMemoryDir(params.scope, projectRoot)
  const fullPath = path.join(scopeDir, params.bucket, safeFile)

  const raw = await pfs.readFile(fullPath, 'utf8').catch((error: NodeJS.ErrnoException) => {
    if (error.code === 'ENOENT') return null
    throw error
  })
  if (raw === null) return null

  const { meta, body } = parseFrontmatter(raw)
  return {
    scope: params.scope,
    bucket: params.bucket,
    file: safeFile,
    path: fullPath,
    type: normalizeMemoryType(meta.type, params.scope),
    title: meta.title || safeFile.replace(/\.md$/, ''),
    description: meta.description || undefined,
    timestamp: meta.updated_at || meta.created_at || '',
    createdAt: meta.created_at || undefined,
    content: body,
    raw,
  }
}

/**
 * 生成注入系统提示（instructions）的极简记忆索引：
 * 只列出元信息（scope / bucket / type / title / file），不塞入正文，
 * 与 Skills 的渐进式披露一致；同时把尚未整理的 inbox 标上 [待整理] 纳入索引，
 * 让新会话在整理器运行前也能做到“读己之写”。
 */
export async function formatMemoryIndexForPrompt(
  projectRoot: string = resolveProjectRoot(),
): Promise<string> {
  const listing = await listMemories(projectRoot)
  const formatLine = (item: MemoryRecordSummary) => {
    const tag = item.bucket === 'inbox' ? '[待整理] ' : ''
    const desc = item.description ? ` — ${item.description}` : ''
    return `- ${tag}[${item.type}] ${item.title}${desc} (scope=${item.scope}, bucket=${item.bucket}, file=${item.file})`
  }

  const sections: string[] = []
  const globalItems = [...listing.global.entries, ...listing.global.inbox]
  if (globalItems.length > 0) {
    sections.push('### 全局记忆 (global)', ...globalItems.map(formatLine))
  }

  const projectItems = [...listing.project.entries, ...listing.project.inbox]
  if (projectItems.length > 0) {
    sections.push('### 当前项目记忆 (project)', ...projectItems.map(formatLine))
  }

  return sections.join('\n')
}
