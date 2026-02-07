import pino from 'pino';
import { execSync } from 'child_process';
import fs from 'fs';
import path from 'path';

import {
  ASSISTANT_NAME,
  STORE_DIR,
  DATA_DIR,
  TRIGGER_PATTERN,
  escapeRegex,
  MAIN_GROUP_FOLDER,
  IPC_POLL_INTERVAL,
  TIMEZONE,
  POLL_INTERVAL,
} from './config.js';
import { RegisteredGroup, Session, NewMessage } from './types.js';
import {
  initDatabase,
  storeMessage,
  storeChatMetadata,
  getNewMessages,
  getMessagesSince,
  getAllTasks,
  updateTaskAfterRun,
  logTaskRun,
  getAllChats,
  getChat,
} from './db.js';
import { startSchedulerLoop } from './task-scheduler.js';
import { executeCommand, commands } from './commands.js';
import { runContainerAgent, writeTasksSnapshot, writeGroupsSnapshot, AvailableGroup } from './container-runner.js';
import { loadJson, saveJson } from './utils.js';
import { TelegramMessenger } from './telegram.js';
import { FeishuMessenger } from './feishu.js';

const logger = pino({
  level: process.env.LOG_LEVEL || 'info',
  transport: { target: 'pino-pretty', options: { colorize: true } }
});

let lastTimestamp = '';
let sessions: Session = {};
let registeredGroups: Record<string, RegisteredGroup> = {};
let lastAgentTimestamp: Record<string, string> = {};
let messenger: TelegramMessenger | FeishuMessenger;
let messengerType: 'telegram' | 'feishu' = (process.env.MESSENGER as any) || 'telegram';

// Track processed message IDs to avoid duplicates (for WebSocket messengers like Feishu)
let processedMessageIds: Set<string> = new Set();

function loadState(): void {
  const statePath = path.join(DATA_DIR, 'router_state.json');
  const state = loadJson<{ last_timestamp?: string; last_agent_timestamp?: Record<string, string> }>(statePath, {});
  lastTimestamp = state.last_timestamp || '';
  lastAgentTimestamp = state.last_agent_timestamp || {};
  sessions = loadJson(path.join(DATA_DIR, 'sessions.json'), {});
  registeredGroups = loadJson(path.join(DATA_DIR, 'registered_groups.json'), {});
  logger.info({ groupCount: Object.keys(registeredGroups).length }, 'State loaded');
}

function saveState(): void {
  saveJson(path.join(DATA_DIR, 'router_state.json'), { last_timestamp: lastTimestamp, last_agent_timestamp: lastAgentTimestamp });
  saveJson(path.join(DATA_DIR, 'sessions.json'), sessions);
}

function registerGroup(jid: string, group: RegisteredGroup): void {
  registeredGroups[jid] = group;
  saveJson(path.join(DATA_DIR, 'registered_groups.json'), registeredGroups);

  // Create group folder
  const groupDir = path.join(DATA_DIR, '..', 'groups', group.folder);
  fs.mkdirSync(path.join(groupDir, 'logs'), { recursive: true });

  logger.info({ jid, name: group.name, folder: group.folder }, 'Group registered');
}

/**
 * Check if main session is already registered
 * Returns the chatJid of the main session, or undefined if none exists
 */
function getExistingMainSession(): string | undefined {
  return Object.entries(registeredGroups).find(
    ([, group]) => group.folder === MAIN_GROUP_FOLDER
  )?.[0];
}

/**
 * Handle /register command for self-registration
 * Can be called even for unregistered chats
 * Returns response text to be sent
 */
