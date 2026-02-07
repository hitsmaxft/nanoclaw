import Database from 'better-sqlite3';
import fs from 'fs';
import path from 'path';
import readline from 'readline';
import TelegramBot from 'node-telegram-bot-api';
import { NewMessage, ScheduledTask, TaskRunLog } from './types.js';
import { STORE_DIR } from './config.js';

let db: Database.Database;

export function initDatabase(): void {
  const dbPath = path.join(STORE_DIR, 'messages.db');
  fs.mkdirSync(path.dirname(dbPath), { recursive: true });

  db = new Database(dbPath);
  db.exec(`
    CREATE TABLE IF NOT EXISTS chats (
      jid TEXT PRIMARY KEY,
      name TEXT,
      last_message_time TEXT
    );
    CREATE TABLE IF NOT EXISTS messages (
      id TEXT,
      chat_jid TEXT,
      sender TEXT,
      sender_name TEXT,
      content TEXT,
      timestamp TEXT,
      is_from_me INTEGER,
      PRIMARY KEY (id, chat_jid),
      FOREIGN KEY (chat_jid) REFERENCES chats(jid)
    );
    CREATE INDEX IF NOT EXISTS idx_timestamp ON messages(timestamp);

    CREATE TABLE IF NOT EXISTS scheduled_tasks (
      id TEXT PRIMARY KEY,
      group_folder TEXT NOT NULL,
      chat_jid TEXT NOT NULL,
      prompt TEXT NOT NULL,
      schedule_type TEXT NOT NULL,
      schedule_value TEXT NOT NULL,
      next_run TEXT,
      last_run TEXT,
      last_result TEXT,
      status TEXT DEFAULT 'active',
      created_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_next_run ON scheduled_tasks(next_run);
    CREATE INDEX IF NOT EXISTS idx_status ON scheduled_tasks(status);

    CREATE TABLE IF NOT EXISTS task_run_logs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      task_id TEXT NOT NULL,
      run_at TEXT NOT NULL,
      duration_ms INTEGER NOT NULL,
      status TEXT NOT NULL,
      result TEXT,
      error TEXT,
      FOREIGN KEY (task_id) REFERENCES scheduled_tasks(id)
    );
    CREATE INDEX IF NOT EXISTS idx_task_run_logs ON task_run_logs(task_id, run_at);
  `);

  // Add sender_name column if it doesn't exist (migration for existing DBs)
  try {
    db.exec(`ALTER TABLE messages ADD COLUMN sender_name TEXT`);
  } catch { /* column already exists */ }

  // Add context_mode column if it doesn't exist (migration for existing DBs)
  try {
    db.exec(`ALTER TABLE scheduled_tasks ADD COLUMN context_mode TEXT DEFAULT 'isolated'`);
  } catch { /* column already exists */ }
}

/**
 * Store chat metadata only (no message content).
 * Used for all chats to enable group discovery without storing sensitive content.
 */
export function storeChatMetadata(chatJid: string, timestamp: string, name?: string): void {
  if (name) {
    // Update with name, preserving existing timestamp if newer
    db.prepare(`
      INSERT INTO chats (jid, name, last_message_time) VALUES (?, ?, ?)
      ON CONFLICT(jid) DO UPDATE SET
        name = excluded.name,
        last_message_time = MAX(last_message_time, excluded.last_message_time)
    `).run(chatJid, name, timestamp);
  } else {
    // Update timestamp only, preserve existing name if any
    db.prepare(`
      INSERT INTO chats (jid, name, last_message_time) VALUES (?, ?, ?)
      ON CONFLICT(jid) DO UPDATE SET
        last_message_time = MAX(last_message_time, excluded.last_message_time)
    `).run(chatJid, chatJid, timestamp);
  }
}

/**
 * Update chat name without changing timestamp for existing chats.
 * New chats get current time as their initial timestamp.
 * Used during group metadata sync.
 */
export function updateChatName(chatJid: string, name: string): void {
  db.prepare(`
    INSERT INTO chats (jid, name, last_message_time) VALUES (?, ?, ?)
    ON CONFLICT(jid) DO UPDATE SET name = excluded.name
  `).run(chatJid, name, new Date().toISOString());
}

export interface ChatInfo {
  jid: string;
  name: string;
  last_message_time: string;
}

export interface StoredMessage {
  id: string;
  chat_jid: string;
  sender: string;
  sender_name: string;
  content: string;
  timestamp: string;
  is_from_me: boolean;
}

export type { NewMessage, ScheduledTask, TaskRunLog };

/**
 * Get all known chats, ordered by most recent activity.
 */
export function getAllChats(): ChatInfo[] {
  return db.prepare(`
    SELECT jid, name, last_message_time
    FROM chats
    ORDER BY last_message_time DESC
  `).all() as ChatInfo[];
}

