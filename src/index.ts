import { exec, execSync } from 'child_process';
import fs from 'fs';
import path from 'path';

import { CronExpressionParser } from 'cron-parser';

import {
  ASSISTANT_NAME,
  DATA_DIR,
  escapeRegex,
  IPC_POLL_INTERVAL,
  MAIN_GROUP_FOLDER,
  POLL_INTERVAL,
  STORE_DIR,
  TIMEZONE,
  TRIGGER_PATTERN,
} from './config.js';
import {
  AgentResponse,
  AvailableGroup,
  runContainerAgent,
  writeGroupsSnapshot,
  writeTasksSnapshot,
} from './container-runner.js';
import {
  createTask,
  deleteTask,
  getAllChats,
  getAllRegisteredGroups,
  getAllSessions,
  getAllTasks,
  getChat,
  getLastGroupSync,
  getMessagesSince,
  getNewMessages,
  getRouterState,
  getTaskById,
  initDatabase,
  setLastGroupSync,
  setRegisteredGroup,
  setRouterState,
  setSession,
  storeChatMetadata,
  storeMessage,
  updateChatName,
  updateTask,
} from './db.js';
import { GroupQueue } from './group-queue.js';
import { startSchedulerLoop } from './task-scheduler.js';
import { RegisteredGroup, NewMessage, Messenger } from './types.js';
import { TelegramMessenger } from './telegram.js';
import { FeishuMessenger } from './feishu.js';
import { executeCommand, commands } from './commands.js';
import { logger } from './logger.js';

const GROUP_SYNC_INTERVAL_MS = 24 * 60 * 60 * 1000; // 24 hours

// Global state
let lastTimestamp = '';
let sessions: Record<string, string> = {};
let registeredGroups: Record<string, RegisteredGroup> = {};
let lastAgentTimestamp: Record<string, string> = {};

// Guards to prevent duplicate loops on reconnect
let messageLoopRunning = false;
let ipcWatcherRunning = false;
let groupSyncTimerStarted = false;

const queue = new GroupQueue();

// Messenger abstraction - supports WhatsApp, Telegram, and Feishu
let messenger: Messenger | undefined;
let messengerType: 'whatsapp' | 'telegram' | 'feishu' = (process.env.MESSENGER as any) || 'whatsapp';

// WhatsApp-specific state (only used when MESSENGER=whatsapp)
let whatsappSock: any = undefined;
let lidToPhoneMap: Record<string, string> = {};

/**
 * Translate a JID from LID format to phone format if we have a mapping.
 * Returns the original JID if no mapping exists.
 * (WhatsApp-specific)
 */
function translateJid(jid: string): string {
  if (!jid.endsWith('@lid')) return jid;
  const lidUser = jid.split('@')[0].split(':')[0];
  const phoneJid = lidToPhoneMap[lidUser];
  if (phoneJid) {
    logger.debug({ lidJid: jid, phoneJid }, 'Translated LID to phone JID');
    return phoneJid;
  }
  return jid;
}

async function setTyping(jid: string, isTyping: boolean): Promise<void> {
  // Only WhatsApp supports typing indicators
  if (messengerType === 'whatsapp' && whatsappSock) {
    try {
      await whatsappSock.sendPresenceUpdate(isTyping ? 'composing' : 'paused', jid);
    } catch (err) {
      logger.debug({ jid, err }, 'Failed to update typing status');
    }
  }
}

function loadState(): void {
  // Load from SQLite (migration from JSON happens in initDatabase)
  lastTimestamp = getRouterState('last_timestamp') || '';
  const agentTs = getRouterState('last_agent_timestamp');
  try {
    lastAgentTimestamp = agentTs ? JSON.parse(agentTs) : {};
  } catch {
    logger.warn('Corrupted last_agent_timestamp in DB, resetting');
    lastAgentTimestamp = {};
  }
  sessions = getAllSessions();
  registeredGroups = getAllRegisteredGroups();
  logger.info(
    { groupCount: Object.keys(registeredGroups).length },
    'State loaded',
  );
}

function saveState(): void {
  setRouterState('last_timestamp', lastTimestamp);
  setRouterState(
    'last_agent_timestamp',
    JSON.stringify(lastAgentTimestamp),
  );
}

