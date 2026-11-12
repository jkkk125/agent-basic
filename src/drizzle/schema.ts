import { integer, jsonb, pgTable, serial, text, timestamp, unique, uuid } from 'drizzle-orm/pg-core';
import type { OpenAI } from 'openai';

export const agent_sessions = pgTable('agent_sessions', {
  id: uuid('id').defaultRandom().primaryKey(),
  name: text('name'),
  created_at: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
  updated_at: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
});

export const agent_messages = pgTable('agent_messages', {
  id: serial('id').primaryKey(),
  session_id: uuid('session_id').notNull().references(() => agent_sessions.id),
  position: integer('position').notNull(),
  type: text('type').notNull(),
  role: text('role'),
  tool_name: text('tool_name'),
  call_id: text('call_id'),
  item: jsonb('item').$type<OpenAI.Responses.ResponseInput[number]>().notNull(),
  created_at: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
}, (table) => [unique().on(table.session_id, table.position)]);