async function handleRegisterCommand(
  chatJid: string,
  senderName: string,
  folderName?: string,
  chatType?: 'private' | 'group',
  senderId?: string, // For private chats: restrict to this sender
  messengerType?: 'telegram' | 'feishu'
): Promise<string> {
  // Check if already registered
  if (registeredGroups[chatJid]) {
    return `✅ This chat is already registered as workspace: **${registeredGroups[chatJid].name}**`;
  }

  // Get chat info from database for accurate name
  const chatInfo = getChat(chatJid);
  const displayName = chatInfo?.name || senderName || 'Chat';

  // Determine folder assignment
  let folder: string;
  let isMainSession = false;

  if (folderName) {
    // User specified a folder name
    folder = folderName;
  } else if (chatType === 'private') {
    // For private chats (Feishu p2p / Telegram DM)
    // Check if main session already exists
    const existingMain = getExistingMainSession();
    if (existingMain) {
      // Main session exists, create a regular folder for this p2p chat
      folder = chatInfo?.name
        ? chatInfo.name.replace(/[^a-z0-9-]/gi, '-')
        : `p2p-${Date.now()}`;
    } else {
      // No main session yet, this becomes the main
      folder = MAIN_GROUP_FOLDER;
      isMainSession = true;
    }
  } else {
    // For group chats, use the stored name
    folder = chatInfo?.name
      ? chatInfo.name.replace(/[^a-z0-9-]/gi, '-')
      : `chat-${Date.now()}`;
  }

  const sanitizedFolder = folder.replace(/[^a-z0-9-]/gi, '-');

  // Set trigger based on chat type
  // Main session and private chats don't need trigger
  // Other groups may need trigger
  const trigger = (isMainSession || chatType === 'private') ? '' : '';

  // For private chats, restrict to sender who registered
  const allowedUsers = (chatType === 'private' && senderId) ? [senderId] : undefined;

  // Register the group
  registerGroup(chatJid, {
    name: displayName,
    folder: sanitizedFolder,
    trigger,
    added_at: new Date().toISOString(),
    allowedUsers,
    isMainSession,
  });

  if (isMainSession) {
    return `✅ Main session registered!

Name: **${displayName}**
Folder: ${sanitizedFolder}
Type: Private (Main Session)

You are the main user of NanoClaw with full access.`;
  }

  return `✅ Workspace registered!

Name: **${displayName}**
Folder: ${sanitizedFolder}
Type: ${chatType === 'private' ? 'Private' : 'Group'}

You can now start chatting!`;
}

/**
 * Get available groups list for the agent.
 * Returns groups ordered by most recent activity.
 */
function getAvailableGroups(): AvailableGroup[] {
  const chats = getAllChats();
  const registeredJids = new Set(Object.keys(registeredGroups));

  return chats
    .filter(c => c.jid !== '__group_sync__')
    .map(c => ({
      jid: c.jid,
      name: c.name,
      lastActivity: c.last_message_time,
      isRegistered: registeredJids.has(c.jid)
    }));
}

async function processMessage(msg: NewMessage): Promise<void> {
  // Deduplicate messages - skip if already processed
  if (processedMessageIds.has(msg.id)) {
    logger.debug({ messageId: msg.id }, 'Message already processed, skipping');
    return;
  }
  processedMessageIds.add(msg.id);

  // Keep only last 1000 message IDs to prevent memory issues
  if (processedMessageIds.size > 1000) {
    const idsArray = Array.from(processedMessageIds);
    processedMessageIds = new Set(idsArray.slice(-1000));
  }

  logger.info({
    chatJid: msg.chat_jid,
    sender: msg.sender_name,
    content: msg.content,
    id: msg.id,
  }, 'processMessage called');

  const group = registeredGroups[msg.chat_jid];
  const content = msg.content.trim().toLowerCase();

  // Check if it's a /register command - allow even for unregistered chats
  if (content === '/register' || content.startsWith('/register ')) {
    const folderName = content.startsWith('/register ') ? msg.content.trim().slice(9).trim() : undefined;
    const response = await handleRegisterCommand(msg.chat_jid, msg.sender_name, folderName, msg.chat_type, msg.sender, messengerType);
    await messenger.sendMessage(msg.chat_jid, response);
    return;
  }

  // For all other messages, require registration
  if (!group) {
    await messenger.sendMessage(msg.chat_jid, `👋 Welcome!

Send **/register** to register this chat as a workspace.`);
    return;
  }

  // Authorization check: for private chats with allowedUsers restriction,
  // only allow the registered user to send messages
  if (msg.chat_type === 'private' && group.allowedUsers && group.allowedUsers.length > 0) {
    if (!group.allowedUsers.includes(msg.sender)) {
      logger.warn({
        chatJid: msg.chat_jid,
        sender: msg.sender,
        allowedUsers: group.allowedUsers,
      }, 'Unauthorized user attempted to chat in private session');
      await messenger.sendMessage(msg.chat_jid, `⛔ You are not authorized for this session.`);
      return;
    }
  }

  const isMainGroup = group.folder === MAIN_GROUP_FOLDER || group.isMainSession === true;

  // Main group and private chats (empty trigger) respond to all messages
  // Other groups require trigger prefix
  if (!isMainGroup && group.trigger) {
    const groupTriggerPattern = new RegExp(`^${escapeRegex(group.trigger)}\\b`, 'i');
    if (!groupTriggerPattern.test(content)) return;
  }

  // Check if message is a command
  const commandResult = await executeCommand(content, group.trigger, {
    chatId: msg.chat_jid,
    groupName: group.name,
    groupFolder: group.folder,
    content,
    timestamp: msg.timestamp,
  });

  if (commandResult.handled) {
    // Command was handled, send response
    if (commandResult.response) {
      await messenger.sendMessage(msg.chat_jid, commandResult.response);
    }

    // Reset session if requested
    if (commandResult.shouldResetSession) {
      delete sessions[group.folder];
      saveJson(path.join(DATA_DIR, 'sessions.json'), sessions);
    }

    return;
  }

  // Get all messages since last agent interaction so the session has full context
  const sinceTimestamp = lastAgentTimestamp[msg.chat_jid] || '';
  const missedMessages = getMessagesSince(msg.chat_jid, sinceTimestamp, ASSISTANT_NAME);

  const lines = missedMessages.map(m => {
    // Escape XML special characters in content
    const escapeXml = (s: string) => s
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
    return `<message sender="${escapeXml(m.sender_name)}" time="${m.timestamp}">${escapeXml(m.content)}</message>`;
  });
  const prompt = `<messages>\n${lines.join('\n')}\n</messages>`;

  if (!prompt) return;

  logger.info({ group: group.name, messageCount: missedMessages.length }, 'Processing message');

  const response = await runAgent(group, prompt, msg.chat_jid, msg.id);

  if (response) {
    lastAgentTimestamp[msg.chat_jid] = msg.timestamp;
    await messenger.sendMessage(msg.chat_jid, `${ASSISTANT_NAME}: ${response}`);
  }
}

