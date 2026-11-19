import type { OpenAI } from 'openai'
import { asc, eq } from 'drizzle-orm'
import { get } from 'lodash-es'
import { db } from './drizzle/index.ts'
import { agent_sessions, agent_messages, agent_usage } from './drizzle/schema.ts'
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

/** 把一次提问产生的全部 item 和每轮 usage 在同一个事务里落库 */
export async function saveTurn(
  sessionId: string, 
  startPosition: number, 
  saveItems: OpenAI.Responses.ResponseInputItem[],
  rounds: RoundUsage[],
) {
  // DatabaseSync 是同步驱动：transaction 回调不能是 async，事务内必须用 .run()
  db.transaction((tx) => {
    if (saveItems.length) {
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