/**
 * Get specific chat information.
 */
export function getChat(chatJid: string): ChatInfo | null {
  const row = db.prepare(`SELECT jid, name, last_message_time FROM chats WHERE jid = ?`).get(chatJid) as { jid: string; name: string; last_message_time: string } | undefined;
  return row ? { jid: row.jid, name: row.name, last_message_time: row.last_message_time } : null;
}

/**
 * Get timestamp of last group metadata sync.
 */
export function getLastGroupSync(): string | null {
  // Store sync time in a special chat entry
  const row = db.prepare(`SELECT last_message_time FROM chats WHERE jid = '__group_sync__'`).get() as { last_message_time: string } | undefined;
  return row?.last_message_time || null;
}

/**
 * Record that group metadata was synced.
 */
export function setLastGroupSync(): void {
  const now = new Date().toISOString();
  db.prepare(`INSERT OR REPLACE INTO chats (jid, name, last_message_time) VALUES ('__group_sync__', '__group_sync__', ?)`).run(now);
}

/**
 * Store a message with full content.
 * Only call this for registered groups where message history is needed.
 * Generic version that works with any messenger platform.
 */
export function storeMessage(msg: StoredMessage, chatJid: string, isFromMe: boolean): void {
  db.prepare(`INSERT OR REPLACE INTO messages (id, chat_jid, sender, sender_name, content, timestamp, is_from_me) VALUES (?, ?, ?, ?, ?, ?, ?)`)
    .run(msg.id, chatJid, msg.sender, msg.sender_name, msg.content, msg.timestamp, isFromMe ? 1 : 0);
}

/**
 * Telegram-specific message storage function (for backward compatibility)
 */
export function storeTelegramMessage(msg: TelegramBot.Message, chatJid: string, isFromMe: boolean): void {
  if (!msg.from) return;

  const content = msg.text || '';
  const timestamp = new Date(msg.date * 1000).toISOString();
  const sender = msg.from.id.toString();
  const senderName = `${msg.from.first_name || ''} ${msg.from.last_name || ''}`.trim() || msg.from.username || sender;
  const msgId = msg.message_id.toString();

  storeMessage({
    id: msgId,
    chat_jid: chatJid,
    sender,
    sender_name: senderName,
    content,
    timestamp,
    is_from_me: isFromMe,
  }, chatJid, isFromMe);
}

export function getNewMessages(jids: string[], lastTimestamp: string, botPrefix: string): { messages: NewMessage[]; newTimestamp: string } {
  if (jids.length === 0) return { messages: [], newTimestamp: lastTimestamp };

  const placeholders = jids.map(() => '?').join(',');
  // Filter out bot's own messages by checking content prefix (not is_from_me, since user shares an account)
  const sql = `
    SELECT id, chat_jid, sender, sender_name, content, timestamp
    FROM messages
    WHERE timestamp > ? AND chat_jid IN (${placeholders}) AND content NOT LIKE ?
    ORDER BY timestamp
  `;

  const rows = db.prepare(sql).all(lastTimestamp, ...jids, `${botPrefix}:%`) as NewMessage[];

  let newTimestamp = lastTimestamp;
  for (const row of rows) {
    if (row.timestamp > newTimestamp) newTimestamp = row.timestamp;
  }

  return { messages: rows, newTimestamp };
}

export function getMessagesSince(chatJid: string, sinceTimestamp: string, botPrefix: string): NewMessage[] {
  // Filter out bot's own messages by checking content prefix
  const sql = `
    SELECT id, chat_jid, sender, sender_name, content, timestamp
    FROM messages
    WHERE chat_jid = ? AND timestamp > ? AND content NOT LIKE ?
    ORDER BY timestamp
  `;
  return db.prepare(sql).all(chatJid, sinceTimestamp, `${botPrefix}:%`) as NewMessage[];
}

