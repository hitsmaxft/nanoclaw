/**
 * Telegram Messenger Implementation
 * Handles Telegram bot communication and implements the Messenger interface
 */

import TelegramBot from 'node-telegram-bot-api';
import pino from 'pino';
import fs from 'fs';
import path from 'path';
import { exec } from 'child_process';
import { Messenger, NewMessage, RegisteredGroup } from './types.js';
import { storeTelegramMessage, storeChatMetadata } from './db.js';

export class TelegramMessenger implements Messenger {
  private bot: TelegramBot | null = null;
  private logger: pino.Logger;
  private storeDir: string;
  private registeredGroups: Record<string, RegisteredGroup>;
  private onMessageCallback?: (msg: NewMessage) => Promise<void>;
  private pollInterval: number;

  // Track current status message IDs for editing by chatId and sessionId
  private statusMessageIds: Record<string, Record<string, number>> = {}; // chatId -> sessionId -> statusMessageId
  private lastStatusMessage: Record<string, Record<string, { message: string; timestamp: number }>> = {}; // chatId -> sessionId -> {message, timestamp}
  private accumulatedStatusMessages: Record<string, Record<string, string>> = {}; // chatId -> sessionId -> accumulatedText
  private readonly STATUS_DEBOUNCE_MS = 2000; // Minimum 2 seconds between status updates

  constructor(
    logger: pino.Logger,
    storeDir: string,
    registeredGroups: Record<string, RegisteredGroup>,
    pollInterval: number
  ) {
    this.logger = logger.child({ messenger: 'telegram' });
    this.storeDir = storeDir;
    this.registeredGroups = registeredGroups;
    this.pollInterval = pollInterval;
  }

  async connect(): Promise<void> {
    const tokenFile = path.join(this.storeDir, 'telegram-token.txt');

    if (!fs.existsSync(tokenFile)) {
      const msg = 'Telegram bot token not found. Run npm run auth first.';
      this.logger.error(msg);
      exec(`osascript -e 'display notification "${msg}" with title "NanoClaw" sound name "Basso"'`);
      process.exit(1);
    }

    const token = fs.readFileSync(tokenFile, 'utf-8').trim();
    this.bot = new TelegramBot(token, { polling: true });

    // Set up message handler
    this.bot.on('message', async (msg) => {
      const chatJid = msg.chat.id.toString();
      if (!msg.text) return;

      const timestamp = new Date(msg.date * 1000).toISOString();

      // Always store chat metadata
      const chatName = msg.chat.type === 'private'
        ? `${msg.from?.first_name || ''} ${msg.from?.last_name || ''}`.trim() || msg.chat.username || chatJid
        : msg.chat.title || msg.chat.username || chatJid;
      storeChatMetadata(chatJid, timestamp, chatName);

      // Only store full message content for registered groups
      if (this.registeredGroups[chatJid] && msg.from) {
        storeTelegramMessage(msg, chatJid, false);
      }
    });

    this.bot.on('polling_error', (error) => {
      this.logger.error({ error }, 'Telegram polling error');
    });

    this.logger.info('Connected to Telegram');
  }

  async registerCommands(commands: Array<{ name: string; description: string }>): Promise<void> {
    if (!this.bot) {
      this.logger.warn('Cannot register commands: bot not connected');
      return;
    }

    try {
      // Transform to Telegram's expected format (command, description)
      const botCommands = commands.map(cmd => ({
        command: cmd.name,
        description: cmd.description
      }));

      this.logger.debug({ commands: botCommands }, 'Registering commands with Telegram');

      const result = await this.bot.setMyCommands(botCommands);
      this.logger.info({ count: botCommands.length, result }, 'Bot commands registered with Telegram');
    } catch (err) {
      this.logger.error({ err }, 'Failed to register bot commands');
    }
  }

  async sendMessage(chatId: string, text: string): Promise<void> {
    if (!this.bot) {
      this.logger.warn('Cannot send message: bot not connected');
      return;
    }

    try {
      await this.bot.sendMessage(chatId, text);
      this.logger.info({ chatId, length: text.length }, 'Message sent');
    } catch (err) {
      this.logger.error({ chatId, err }, 'Failed to send message');
    }
  }

