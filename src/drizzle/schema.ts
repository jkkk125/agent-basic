import { randomUUID } from 'node:crypto';
import { integer, sqliteTable, text, unique } from 'drizzle-orm/sqlite-core';
import type { OpenAI } from 'openai';

const uuid = () => randomUUID();
const now = () => new Date();

export const agent_sessions = sqliteTable('agent_sessions', {
  id: text('id').$defaultFn(uuid).primaryKey(),
  name: text('name'),
  created_at: integer('created_at', { mode: 'timestamp_ms' }).$defaultFn(now).notNull(),
  updated_at: integer('updated_at', { mode: 'timestamp_ms' }).$defaultFn(now).notNull(),
});

export const agent_messages = sqliteTable('agent_messages', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  session_id: text('session_id').notNull().references(() => agent_sessions.id),
  response_id: text('response_id'),
  position: integer('position').notNull(),
  type: text('type').notNull(),
  role: text('role'),
  tool_name: text('tool_name'),
  call_id: text('call_id'),
  item: text('item', { mode: 'json' }).$type<OpenAI.Responses.ResponseInput[number]>().notNull(),
  created_at: integer('created_at', { mode: 'timestamp_ms' }).$defaultFn(now).notNull(),
}, (table) => [unique().on(table.session_id, table.position)]);

export const agent_usage = sqliteTable('agent_usage', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  session_id: text('session_id').notNull().references(() => agent_sessions.id),
  response_id: text('response_id'),
  input_tokens: integer('input_tokens').notNull(),
  output_tokens: integer('output_tokens').notNull(),
  total_tokens: integer('total_tokens').notNull(),
  input_tokens_details: text('input_tokens_details', { mode: 'json' }).$type<OpenAI.Responses.ResponseUsage.InputTokensDetails>().notNull(),
  output_tokens_details: text('output_tokens_details', { mode: 'json' }).$type<OpenAI.Responses.ResponseUsage.OutputTokensDetails>().notNull(),
  created_at: integer('created_at', { mode: 'timestamp_ms' }).$defaultFn(now).notNull(),
})