async function runAgent(group: RegisteredGroup, prompt: string, chatJid: string, originalMessageId: string): Promise<string | null> {
  const isMain = group.folder === MAIN_GROUP_FOLDER || group.isMainSession === true;
  const sessionId = sessions[group.folder];

  // Update tasks snapshot for container to read (filtered by group)
  const tasks = getAllTasks();
  writeTasksSnapshot(group.folder, isMain, tasks.map(t => ({
    id: t.id,
    groupFolder: t.group_folder,
    prompt: t.prompt,
    schedule_type: t.schedule_type,
    schedule_value: t.schedule_value,
    status: t.status,
    next_run: t.next_run
  })));

  // Update available groups snapshot (main group only can see all groups)
  const availableGroups = getAvailableGroups();
  writeGroupsSnapshot(group.folder, isMain, availableGroups, new Set(Object.keys(registeredGroups)));

  const STATUS_DEBOUNCE_MS = 2000;
  const lastStatusMessages: Record<string, { message: string; timestamp: number }> = {};
  let statusMessageIdExists = false;

  try {
    const output = await runContainerAgent(group, {
      prompt,
      sessionId,
      groupFolder: group.folder,
      chatJid,
      isMain
    }, {
      onStatusUpdate: async (message) => {
        const now = Date.now();
        const lastStatus = lastStatusMessages[originalMessageId];

        // Send update if:
        // 1. First status message for this message in this chat
        // 2. Message content is significantly different (not just whitespace/punctuation)
        // 3. Enough time has passed since last update
        const shouldUpdate = !lastStatus ||
          message !== lastStatus.message ||
          (now - lastStatus.timestamp > STATUS_DEBOUNCE_MS);

        if (shouldUpdate) {
          const isNew = !statusMessageIdExists;
          // Only pass replyToMessageId if it's a new message (for Telegram's reply support)
          // // Feishu doesn't use replyToMessageId since WebSocket handles replies differently
          if (isNew) {
            await messenger.sendOrUpdateStatusMessage(
              chatJid,
              originalMessageId,
              `⏳ ${message}`,
              isNew,
              // For Telegram, convert to number; Feishu ignores this parameter
              parseInt(originalMessageId, 10) || undefined
            );
          } else {
            await messenger.sendOrUpdateStatusMessage(
              chatJid,
              originalMessageId,
              `⏳ ${message}`,
              isNew
            );
          }
          statusMessageIdExists = true;
          lastStatusMessages[originalMessageId] = { message, timestamp: now };
        }
      }
    });

    if (output.newSessionId) {
      sessions[group.folder] = output.newSessionId;
      saveJson(path.join(DATA_DIR, 'sessions.json'), sessions);
    }

    if (output.status === 'error') {
      logger.error({ group: group.name, error: output.error }, 'Container agent error');
      // Update status message with error
      await messenger.sendOrUpdateStatusMessage(chatJid, originalMessageId, `❌ Error: ${output.error || 'Unknown error'}`, false, undefined);
      messenger.clearStatusMessage(chatJid, originalMessageId);
      return null;
    }

    // Clear status message tracking before sending final result
    messenger.clearStatusMessage(chatJid, originalMessageId);

    return output.result;
  } catch (err) {
    logger.error({ group: group.name, err }, 'Agent error');
    messenger.clearStatusMessage(chatJid, originalMessageId);
    return null;
  }
}