function registerGroup(jid: string, group: RegisteredGroup): void {
  registeredGroups[jid] = group;
  setRegisteredGroup(jid, group);

  // Create group folder
  const groupDir = path.join(DATA_DIR, '..', 'groups', group.folder);
  fs.mkdirSync(path.join(groupDir, 'logs'), { recursive: true });

  logger.info(
    { jid, name: group.name, folder: group.folder },
    'Group registered',
  );
}

/**
 * Check if main session is already registered
 * Returns the chatJid of the main session, or undefined if none exists
 */
function getExistingMainSession(): string | undefined {
  return Object.entries(registeredGroups).find(
    ([, group]) => group.folder === MAIN_GROUP_FOLDER || group.isMainSession === true
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
    // For private chats (DM)
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
    requiresTrigger: !isMainSession && chatType !== 'private',
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
 * Sync group metadata from the messenger.
 * Messenger-specific implementation.
 * Called on startup, daily, and on-demand via IPC.
 */
async function syncGroupMetadata(force = false): Promise<void> {
  // Check if we need to sync (skip if synced recently, unless forced)
  if (!force) {
    const lastSync = getLastGroupSync();
    if (lastSync) {
      const lastSyncTime = new Date(lastSync).getTime();
      const now = Date.now();
      if (now - lastSyncTime < GROUP_SYNC_INTERVAL_MS) {
        logger.debug({ lastSync }, 'Skipping group sync - synced recently');
        return;
      }
    }
  }

  try {
    if (messengerType === 'whatsapp' && whatsappSock) {
      logger.info('Syncing group metadata from WhatsApp...');
      const groups = await whatsappSock.groupFetchAllParticipating();

      let count = 0;
      for (const [jid, metadata] of Object.entries(groups)) {
        const groupMetadata = metadata as { subject?: string };
        if (groupMetadata.subject) {
          updateChatName(jid, groupMetadata.subject);
          count++;
        }
      }
      setLastGroupSync();
      logger.info({ count }, 'Group metadata synced');
    } else {
      // Telegram and Feishu don't have group metadata sync the same way
      // They rely on real-time chat metadata updates
      logger.debug('Group sync not required for this messenger');
    }
  } catch (err) {
    logger.error({ err }, 'Failed to sync group metadata');
  }
}

/**
 * Get available groups list for the agent.
 * Returns groups ordered by most recent activity.
 */
function getAvailableGroups(): AvailableGroup[] {
  const chats = getAllChats();
  const registeredJids = new Set(Object.keys(registeredGroups));

  return chats
    .filter((c) => c.jid !== '__group_sync__' && c.jid.endsWith('@g.us'))
    .map((c) => ({
      jid: c.jid,
      name: c.name,
      lastActivity: c.last_message_time,
      isRegistered: registeredJids.has(c.jid),
    }));
}

/**
 * Process all pending messages for a group.
 * Called by the GroupQueue when it's this group's turn.
 */
async function processGroupMessages(chatJid: string): Promise<boolean> {
  const group = registeredGroups[chatJid];
  if (!group) return true;

  const isMainGroup = group.folder === MAIN_GROUP_FOLDER || group.isMainSession === true;

  // Get all messages since last agent interaction
  const sinceTimestamp = lastAgentTimestamp[chatJid] || '';
  const missedMessages = getMessagesSince(
    chatJid,
    sinceTimestamp,
    ASSISTANT_NAME,
  );

  if (missedMessages.length === 0) return true;

  // Check if any message is a command or register request
  // Commands are processed immediately, not batched
  for (const msg of missedMessages) {
    const content = msg.content.trim();
    const lowerContent = content.toLowerCase();

    // Check if it's a /register command - handle even for unregistered chats
    if (lowerContent === '/register' || lowerContent.startsWith('/register ')) {
      const folderName = lowerContent.startsWith('/register ') ? content.slice(9).trim() : undefined;
      const response = await handleRegisterCommand(chatJid, msg.sender_name, folderName, msg.chat_type, msg.sender);
      await sendMessage(chatJid, response);
      // Mark as processed by updating timestamp
      lastAgentTimestamp[chatJid] = msg.timestamp;
      saveState();
      return true;
    }
  }

  // For non-main groups, check if trigger is required and present
  if (!isMainGroup && group.requiresTrigger !== false) {
    // Build trigger pattern from group's trigger string
    const triggerPattern = group.trigger
      ? new RegExp(`^${escapeRegex(group.trigger)}\\b`, 'i')
      : TRIGGER_PATTERN;
    const hasTrigger = missedMessages.some((m) =>
      triggerPattern.test(m.content.trim()),
    );
    if (!hasTrigger) return true;
  }

  // Build prompt from all missed messages
  const lines = missedMessages.map((m) => {
    const escapeXml = (s: string) =>
      s
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;');
    return `<message sender="${escapeXml(m.sender_name)}" time="${m.timestamp}">${escapeXml(m.content)}</message>`;
  });
  const prompt = `<messages>\n${lines.join('\n')}\n</messages>`;

  logger.info(
    { group: group.name, messageCount: missedMessages.length },
    'Processing messages',
  );

  // Check if the first message is a command
  const firstMessage = missedMessages[0];
  const firstContent = firstMessage.content.trim();
  const commandResult = await executeCommand(firstContent.toLowerCase(), group.trigger, {
    chatId: chatJid,
    groupName: group.name,
    groupFolder: group.folder,
    content: firstContent,
    timestamp: firstMessage.timestamp,
  });

  if (commandResult.handled) {
    // Command was handled, send response
    if (commandResult.response) {
      await sendMessage(chatJid, commandResult.response);
    }

    // Reset session if requested
    if (commandResult.shouldResetSession) {
      delete sessions[group.folder];
      setSession(group.folder, '');
    }

    // Update timestamp
    lastAgentTimestamp[chatJid] = missedMessages[missedMessages.length - 1].timestamp;
    saveState();
    return true;
  }

  // Not a command, process as normal prompt
  await setTyping(chatJid, true);
  const response = await runAgent(group, prompt, chatJid, firstMessage.id);
  await setTyping(chatJid, false);

  if (response === 'error') {
    // Container or agent error — signal failure so queue can retry with backoff
    return false;
  }

  // Agent processed messages successfully (whether it responded or stayed silent)
  lastAgentTimestamp[chatJid] =
    missedMessages[missedMessages.length - 1].timestamp;
  saveState();

  if (response.outputType === 'message' && response.userMessage) {
    await sendMessage(chatJid, `${ASSISTANT_NAME}: ${response.userMessage}`);
  }

  if (response.internalLog) {
    logger.info(
      { group: group.name, outputType: response.outputType },
      `Agent: ${response.internalLog}`,
    );
  }

  return true;
}

async function runAgent(
  group: RegisteredGroup,
  prompt: string,
  chatJid: string,
  originalMessageId?: string,
): Promise<AgentResponse | 'error'> {
  const isMain = group.folder === MAIN_GROUP_FOLDER || group.isMainSession === true;
  const sessionId = sessions[group.folder];

  // Update tasks snapshot for container to read (filtered by group)
  const tasks = getAllTasks();
  writeTasksSnapshot(
    group.folder,
    isMain,
    tasks.map((t) => ({
      id: t.id,
      groupFolder: t.group_folder,
      prompt: t.prompt,
      schedule_type: t.schedule_type,
      schedule_value: t.schedule_value,
      status: t.status,
      next_run: t.next_run,
    })),
  );

  // Update available groups snapshot (main group only can see all groups)
  const availableGroups = getAvailableGroups();
  writeGroupsSnapshot(
    group.folder,
    isMain,
    availableGroups,
    new Set(Object.keys(registeredGroups)),
  );

  const STATUS_DEBOUNCE_MS = 2000;
  const lastStatusMessages: Record<string, { message: string; timestamp: number }> = {};
  let statusMessageIdExists = false;

  try {
    const output = await runContainerAgent(
      group,
      {
        prompt,
        sessionId,
        groupFolder: group.folder,
        chatJid,
        isMain,
      },
      (proc, containerName) => queue.registerProcess(chatJid, proc, containerName),
      {
        onStatusUpdate: async (message) => {
          // Only show status updates for non-WhatsApp messengers
          if (messengerType === 'whatsapp' || !messenger || !originalMessageId) return;

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
            if (isNew) {
              await messenger.sendOrUpdateStatusMessage(
                chatJid,
                originalMessageId,
                `⏳ ${message}`,
                isNew,
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
      }
    );

    if (output.newSessionId) {
      sessions[group.folder] = output.newSessionId;
      setSession(group.folder, output.newSessionId);
    }

    if (output.status === 'error') {
      logger.error(
        { group: group.name, error: output.error },
        'Container agent error',
      );
      if (messengerType !== 'whatsapp' && messenger && originalMessageId) {
        await messenger.sendOrUpdateStatusMessage(chatJid, originalMessageId, `❌ Error: ${output.error || 'Unknown error'}`, false, undefined);
        messenger.clearStatusMessage(chatJid, originalMessageId);
      }
      return 'error';
    }

    if (messengerType !== 'whatsapp' && messenger && originalMessageId) {
      messenger.clearStatusMessage(chatJid, originalMessageId);
    }

    return output.result ?? { outputType: 'log' };
  } catch (err) {
    logger.error({ group: group.name, err }, 'Agent error');
    if (messengerType !== 'whatsapp' && messenger && originalMessageId) {
      messenger.clearStatusMessage(chatJid, originalMessageId);
    }
    return 'error';
  }
}

async function sendMessage(jid: string, text: string): Promise<void> {
  try {
    if (messengerType === 'whatsapp' && whatsappSock) {
      await whatsappSock.sendMessage(jid, { text });
    } else if (messenger) {
      await messenger.sendMessage(jid, text);
    }
    logger.info({ jid, length: text.length }, 'Message sent');
  } catch (err) {
    logger.error({ jid, err }, 'Failed to send message');
  }
}

function startIpcWatcher(): void {
  if (ipcWatcherRunning) {
    logger.debug('IPC watcher already running, skipping duplicate start');
    return;
  }
  ipcWatcherRunning = true;

  const ipcBaseDir = path.join(DATA_DIR, 'ipc');
  fs.mkdirSync(ipcBaseDir, { recursive: true });

  const processIpcFiles = async () => {
    // Scan all group IPC directories (identity determined by directory)
    let groupFolders: string[];
    try {
      groupFolders = fs.readdirSync(ipcBaseDir).filter((f) => {
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
          const messageFiles = fs
            .readdirSync(messagesDir)
            .filter((f) => f.endsWith('.json'));
          for (const file of messageFiles) {
            const filePath = path.join(messagesDir, file);
            try {
              const data = JSON.parse(fs.readFileSync(filePath, 'utf-8'));
              if ((data.type === 'message' || data.type === 'status') && data.chatJid && data.text) {
                // Authorization: verify this group can send to this chatJid
                const targetGroup = registeredGroups[data.chatJid];
                if (
                  isMain ||
                  (targetGroup && targetGroup.folder === sourceGroup)
                ) {
                  // Status messages don't get the assistant name prefix (cleaner UI)
                  const message = data.type === 'status'
                    ? `⏳ ${data.text}`
                    : `${ASSISTANT_NAME}: ${data.text}`;
                  await sendMessage(data.chatJid, message);
                  logger.info(
                    { chatJid: data.chatJid, sourceGroup, type: data.type },
                    'IPC message sent',
                  );
                } else {
                  logger.warn(
                    { chatJid: data.chatJid, sourceGroup },
                    'Unauthorized IPC message attempt blocked',
                  );
                }
              }
              fs.unlinkSync(filePath);
            } catch (err) {
              logger.error(
                { file, sourceGroup, err },
                'Error processing IPC message',
              );
              const errorDir = path.join(ipcBaseDir, 'errors');
              fs.mkdirSync(errorDir, { recursive: true });
              fs.renameSync(
                filePath,
                path.join(errorDir, `${sourceGroup}-${file}`),
              );
            }
          }
        }
      } catch (err) {
        logger.error(
          { err, sourceGroup },
          'Error reading IPC messages directory',
        );
      }

      // Process tasks from this group's IPC directory
      try {
        if (fs.existsSync(tasksDir)) {
          const taskFiles = fs
            .readdirSync(tasksDir)
            .filter((f) => f.endsWith('.json'));
          for (const file of taskFiles) {
            const filePath = path.join(tasksDir, file);
            try {
              const data = JSON.parse(fs.readFileSync(filePath, 'utf-8'));
              // Pass source group identity to processTaskIpc for authorization
              await processTaskIpc(data, sourceGroup, isMain);
              fs.unlinkSync(filePath);
            } catch (err) {
              logger.error(
                { file, sourceGroup, err },
                'Error processing IPC task',
              );
              const errorDir = path.join(ipcBaseDir, 'errors');
              fs.mkdirSync(errorDir, { recursive: true });
              fs.renameSync(
                filePath,
                path.join(errorDir, `${sourceGroup}-${file}`),
              );
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
    targetJid?: string;
    // For register_group
    jid?: string;
    name?: string;
    folder?: string;
    trigger?: string;
    containerConfig?: RegisteredGroup['containerConfig'];
  },
  sourceGroup: string, // Verified identity from IPC directory
  isMain: boolean, // Verified from directory path
): Promise<void> {
  switch (data.type) {
    case 'schedule_task':
      if (
        data.prompt &&
        data.schedule_type &&
        data.schedule_value &&
        data.targetJid
      ) {
        // Resolve the target group from JID
        const targetJid = data.targetJid as string;
        const targetGroupEntry = registeredGroups[targetJid];

        if (!targetGroupEntry) {
          logger.warn(
            { targetJid },
            'Cannot schedule task: target group not registered',
          );
          break;
        }

        const targetFolder = targetGroupEntry.folder;

        // Authorization: non-main groups can only schedule for themselves
        if (!isMain && targetFolder !== sourceGroup) {
          logger.warn(
            { sourceGroup, targetFolder },
            'Unauthorized schedule_task attempt blocked',
          );
          break;
        }

        const scheduleType = data.schedule_type as 'cron' | 'interval' | 'once';

        let nextRun: string | null = null;
        if (scheduleType === 'cron') {
          try {
            const interval = CronExpressionParser.parse(data.schedule_value, {
              tz: TIMEZONE,
            });
            nextRun = interval.next().toISOString();
          } catch {
            logger.warn(
              { scheduleValue: data.schedule_value },
              'Invalid cron expression',
            );
            break;
          }
        } else if (scheduleType === 'interval') {
          const ms = parseInt(data.schedule_value, 10);
          if (isNaN(ms) || ms <= 0) {
            logger.warn(
              { scheduleValue: data.schedule_value },
              'Invalid interval',
            );
            break;
          }
          nextRun = new Date(Date.now() + ms).toISOString();
        } else if (scheduleType === 'once') {
          const scheduled = new Date(data.schedule_value);
          if (isNaN(scheduled.getTime())) {
            logger.warn(
              { scheduleValue: data.schedule_value },
              'Invalid timestamp',
            );
            break;
          }
          nextRun = scheduled.toISOString();
        }

        const taskId = `task-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
        const contextMode =
          data.context_mode === 'group' || data.context_mode === 'isolated'
            ? data.context_mode
            : 'isolated';
        createTask({
          id: taskId,
          group_folder: targetFolder,
          chat_jid: targetJid,
          prompt: data.prompt,
          schedule_type: scheduleType,
          schedule_value: data.schedule_value,
          context_mode: contextMode,
          next_run: nextRun,
          status: 'active',
          created_at: new Date().toISOString(),
        });
        logger.info(
          { taskId, sourceGroup, targetFolder, contextMode },
          'Task created via IPC',
        );
      }
      break;

    case 'pause_task':
      if (data.taskId) {
        const task = getTaskById(data.taskId);
        if (task && (isMain || task.group_folder === sourceGroup)) {
          updateTask(data.taskId, { status: 'paused' });
          logger.info(
            { taskId: data.taskId, sourceGroup },
            'Task paused via IPC',
          );
        } else {
          logger.warn(
            { taskId: data.taskId, sourceGroup },
            'Unauthorized task pause attempt',
          );
        }
      }
      break;

    case 'resume_task':
      if (data.taskId) {
        const task = getTaskById(data.taskId);
        if (task && (isMain || task.group_folder === sourceGroup)) {
          updateTask(data.taskId, { status: 'active' });
          logger.info(
            { taskId: data.taskId, sourceGroup },
            'Task resumed via IPC',
          );
        } else {
          logger.warn(
            { taskId: data.taskId, sourceGroup },
            'Unauthorized task resume attempt',
          );
        }
      }
      break;

    case 'cancel_task':
      if (data.taskId) {
        const task = getTaskById(data.taskId);
        if (task && (isMain || task.group_folder === sourceGroup)) {
          deleteTask(data.taskId);
          logger.info(
            { taskId: data.taskId, sourceGroup },
            'Task cancelled via IPC',
          );
        } else {
          logger.warn(
            { taskId: data.taskId, sourceGroup },
            'Unauthorized task cancel attempt',
          );
        }
      }
      break;

    case 'refresh_groups':
      // Only main group can request a refresh
      if (isMain) {
        logger.info(
          { sourceGroup },
          'Group metadata refresh requested via IPC',
        );
        await syncGroupMetadata(true);
        // Write updated snapshot immediately
        const availableGroups = getAvailableGroups();
        writeGroupsSnapshot(
          sourceGroup,
          true,
          availableGroups,
          new Set(Object.keys(registeredGroups)),
        );
      } else {
        logger.warn(
          { sourceGroup },
          'Unauthorized refresh_groups attempt blocked',
        );
      }
      break;

    case 'register_group':
      // Only main group can register new groups
      if (!isMain) {
        logger.warn(
          { sourceGroup },
          'Unauthorized register_group attempt blocked',
        );
        break;
      }
      if (data.jid && data.name && data.folder && data.trigger) {
        registerGroup(data.jid, {
          name: data.name,
          folder: data.folder,
          trigger: data.trigger,
          added_at: new Date().toISOString(),
          containerConfig: data.containerConfig,
        });
      } else {
        logger.warn(
          { data },
          'Invalid register_group request - missing required fields',
        );
      }
      break;

    default:
      logger.warn({ type: data.type }, 'Unknown IPC task type');
  }
}

/**
 * WhatsApp-specific connection function
 * Used when MESSENGER=whatsapp
 */
async function connectWhatsApp(): Promise<void> {
  const { useMultiFileAuthState, makeCacheableSignalKeyStore, makeWASocket, DisconnectReason } = await import('@whiskeysockets/baileys');

  const authDir = path.join(STORE_DIR, 'auth');
  fs.mkdirSync(authDir, { recursive: true });

  const { state, saveCreds } = await useMultiFileAuthState(authDir);

  whatsappSock = makeWASocket({
    auth: {
      creds: state.creds,
      keys: makeCacheableSignalKeyStore(state.keys, logger),
    },
    printQRInTerminal: false,
    logger,
    browser: ['NanoClaw', 'Chrome', '1.0.0'],
  });

  whatsappSock.ev.on('connection.update', (update: any) => {
    const { connection, lastDisconnect, qr } = update;

    if (qr) {
      const msg =
        'WhatsApp authentication required. Run /setup in Claude Code.';
      logger.error(msg);
      exec(
        `osascript -e 'display notification "${msg}" with title "NanoClaw" sound name "Basso"'`,
      );
      setTimeout(() => process.exit(1), 1000);
    }

    if (connection === 'close') {
      const reason = (lastDisconnect?.error as any)?.output?.statusCode;
      const shouldReconnect = reason !== DisconnectReason.loggedOut;
      logger.info({ reason, shouldReconnect }, 'Connection closed');

      if (shouldReconnect) {
        logger.info('Reconnecting...');
        connectWhatsApp();
      } else {
        logger.info('Logged out. Run /setup to re-authenticate.');
        process.exit(0);
      }
    } else if (connection === 'open') {
      logger.info('Connected to WhatsApp');

      // Build LID to phone mapping from auth state for self-chat translation
      if (whatsappSock.user) {
        const phoneUser = whatsappSock.user.id.split(':')[0];
        const lidUser = whatsappSock.user.lid?.split(':')[0];
        if (lidUser && phoneUser) {
          lidToPhoneMap[lidUser] = `${phoneUser}@s.whatsapp.net`;
          logger.debug({ lidUser, phoneUser }, 'LID to phone mapping set');
        }
      }

      // Sync group metadata on startup (respects 24h cache)
      syncGroupMetadata().catch((err) =>
        logger.error({ err }, 'Initial group sync failed'),
      );
      // Set up daily sync timer (only once)
      if (!groupSyncTimerStarted) {
        groupSyncTimerStarted = true;
        setInterval(() => {
          syncGroupMetadata().catch((err) =>
            logger.error({ err }, 'Periodic group sync failed'),
          );
        }, GROUP_SYNC_INTERVAL_MS);
      }
      startSchedulerLoop({
        sendMessage,
        registeredGroups: () => registeredGroups,
        getSessions: () => sessions,
        queue,
        onProcess: (groupJid, proc, containerName) => queue.registerProcess(groupJid, proc, containerName),
      });
      startIpcWatcher();
      queue.setProcessMessagesFn(processGroupMessages);
      recoverPendingMessages();
      startMessageLoop();
    }
  });

  whatsappSock.ev.on('creds.update', saveCreds);

  whatsappSock.ev.on('messages.upsert', ({ messages }: any) => {
    for (const msg of messages) {
      if (!msg.message) continue;
      const rawJid = msg.key.remoteJid;
      if (!rawJid || rawJid === 'status@broadcast') continue;

      // Translate LID JID to phone JID if applicable
      const chatJid = translateJid(rawJid);

      const timestamp = new Date(
        Number(msg.messageTimestamp) * 1000,
      ).toISOString();

      // Always store chat metadata for group discovery
      storeChatMetadata(chatJid, timestamp);

      // Only store full message content for registered groups
      if (registeredGroups[chatJid]) {
        storeMessage(
          msg,
          chatJid,
          msg.key.fromMe || false,
        );
      }
    }
  });
}

/**
 * Initialize the messenger based on MESSENGER environment variable
 * Supports: telegram, feishu, or whatsapp (default)
 */
async function startMessenger(): Promise<void> {
  if (messengerType === 'feishu') {
    messenger = new FeishuMessenger(
      logger,
      STORE_DIR,
      registeredGroups,
      POLL_INTERVAL
    );
    logger.info('Using Feishu messenger');
  } else if (messengerType === 'telegram') {
    messenger = new TelegramMessenger(
      logger,
      STORE_DIR,
      registeredGroups,
      POLL_INTERVAL
    );
    logger.info('Using Telegram messenger');
  } else {
    // WhatsApp is default - handled by connectWhatsApp
    logger.info('Using WhatsApp messenger (default)');
    await connectWhatsApp();
    return;
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

  /**
   * Handle incoming message from real-time messenger (Feishu, Telegram).
   * For unregistered chats, checks for /register command.
   * For registered chats, enqueues chat for processing.
   * This is called directly by messenger messenger when message arrives via WebSocket/polling.
   */
  async function handleRealtimeMessage(msg: NewMessage): Promise<void> {
    const group = registeredGroups[msg.chat_jid];
    const content = msg.content.trim();
    const lowerContent = content.toLowerCase();

    logger.info({
      chatJid: msg.chat_jid,
      sender: msg.sender_name,
      content: content,
      id: msg.id,
    }, 'Real-time message received');

    // Check if it's a /register command - handle even for unregistered chats
    if (lowerContent === '/register' || lowerContent.startsWith('/register ')) {
      const folderName = lowerContent.startsWith('/register ') ? content.slice(9).trim() : undefined;
      const response = await handleRegisterCommand(msg.chat_jid, msg.sender_name, folderName, msg.chat_type, msg.sender);
      await sendMessage(msg.chat_jid, response);
      // Mark as processed by updating timestamp
      lastAgentTimestamp[msg.chat_jid] = msg.timestamp;
      saveState();
      return;
    }

    // For all other messages, require registration
    if (!group) {
      await sendMessage(msg.chat_jid, `👋 Welcome!

Send **/register** to register this chat as a workspace.`);
      return;
    }

    // Authorization check: for private chats with allowedUsers restriction,
    // only allow the registered user to send
    if (msg.chat_type === 'private' && group.allowedUsers && group.allowedUsers.length > 0) {
      if (!group.allowedUsers.includes(msg.sender)) {
        logger.warn({
          chatJid: msg.chat_jid,
          sender: msg.sender,
          allowedUsers: group.allowedUsers,
        }, 'Unauthorized user attempted to chat in private session');
        await sendMessage(msg.chat_jid, `⛔ You are not authorized for this session.`);
        return;
      }
    }

    // Enqueue chat for processing (let queue handle batching)
    queue.enqueueMessageCheck(msg.chat_jid);
  }

  // Register message listener callback
  // For polling messengers: pass processGroupMessages (queue handles batching)
  // For real-time messengers: pass handleRealtimeMessage (handles /register, then enqueues)
  messenger.startMessageListener(handleRealtimeMessage);

  // Start common services
  startSchedulerLoop({
    sendMessage: (chatId: string, text: string) => sendMessage(chatId, text),
    registeredGroups: () => registeredGroups,
    getSessions: () => sessions,
    queue,
    onProcess: (groupJid, proc, containerName) => queue.registerProcess(groupJid, proc, containerName),
  });
  startIpcWatcher();
  queue.setProcessMessagesFn(processGroupMessages);
  recoverPendingMessages();

  // Start message loop only if messenger needs polling
  if (messenger.needsPolling()) {
    startMessageLoop();
  }

  // Send startup greetings
  await messenger.sendStartupGreetings(registeredGroups, MAIN_GROUP_FOLDER);
}

async function startMessageLoop(): Promise<void> {
  if (messageLoopRunning) {
    logger.debug('Message loop already running, skipping duplicate start');
    return;
  }
  messageLoopRunning = true;

  logger.info(`NanoClaw running (trigger: @${ASSISTANT_NAME})`);

  while (true) {
    try {
      const jids = Object.keys(registeredGroups);
      const { messages, newTimestamp } = getNewMessages(
        jids,
        lastTimestamp,
        ASSISTANT_NAME,
      );

      if (messages.length > 0) {
        logger.info({ count: messages.length }, 'New messages');

        // Advance the "seen" cursor for all messages immediately
        lastTimestamp = newTimestamp;
        saveState();

        // Deduplicate by group and enqueue
        const groupsWithMessages = new Set<string>();
        for (const msg of messages) {
          groupsWithMessages.add(msg.chat_jid);
        }

        for (const chatJid of groupsWithMessages) {
          queue.enqueueMessageCheck(chatJid);
        }
      }
    } catch (err) {
      logger.error({ err }, 'Error in message loop');
    }
    await new Promise((resolve) => setTimeout(resolve, messenger ? messenger.getPollInterval() : POLL_INTERVAL));
  }
}

/**
 * Startup recovery: check for unprocessed messages in registered groups.
 * Handles crash between advancing lastTimestamp and processing messages.
 */
function recoverPendingMessages(): void {
  for (const [chatJid, group] of Object.entries(registeredGroups)) {
    const sinceTimestamp = lastAgentTimestamp[chatJid] || '';
    const pending = getMessagesSince(chatJid, sinceTimestamp, ASSISTANT_NAME);
    if (pending.length > 0) {
      logger.info(
        { group: group.name, pendingCount: pending.length },
        'Recovery: found unprocessed messages',
      );
      queue.enqueueMessageCheck(chatJid);
    }
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
      console.error(
        '\n╔════════════════════════════════════════════════════════════════╗',
      );
      console.error(
        '║  FATAL: Apple Container system failed to start                 ║',
      );
      console.error(
        '║                                                                ║',
      );
      console.error(
        '║  Agents cannot run without Apple Container. To fix:           ║',
      );
      console.error(
        '║  1. Install from: https://github.com/apple/container/releases ║',
      );
      console.error(
        '║  2. Run: container system start                               ║',
      );
      console.error(
        '║  3. Restart NanoClaw                                          ║',
      );
      console.error(
        '╚════════════════════════════════════════════════════════════════╝\n',
      );
      throw new Error('Apple Container system is required but failed to start');
    }
  }

  // Clean up stopped NanoClaw containers from previous runs
  try {
    const output = execSync('container ls -a --format {{.Names}}', {
      stdio: ['pipe', 'pipe', 'pipe'],
      encoding: 'utf-8',
    });
    const stale = output
      .split('\n')
      .map((n) => n.trim())
      .filter((n) => n.startsWith('nanoclaw-'));
    if (stale.length > 0) {
      execSync(`container rm ${stale.join(' ')}`, { stdio: 'pipe' });
      logger.info({ count: stale.length }, 'Cleaned up stopped containers');
    }
  } catch {
    // No No stopped containers or ls/rm not supported
  }
}

async function main(): Promise<void> {
  ensureContainerSystemRunning();
  initDatabase();
  logger.info('Database initialized');
  loadState();

  // Graceful shutdown handlers
  const shutdown = async (signal: string) => {
    logger.info({ signal }, 'Shutdown signal received');
    await queue.shutdown(10000);
    process.exit(0);
  };
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));

  await startMessenger();
}

main().catch((err) => {
  logger.error({ err }, 'Failed to start NanoClaw');
  process.exit(1);
});
