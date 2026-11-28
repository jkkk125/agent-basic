/** 记忆作用域：global 跨所有项目生效，project 按 .git 项目根目录隔离 */
export const MEMORY_SCOPES = ['global', 'project'] as const
export type MemoryScope = (typeof MEMORY_SCOPES)[number]

/**
 * 记忆分类（按用途与生命周期划分）：
 * - user：用户画像、沟通风格与长期工具偏好（通常放 global）
 * - feedback：用户对 agent 的纠偏、行为红线与原因（高价值）
 * - project：代码里看不出的项目背景、架构取舍与踩坑（仅 project）
 * - reference：外部文档、服务地址或数据入口指针
 */
export const MEMORY_TYPES = ['user', 'feedback', 'project', 'reference'] as const
export type MemoryType = (typeof MEMORY_TYPES)[number]

/**
 * 写分离的两个桶：
 * - inbox：在线阶段追加的待整理碎片（只增不改，避免与后台整理抢写同一文件）
 * - entries：经整理器去重、合并后的正式长期记忆
 */
export const MEMORY_BUCKETS = ['entries', 'inbox'] as const
export type MemoryBucket = (typeof MEMORY_BUCKETS)[number]

/** 用于系统提示索引和 /memory 列表展示的摘要信息（不含正文） */
export type MemoryRecordSummary = {
  scope: MemoryScope
  bucket: MemoryBucket
  /** 纯文件名（不含目录），作为 memory_read 的定位键 */
  file: string
  /** 磁盘绝对路径，方便人工直接打开或编辑 */
  path: string
  type: MemoryType
  title: string
  description?: string
  /** 取自 frontmatter 的 updated_at 或 created_at */
  timestamp: string
}

/** 单条记忆的完整内容 */
export type MemoryRecord = MemoryRecordSummary & {
  /** 去掉 frontmatter 后的 Markdown 正文 */
  content: string
  /** 磁盘上的原始 Markdown 全文 */
  raw: string
}

/** 在线向 inbox 追加碎片笔记时的入参 */
export type AppendInboxNoteInput = {
  scope: MemoryScope
  type: MemoryType
  title: string
  content: string
  /** 可选，默认使用 resolveProjectRoot() 自动向上查找 .git 根目录 */
  projectRoot?: string
}

/** 按作用域与桶分组的记忆总览 */
export type MemoryListing = {
  projectRoot: string
  globalDir: string
  projectDir: string
  global: {
    entries: MemoryRecordSummary[]
    inbox: MemoryRecordSummary[]
  }
  project: {
    entries: MemoryRecordSummary[]
    inbox: MemoryRecordSummary[]
  }
}