  async sendOrUpdateStatusMessage(
    chatId: string,
    sessionId: string,
    text: string,
    isNew: boolean = false,
    replyToMessageId?: number
  ): Promise<void> {
    if (!this.bot) {
      this.logger.warn('Cannot send status message: bot not connected');
      return;
    }

    try {
      // Initialize nested records if they don't exist
      if (!this.statusMessageIds[chatId]) {
        this.statusMessageIds[chatId] = {};
      }
      if (!this.lastStatusMessage[chatId]) {
        this.lastStatusMessage[chatId] = {};
      }
      if (!this.accumulatedStatusMessages[chatId]) {
        this.accumulatedStatusMessages[chatId] = {};
      }

      if (isNew || !this.statusMessageIds[chatId][sessionId]) {
        // Send new status message, replying to original trigger message
        const msg = await this.bot.sendMessage(chatId, text, { reply_to_message_id: replyToMessageId });
        this.statusMessageIds[chatId][sessionId] = msg.message_id;
        this.accumulatedStatusMessages[chatId][sessionId] = text;
        this.logger.info({ chatId, sessionId, statusMessageId: msg.message_id }, 'Status message sent');
      } else {
        // Append new text to existing message with newline
        const accumulated = this.accumulatedStatusMessages[chatId][sessionId] || '';
        const updatedText = accumulated + '\n' + text;
        try {
          await this.bot.editMessageText(updatedText, {
            chat_id: chatId,
            message_id: this.statusMessageIds[chatId][sessionId]
          });
          this.accumulatedStatusMessages[chatId][sessionId] = updatedText;
          this.logger.debug({ chatId, sessionId, statusMessageId: this.statusMessageIds[chatId][sessionId] }, 'Status message updated');
        } catch (editErr) {
          // If edit fails (message too old, deleted, etc.), send new message
          const msg = await this.bot.sendMessage(chatId, updatedText);
          this.statusMessageIds[chatId][sessionId] = msg.message_id;
          this.accumulatedStatusMessages[chatId][sessionId] = updatedText;
          this.logger.info({ chatId, sessionId, statusMessageId: msg.message_id }, 'Status message: re-sent');
        }
      }
    } catch (err) {
      this.logger.error({ chatId, sessionId, err }, 'Failed to send/update status message');
    }
  }

  clearStatusMessage(chatId: string, sessionId?: string): void {
    if (sessionId) {
      // Clear status message for specific session
      if (this.statusMessageIds[chatId]) {
        delete this.statusMessageIds[chatId][sessionId];
      }
      if (this.lastStatusMessage[chatId]) {
        delete this.lastStatusMessage[chatId][sessionId];
      }
      if (this.accumulatedStatusMessages[chatId]) {
        delete this.accumulatedStatusMessages[chatId][sessionId];
      }
    } else {
      // Clear all status messages for the chat
      delete this.statusMessageIds[chatId];
      delete this.lastStatusMessage[chatId];
      delete this.accumulatedStatusMessages[chatId];
    }
  }

  startMessageListener(onMessage: (msg: NewMessage) => Promise<void>): void {
    this.onMessageCallback = onMessage;
  }

  getPollInterval(): number {
    return this.pollInterval;
  }

  needsPolling(): boolean {
    return true; // Telegram uses database polling
  }

  async start(): Promise<void> {
    await this.connect();
  }

  /**
   * Update registered groups reference
   */
  updateRegisteredGroups(registeredGroups: Record<string, RegisteredGroup>): void {
    this.registeredGroups = registeredGroups;
  }

  /**
   * Send startup greetings to main group
   */
  async sendStartupGreetings(registeredGroups: Record<string, RegisteredGroup>, mainGroupFolder: string): Promise<void> {
    const greetings = [
      "👋 Hi! I'm online and ready to help!",
      "🚀 NanoClaw is running - ask me anything!",
      "✨ Ready to assist! Just mention @Andy",
      "🤖 Online! What can I help you with?",
    ];

    // Find main session: either folder === mainGroupFolder OR isMainSession === true
    const mainEntry = Object.entries(registeredGroups).find(
      ([, group]) => group.folder === mainGroupFolder || group.isMainSession === true
    );

    if (!mainEntry) {
      this.logger.warn('No main group found to send startup greeting');
      return;
    }

    const mainChatId = mainEntry[0];
    const greeting = greetings[Math.floor(Math.random() * greetings.length)];

    try {
      await this.sendMessage(mainChatId, greeting);
      this.logger.info({ chatId: mainChatId, name: registeredGroups[mainChatId].name }, 'Startup greeting sent');
    } catch (err) {
      this.logger.error({ chatId: mainChatId, err }, 'Failed to send startup greeting');
    }
  }

  /**
   * Get current commands from Telegram API
   */
  async getMyCommands(): Promise<any[]> {
    if (!this.bot) {
      return [];
    }

    try {
      const commands = await this.bot.getMyCommands();
      return commands || [];
    } catch (err) {
      this.logger.error({ err }, 'Failed to get bot commands');
      return [];
    }
  }

  /**
   * Verify commands are registered correctly (runs once)
   */
  async verifyCommands(expectedCommands: Array<{ name: string; description: string }>): Promise<void> {
    const currentCommands = await this.getMyCommands();
    const expectedNames = expectedCommands.map(c => c.name).sort();
    const currentNames = currentCommands.map((c: any) => c.command).sort();

    if (JSON.stringify(expectedNames) !== JSON.stringify(currentNames)) {
      this.logger.warn({
        expected: expectedNames,
        current: currentNames,
      }, 'Commands mismatch detected, re-registering');
      await this.registerCommands(expectedCommands);
    } else {
      this.logger.info({
        commands: currentCommands,
      }, 'Commands verified on Telegram');
    }
  }
}