function startIpcWatcher(): void {
  const ipcBaseDir = path.join(DATA_DIR, 'ipc');
  fs.mkdirSync(ipcBaseDir, { recursive: true });

  const processIpcFiles = async () => {
    // Scan all group IPC directories (identity determined by directory)
    let groupFolders: string[];
    try {
      groupFolders = fs.readdirSync(ipcBaseDir).filter(f => {
        const stat = fs.statSync(path.join(ipcBaseDir, f));
        return stat.isDirectory() && f !== 'errors';
      });
    } catch (err) {
      logger.error({ err }, 'Error reading IPC base directory');
      setTimeout(processIpcFiles, IPC_POLL_INTERVAL);
      return;
    }

    for (const sourceGroup of groupFolders) {
      const isMain = sourceGroup === MAIN_GROUP_FOLDER;
      const messagesDir = path.join(ipcBaseDir, sourceGroup, 'messages');
      const tasksDir = path.join(ipcBaseDir, sourceGroup, 'tasks');

      // Process messages from this group's IPC directory
      try {
        if (fs.existsSync(messagesDir)) {
          const messageFiles = fs.readdirSync(messagesDir).filter(f => f.endsWith('.json'));
          for (const file of messageFiles) {
            const filePath = path.join(messagesDir, file);
            try {
              const data = JSON.parse(fs.readFileSync(filePath, 'utf-8'));
              if ((data.type === 'message' || data.type === 'status') && data.chatJid && data.text) {
                // Authorization: verify this group can send to this chatJid
                const targetGroup = registeredGroups[data.chatJid];
                if (isMain || (targetGroup && targetGroup.folder === sourceGroup)) {
                  // Status messages don't get the assistant name prefix (cleaner UI)
                  const message = data.type === 'status'
                    ? `⏳ ${data.text}`
                    : `${ASSISTANT_NAME}: ${data.text}`;
                  await messenger.sendMessage(data.chatJid, message);
                  logger.info({ chatJid: data.chatJid, sourceGroup, type: data.type }, 'IPC message sent');
                } else {
                  logger.warn({ chatJid: data.chatJid, sourceGroup }, 'Unauthorized IPC message attempt blocked');
                }
              }
              fs.unlinkSync(filePath);
            } catch (err) {
              logger.error({ file, sourceGroup, err }, 'Error processing IPC message');
              const errorDir = path.join(ipcBaseDir, 'errors');
              fs.mkdirSync(errorDir, { recursive: true });
              fs.renameSync(filePath, path.join(errorDir, `${sourceGroup}-${file}`));
            }
          }
        }
      } catch (err) {
        logger.error({ err, sourceGroup }, 'Error reading IPC messages directory');
      }

      // Process tasks from this group's IPC directory
      try {
        if (fs.existsSync(tasksDir)) {
          const taskFiles = fs.readdirSync(tasksDir).filter(f => f.endsWith('.json'));
          for (const file of taskFiles) {
            const filePath = path.join(tasksDir, file);
            try {
              const data = JSON.parse(fs.readFileSync(filePath, 'utf-8'));
              // Pass source group identity to processTaskIpc for authorization
              await processTaskIpc(data, sourceGroup, isMain);
              fs.unlinkSync(filePath);
            } catch (err) {
              logger.error({ file, sourceGroup, err }, 'Error processing IPC task');
              const errorDir = path.join(ipcBaseDir, 'errors');
              fs.mkdirSync(errorDir, { recursive: true });
              fs.renameSync(filePath, path.join(errorDir, `${sourceGroup}-${file}`));
            }
          }
        }
      } catch (err) {
        logger.error({ err, sourceGroup }, 'Error reading IPC tasks directory');
      }
    }

    setTimeout(processIpcFiles, IPC_POLL_INTERVAL);
  };

  processIpcFiles();
  logger.info('IPC watcher started (per-group namespaces)');
}