export function createTask(task: Omit<ScheduledTask, 'last_run' | 'last_result'>): void {
  db.prepare(`
    INSERT INTO scheduled_tasks (id, group_folder, chat_jid, prompt, schedule_type, schedule_value, context_mode, next_run, status, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    task.id,
    task.group_folder,
    task.chat_jid,
    task.prompt,
    task.schedule_type,
    task.schedule_value,
    task.context_mode || 'isolated',
    task.next_run,
    task.status,
    task.created_at
  );
}

export function getTaskById(id: string): ScheduledTask | undefined {
  return db.prepare('SELECT * FROM scheduled_tasks WHERE id = ?').get(id) as ScheduledTask | undefined;
}

export function getTasksForGroup(groupFolder: string): ScheduledTask[] {
  return db.prepare('SELECT * FROM scheduled_tasks WHERE group_folder = ? ORDER BY created_at DESC').all(groupFolder) as ScheduledTask[];
}

export function getAllTasks(): ScheduledTask[] {
  return db.prepare('SELECT * FROM scheduled_tasks ORDER BY created_at DESC').all() as ScheduledTask[];
}

export function updateTask(id: string, updates: Partial<Pick<ScheduledTask, 'prompt' | 'schedule_type' | 'schedule_value' | 'next_run' | 'status'>>): void {
  const fields: string[] = [];
  const values: unknown[] = [];

  if (updates.prompt !== undefined) { fields.push('prompt = ?'); values.push(updates.prompt); }
  if (updates.schedule_type !== undefined) { fields.push('schedule_type = ?'); values.push(updates.schedule_type); }
  if (updates.schedule_value !== undefined) { fields.push('schedule_value = ?'); values.push(updates.schedule_value); }
  if (updates.next_run !== undefined) { fields.push('next_run = ?'); values.push(updates.next_run); }
  if (updates.status !== undefined) { fields.push('status = ?'); values.push(updates.status); }

  if (fields.length === 0) return;

  values.push(id);
  db.prepare(`UPDATE scheduled_tasks SET ${fields.join(', ')} WHERE id = ?`).run(...values);
}

export function deleteTask(id: string): void {
  // Delete child records first (FK constraint)
  db.prepare('DELETE FROM task_run_logs WHERE task_id = ?').run(id);
  db.prepare('DELETE FROM scheduled_tasks WHERE id = ?').run(id);
}

export function getDueTasks(): ScheduledTask[] {
  const now = new Date().toISOString();
  return db.prepare(`
    SELECT * FROM scheduled_tasks
    WHERE status = 'active' AND next_run IS NOT NULL AND next_run <= ?
    ORDER BY next_run
  `).all(now) as ScheduledTask[];
}

export function updateTaskAfterRun(id: string, nextRun: string | null, lastResult: string): void {
  const now = new Date().toISOString();
  db.prepare(`
    UPDATE scheduled_tasks
    SET next_run = ?, last_run = ?, last_result = ?, status = CASE WHEN ? IS NULL THEN 'completed' ELSE status END
    WHERE id = ?
  `).run(nextRun, now, lastResult, nextRun, id);
}

export function logTaskRun(log: TaskRunLog): void {
  db.prepare(`
    INSERT INTO task_run_logs (task_id, run_at, duration_ms, status, result, error)
    VALUES (?, ?, ?, ?, ?, ?)
  `).run(log.task_id, log.run_at, log.duration_ms, log.status, log.result, log.error);
}

export function getTaskRunLogs(taskId: string, limit = 10): TaskRunLog[] {
  return db.prepare(`
    SELECT task_id, run_at, duration_ms, status, result, error
    FROM task_run_logs
    WHERE task_id = ?
    ORDER BY run_at DESC
    LIMIT ?
  `).all(taskId, limit) as TaskRunLog[];
}

// ==================== Feishu Message Types ====================

/**
 * Feishu message types supported by the bot
 */
export type FeishuMessageType =
  | 'text'
  | 'post'
  | 'image'
  | 'file'
  | 'audio'
  | 'video'
  | 'sticker'
  | 'system'
  | 'share_chat'
  | 'share_user'
  | string;

/**
 * Feishu message sender information
 */
export interface FeishuSender {
  sender_id: {
    open_id?: string;
    user_id?: string;
    union_id?: string;
  };
  sender_type?: 'user' | 'app' | string;
  tenant_key?: string;
}

/**
 * Feishu mention in message
 */
export interface FeishuMention {
  key: string;
  id: {
    open_id?: string;
    user_id?: string;
    union_id?: string;
  };
  name: string;
  tenant_key?: string;
}

/**
 * Feishu message structure (subset used for storage)
 */
export interface FeishuMessage {
  message_id: string;
  root_id?: string;
  parent_id?: string;
  chat_id: string;
  chat_type: 'p2p' | 'group';
  message_type: FeishuMessageType;
  content: string;
  create_time?: string;  // Milliseconds timestamp as string
  update_time?: string;
  deleted?: boolean;
  mentions?: FeishuMention[];
  upper_message_id?: string;
}

/**
 * Parse Feishu message content based on message type
 * Extracts text representation for database storage
 */
function parseFeishuContent(message: FeishuMessage): { text: string; mediaInfo?: string } {
  const { content, message_type } = message;

  try {
    const parsed = JSON.parse(content);

    switch (message_type) {
      case 'text':
        return { text: parsed.text || '' };

      case 'post': {
        // Rich text post message
        const title = parsed.zh_cn?.title || parsed.en_us?.title || parsed.title || '';
        const contentBlocks = parsed.zh_cn?.content || parsed.en_us?.content || parsed.content || [];
        let text = title ? `${title}\n\n` : '';

        for (const paragraph of contentBlocks) {
          if (Array.isArray(paragraph)) {
            for (const element of paragraph) {
              switch (element.tag) {
                case 'text':
                  text += element.text || '';
                  break;
                case 'a':
                  text += element.text || element.href || '';
                  break;
                case 'at':
                  text += `@${element.user_name || element.user_id || 'user'}`;
                  break;
                case 'img':
                  text += '<media:image>';
                  break;
                case 'media':
                  text += `<media:${element.file_name || 'file'}>`;
                  break;
                case 'emotion':
                  text += `[${element.emoji_type || 'emoji'}]`;
                  break;
              }
            }
            text += '\n';
          }
        }
        return { text: text.trim() || '[Rich Text Message]' };
      }

      case 'image':
        return {
          text: '<media:image>',
          mediaInfo: `image_key:${parsed.image_key}`
        };

      case 'file':
        return {
          text: '<media:document>',
          mediaInfo: `file_key:${parsed.file_key}|name:${parsed.file_name || 'unknown'}`
        };

      case 'audio':
        return {
          text: '<media:audio>',
          mediaInfo: `file_key:${parsed.file_key}|duration:${parsed.duration || 0}`
        };

      case 'video':
        return {
          text: '<media:video>',
          mediaInfo: `file_key:${parsed.file_key}|image_key:${parsed.image_key || ''}`
        };

      case 'sticker':
        return {
          text: '<media:sticker>',
          mediaInfo: `file_key:${parsed.file_key}`
        };

      case 'media':
        return {
          text: '<media:file>',
          mediaInfo: `file_key:${parsed.file_key}|name:${parsed.file_name || 'unknown'}`
        };

      case 'share_chat':
        return {
          text: '<share:chat>',
          mediaInfo: `chat_id:${parsed.share_chat_id}`
        };

      case 'share_user':
        return {
          text: '<share:user>',
          mediaInfo: `user_id:${parsed.share_user_id}`
        };

      case 'system':
        return { text: `[System: ${parsed.type || 'event'}]` };

      case 'location':
        return {
          text: '<location>',
          mediaInfo: `name:${parsed.name || ''}|address:${parsed.address || ''}`
        };

      default:
        return { text: `[${message_type}]` };
    }
  } catch {
    // If parsing fails, return raw content
    return { text: content };
  }
}

/**
 * Extract sender name from Feishu sender info
 * Falls back to open_id if name lookup failed
 */
function extractFeishuSenderName(sender: FeishuSender, fallbackName?: string): string {
  if (fallbackName && fallbackName !== sender.sender_id.open_id) {
    return fallbackName;
  }
  // Return the most specific ID we have
  return sender.sender_id.user_id ||
         sender.sender_id.union_id ||
         sender.sender_id.open_id ||
         'Unknown';
}

/**
 * Store a Feishu message to the database
 * Handles all Feishu message types (text, post, image, file, audio, video, sticker, etc.)
 *
 * @param message The Feishu message object
 * @param sender The Feishu sender info
 * @param chatJid The chat JID (same as message.chat_id)
 * @param isFromMe Whether the message is from the bot itself
 * @param resolvedName Optional resolved display name for the sender
 */
export function storeFeishuMessage(
  message: FeishuMessage,
  sender: FeishuSender,
  chatJid: string,
  isFromMe: boolean,
  resolvedName?: string
): void {
  // Parse content based on message type
  const { text, mediaInfo } = parseFeishuContent(message);

  // Build full content with media info
  const fullContent = mediaInfo ? `${text} [${mediaInfo}]` : text;

  // Parse timestamp (Feishu uses milliseconds)
  const timestamp = message.create_time
    ? new Date(parseInt(message.create_time, 10)).toISOString()
    : new Date().toISOString();

  // Extract sender ID (prefer user_id, fallback to open_id)
  const senderId = sender.sender_id.user_id ||
                   sender.sender_id.union_id ||
                   sender.sender_id.open_id ||
                   'unknown';

  // Extract sender name
  const senderName = extractFeishuSenderName(sender, resolvedName);

  // Store the message
  storeMessage({
    id: message.message_id,
    chat_jid: chatJid,
    sender: senderId,
    sender_name: senderName,
    content: fullContent,
    timestamp,
    is_from_me: isFromMe,
  }, chatJid, isFromMe);
}

/**
 * Feishu-specific message storage with full context
 * Use this when you have a complete Feishu message event
 */
export function storeFeishuMessageEvent(
  event: {
    message: FeishuMessage;
    sender: FeishuSender;
  },
  chatJid: string,
  isFromMe: boolean,
  resolvedName?: string
): void {
  storeFeishuMessage(event.message, event.sender, chatJid, isFromMe, resolvedName);
}
