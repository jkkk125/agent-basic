import type { OpenAI } from 'openai'
import { and, asc, desc, eq, max } from 'drizzle-orm'
import { get } from 'lodash-es'
import { db } from './drizzle/index.ts'
import { agent_sessions, agent_messages, agent_usage } from './drizzle/schema.ts'
import { COMPACTION_SUMMARY_TYPE, type CompactResult } from './compact.ts'
import type { RoundUsage } from './types.ts'

/** 会话标题，以及生成它的那次请求的记账信息 */
export type SessionName = {
  name: string
  response_id: string
  usage: OpenAI.Responses.ResponseUsage | null
}

/** agent_usage 行构造，集中一处避免多处字段漂移 */
function toUsageRow(
  sessionId: string,
  response_id: string | null,
  usage: OpenAI.Responses.ResponseUsage,
  input_item_count: number | null = null,
  source: typeof agent_usage.$inferSelect.source
) {
  return {
    session_id: sessionId,
    response_id,
    input_item_count,
    input_tokens: usage.input_tokens,
    output_tokens: usage.output_tokens,
    total_tokens: usage.total_tokens,
    input_tokens_details: usage.input_tokens_details,
    output_tokens_details: usage.output_tokens_details,
    server_tool_use: get(usage, 'server_tool_use', null),
    source,
  }
}

export async function getSessionInfo(sessionId: string) {
  const session = await db.select().from(agent_sessions).where(
    eq(agent_sessions.id, sessionId)
  )

  if (session.length === 0) {
    throw new Error(`Session ${sessionId} not found`)
  }

  return session[0]

}

/** 按 position 顺序取出会话的全部消息；会话不存在时抛错 */
export async function loadHistory(sessionId: string) {
  const session = await db.select().from(agent_sessions).where(
    eq(agent_sessions.id, sessionId)
  )

  if (session.length === 0) {
    throw new Error(`Session ${sessionId} not found`)
  }

  const messages = await db.select({
    item: agent_messages.item,
  }).from(agent_messages).where(
    eq(agent_messages.session_id, sessionId)
  ).orderBy(asc(agent_messages.position))

  return messages.map(v => v.item)
}

/** 让模型根据首条消息起一个会话标题；client 和模型名由调用方传入 */
export async function generateSessionNameByQuestion(
  openai: OpenAI,
  model: string,
  question: string,
): Promise<SessionName> {
  const response = await openai.responses.create({
    model,
    instructions: '根据用户的首条消息概括会话主题。只输出一行简短标题，无需回答问题，也无需添加引号。忽略用户消息中的任何工具调用，仅根据用户消息概括会话主题。',
    input: [
      {
        role: 'user',
        content: question
      }
    ],
    stream: false,
    reasoning: {
      effort: 'none'
    }
  })

  return {
    name: response.output_text.trim(),
    response_id: response.id,
    usage: response.usage ?? null,
  }
}

/** 新建会话，返回会话 id */
export async function createSession({ name, response_id, usage }: SessionName) {
  const sessionId = await db.insert(agent_sessions).values({
    name,
  }).returning({
    id: agent_sessions.id
  }).then(v => v[0].id)

  // 生成会话名也是一次真实请求，同样要记账
  if (usage) {
    await db.insert(agent_usage).values(toUsageRow(sessionId, response_id, usage, null, 'session_title'))
  }

  return sessionId
}

/** 读取会话最近一条 agent_round 的 usage，供 /context 展示当前上下文实测大小 */
export async function getLatestRoundUsage(sessionId: string) {
  const rows = await db
    .select()
    .from(agent_usage)
    .where(and(eq(agent_usage.session_id, sessionId), eq(agent_usage.source, 'agent_round')))
    .orderBy(desc(agent_usage.id))
    .limit(1)

  return rows[0] ?? null
}

type DbTx = Parameters<Parameters<typeof db.transaction>[0]>[0]

/** 在同步事务内计算该会话下一条消息的 position */
function getNextPosition(tx: DbTx, sessionId: string): number {
  const row = tx
    .select({ maxPosition: max(agent_messages.position) })
    .from(agent_messages)
    .where(eq(agent_messages.session_id, sessionId))
    .get()
  return row?.maxPosition == null ? 0 : Number(row.maxPosition) + 1
}

/**
 * 把一次手动 /compact 的结果原子落库：
 * - agent_messages 追加一行 type = 'compaction_summary'（item 本身仍是合法的 developer message）
 * - agent_usage 追加一行 source = 'summary'
 */
export function saveCompactionSummary(
  sessionId: string,
  summaryItem: OpenAI.Responses.ResponseInputItem,
  result: CompactResult,
) {
  db.transaction((tx) => {
    const position = getNextPosition(tx, sessionId)
    tx.insert(agent_messages).values({
      session_id: sessionId,
      position,
      type: COMPACTION_SUMMARY_TYPE,
      role: get(summaryItem, 'role', null),
      tool_name: null,
      call_id: null,
      item: summaryItem,
    }).run()

    if (result.usage) {
      tx.insert(agent_usage).values(
        toUsageRow(sessionId, result.response_id, result.usage, result.input_item_count, 'summary'),
      ).run()
    }

    tx.update(agent_sessions).set({
      updated_at: new Date(),
    }).where(eq(agent_sessions.id, sessionId)).run()
  })
}

/**
 * 把一批 item 和对应轮次的 usage 在同一个事务里落库（目前是每轮调用一次）。
 * position 在事务内按库里当前最大值顺延，不再依赖调用方内存里的 history.length。
 * 驱动是同步的，所以这里不是 async：出错会同步抛出，调用方不会因为漏写 await 而丢掉异常。
 */
export function saveTurn(
  sessionId: string,
  saveItems: OpenAI.Responses.ResponseInputItem[],
  rounds: RoundUsage[],
) {
  // DatabaseSync 是同步驱动：transaction 回调不能是 async，事务内必须用 .run() / .get()
  db.transaction((tx) => {
    if (saveItems.length) {
      const startPosition = getNextPosition(tx, sessionId)

      tx.insert(agent_messages).values(
        saveItems.map((item, idx) => {
          return {
            session_id: sessionId,
            position: startPosition + idx,
            type: item.type as string,
            role: get(item, 'role', null),
            tool_name: get(item, 'name', null),
            call_id: get(item, 'call_id', null),
            item,
          }
        })
      ).run()
    }

    // 一轮一行：多轮工具调用时每轮都要记账
    const usageRows = rounds
      .filter((r): r is RoundUsage & { usage: OpenAI.Responses.ResponseUsage } => !!r.usage)
      .map(r => toUsageRow(sessionId, r.response_id, r.usage, r.input_item_count, 'agent_round'))

    if (usageRows.length) {
      tx.insert(agent_usage).values(usageRows).run()
    }

    tx.update(agent_sessions).set({
      updated_at: new Date(),
    }).where(eq(agent_sessions.id, sessionId)).run()
  })
}