async function processTaskIpc(
  data: {
    type: string;
    taskId?: string;
    prompt?: string;
    schedule_type?: string;
    schedule_value?: string;
    context_mode?: string;
    groupFolder?: string;
    chatJid?: string;
    // For register_group
    jid?: string;
    name?: string;
    folder?: string;
    trigger?: string;
    containerConfig?: RegisteredGroup['containerConfig'];
  },
  sourceGroup: string,
  isMain: boolean
): Promise<void> {
  // Import db functions dynamically to avoid circular deps
  const { createTask, updateTask, deleteTask, getTaskById: getTask } = await import('./db.js');
  const { CronExpressionParser } = await import('cron-parser');

  switch (data.type) {
    case 'schedule_task':
      if (data.prompt && data.schedule_type && data.schedule_value && data.groupFolder) {
        // Authorization: non-main groups can only schedule for themselves
        const targetGroup = data.groupFolder;
        if (!isMain && targetGroup !== sourceGroup) {
          logger.warn({ sourceGroupGroup: targetGroup }, 'Unauthorized schedule_task attempt blocked');
          break;
        }

        // Resolve the correct JID for the target group (don't trust IPC payload)
        const targetJid = Object.entries(registeredGroups).find(
          ([, group]) => group.folder === targetGroup
        )?.[0];

        if (!targetJid) {
          logger.warn({ targetGroup }, 'Cannot schedule task: target group not registered');
          break;
        }

        const scheduleType = data.schedule_type as 'cron' | 'interval' | 'once';

        let nextRun: string | null = null;
        if (scheduleType === 'cron') {
          try {
            const interval = CronExpressionParser.parse(data.schedule_value, { tz: TIMEZONE });
            nextRun = interval.next().toISOString();
          } catch {
            logger.warn({ scheduleValue: data.schedule_value }, 'Invalid cron expression');
            break;
          }
        } else if (scheduleType === 'interval') {
          const ms = parseInt(data.schedule_value, 10);
          if (isNaN(ms) || ms <= 0) {
            logger.warn({ scheduleValue: data.schedule_value }, 'Invalid interval');
            break;
          }
          nextRun = new Date(Date.now() + ms).toISOString();
        } else if (scheduleType === 'once') {
          const scheduled = new Date(data.schedule_value);
          if (isNaN(scheduled.getTime())) {
            logger.warn({ scheduleValue: data.schedule_value }, 'Invalid timestamp');
            break;
          }
          nextRun = scheduled.toISOString();
        }

        const taskId = `task-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
        const contextMode = (data.context_mode === 'group' || data.context_mode === 'isolated')
          ? data.context_mode
          : 'isolated';
        createTask({
          id: taskId,
          group_folder: targetGroup,
          chat_jid: targetJid,
          prompt: data.prompt,
          schedule_type: scheduleType,
          schedule_value: data.schedule_value,
          context_mode: contextMode,
          next_run: nextRun,
          status: 'active',
          created_at: new Date().toISOString()
        });
        logger.info({ taskId, sourceGroup, targetGroup, contextMode }, 'Task created via IPC');
      }
      break;

    case 'pause_task':
      if (data.taskId) {
        const task = getTask(data.taskId);
        if (task && (isMain || task.group_folder === sourceGroup)) {
          updateTask(data.taskId, { status: 'paused' });
          logger.info({ taskId: data.taskId, sourceGroup }, 'Task paused via IPC');
        } else {
          logger.warn({ taskId: data.taskId, sourceGroup }, 'Unauthorized task pause attempt');
        }
      }
      break;

    case 'resume_task':
      if (data.taskId) {
        const task = getTask(data.taskId);
        if (task && (isMain || task.group_folder === sourceGroup)) {
          updateTask(data.taskId, { status: 'active' });
          logger.info({ taskId: data.taskId, sourceGroup }, 'Task resumed via IPC');
        } else {
          logger.warn({ taskId: data.taskId, sourceGroup }, 'Unauthorized task resume attempt');
        }
      }
      break;

    case 'cancel_task':
      if (data.taskId) {
        const task = getTask(data.taskId);
        if (task && (isMain || task.group_folder === sourceGroup)) {
          deleteTask(data.taskId);
          logger.info({ taskId: data.taskId, sourceGroup }, 'Task cancelled via IPC');
        } else {
          logger.warn({ taskId: data.taskId, sourceGroup }, 'Unauthorized task cancel attempt');
        }
      }
      break;

    case 'register_group':
      // Only main group can register new groups
      if (!isMain) {
        logger.warn({ sourceGroup }, 'Unauthorized register_group attempt blocked');
        break;
      }
      if (data.jid && data.name && data.folder && data.trigger) {
        registerGroup(data.jid, {
          name: data.name,
          folder: data.folder,
          trigger: data.trigger,
          added_at: new Date().toISOString(),
          containerConfig: data.containerConfig
        });
      } else {
        logger.warn({ data }, 'Invalid register_group request - missing required fields');
      }
      break;

    default:
      logger.warn({ type: data.type }, 'Unknown IPC task type');
  }
}

async function startMessageLoop(): Promise<void> {
  logger.info(`NanoClaw running (trigger: @${ASSISTANT_NAME})`);

  while (true) {
    try {
      const jids = Object.keys(registeredGroups);
      const { messages } = getNewMessages(jids, lastTimestamp, ASSISTANT_NAME);

      if (messages.length > 0) logger.info({ count: messages.length }, 'New messages');
      for (const msg of messages) {
        try {
          await processMessage(msg);
          // Only advance timestamp after successful processing for at-least-once delivery
          lastTimestamp = msg.timestamp;
          saveState();
        } catch (err) {
          logger.error({ err, msg: msg.id }, 'Error processing message, will retry');
          // Stop processing this batch - failed message will be retried next loop
          break;
        }
      }
    } catch (err) {
      logger.error({ err }, 'Error in message loop');
    }
    await new Promise(resolve => setTimeout(resolve, messenger.getPollInterval()));
  }
}

function ensureContainerSystemRunning(): void {
  try {
    execSync('container system status', { stdio: 'pipe' });
    logger.debug('Apple Container system already running');
  } catch {
    logger.info('Starting Apple Container system...');
    try {
      execSync('container system start', { stdio: 'pipe', timeout: 30000 });
      logger.info('Apple Container system started');
    } catch (err) {
      logger.error({ err }, 'Failed to start Apple Container system');
      console.error('\n╔════════════════════════════════════════════════════════════════╗');
      console.error('║  FATAL: Apple Container system failed to start                 ║');
      console.error('║                                                                ║');
      console.error('║  Agents cannot run without Apple Container. To fix:           ║');
      console.error('║  1. Install from: https://github.com/apple/container/releases ║');
      console.error('║  2. Run: container system start                               ║');
      console.error('║  3. Restart NanoClaw                                          ║');
      console.error('╚════════════════════════════════════════════════════════════════╝\n');
      throw new Error('Apple Container system is required but failed to start');
    }
  }
}

async function startMessenger(): Promise<void> {
  // Initialize messenger based on environment variable
  if (messengerType === 'feishu') {
    messenger = new FeishuMessenger(
      logger,
      STORE_DIR,
      registeredGroups,
      POLL_INTERVAL
    );
    logger.info('Using Feishu messenger');
  } else {
    messenger = new TelegramMessenger(
      logger,
      STORE_DIR,
      registeredGroups,
      POLL_INTERVAL
    );
    logger.info('Using Telegram messenger');
  }

  await messenger.connect();

  // Register commands (Telegram only)
  if (messengerType === 'telegram') {
    const botCommands = commands.map(cmd => ({
      name: cmd.name,
      description: cmd.description
    }));
    await messenger.registerCommands(botCommands);

    // Verify commands are registered correctly
    await (messenger as TelegramMessenger).verifyCommands(botCommands);
  }

  // Register message listener callback
  messenger.startMessageListener(processMessage);

  // Start message listener and other services
  startSchedulerLoop({
    sendMessage: (chatId: string, text: string) => messenger.sendMessage(chatId, text),
    registeredGroups: () => registeredGroups,
    getSessions: () => sessions
  });
  startIpcWatcher();

  // Start message loop only if messenger needs polling
  if (messenger.needsPolling()) {
    startMessageLoop();
  }

  // Send startup greetings
  await messenger.sendStartupGreetings(registeredGroups, MAIN_GROUP_FOLDER);
}

async function main(): Promise<void> {
  ensureContainerSystemRunning();
  initDatabase();
  logger.info('Database initialized');
  loadState();
  await startMessenger();
}

main().catch(err => {
  logger.error({ err }, 'Failed to start NanoClaw');
  process.exit(1);
});
