/**
 * Feishu (Lark) Messenger Implementation
 * Handles Feishu bot communication and implements the Messenger interface
 */

import * as Lark from '@larksuiteoapi/node-sdk';
import pino from 'pino';
import fs from 'fs';
import path from 'path';
import { exec } from 'child_process';
import { Messenger, NewMessage, RegisteredGroup } from './types.js';
import { storeMessage, storeChatMetadata, storeFeishuMessageEvent, FeishuMessage, FeishuSender } from './db.js';

interface FeishuCredentials {
  appId: string;
  appSecret: string;
  encryptKey?: string;
  verificationToken?: string;
}

interface FeishuMessageEvent {
  event_id?: string;  // Unique event ID for deduplication
  sender: {
    sender_id: {
      open_id?: string;
      user_id?: string;
      union_id?: string;
    };
    sender_type?: string;
    tenant_key?: string;
  };
  message: {
    message_id: string;
    root_id?: string;
    parent_id?: string;
    chat_id: string;
    chat_type: 'p2p' | 'group';
    message_type: string;
    content: string;
    create_time?: string;
    mentions?: Array<{
      key: string;
      id: {
        open_id?: string;
        user_id?: string;
        union_id?: string;
      };
      name: string;
      tenant_key?: string;
    }>;
  };
}

export class FeishuMessenger implements Messenger {
  private client: Lark.Client | null = null;
  private wsClient: Lark.WSClient | null = null;
  private eventDispatcher: Lark.EventDispatcher | null = null;
  private logger: pino.Logger;
  private storeDir: string;
  private registeredGroups: Record<string, RegisteredGroup>;
  private onMessageCallback?: (msg: NewMessage) => Promise<void>;
  private pollInterval: number;
  private credentials: FeishuCredentials | null = null;
  private botOpenId: string | null = null;

  // Track status message IDs for editing by chatId and sessionId
  private statusMessageIds: Record<string, Record<string, string>> = {}; // chatId -> sessionId -> messageId
  private accumulatedStatusMessages: Record<string, Record<string, string>> = {}; // chatId -> sessionId -> accumulatedText

  // Track processed message IDs to avoid duplicates
  private processedMessageIds: Set<string> = new Set();

  constructor(
    logger: pino.Logger,
    storeDir: string,
    registeredGroups: Record<string, RegisteredGroup>,
    pollInterval: number
  ) {
    this.logger = logger.child({ messenger: 'feishu' });
    this.storeDir = storeDir;
    this.registeredGroups = registeredGroups;
    this.pollInterval = pollInterval;
  }

  async connect(): Promise<void> {
    const credsPath = path.join(this.storeDir, 'feishu-credentials.json');

    if (!fs.existsSync(credsPath)) {
      const msg = 'Feishu credentials not found. Run npm run auth:feishu first.';
      this.logger.error(msg);
      exec(`osascript -e 'display notification "${msg}" with title "NanoClaw" sound name "Basso"'`);
      process.exit(1);
    }

    try {
      this.credentials = JSON.parse(fs.readFileSync(credsPath, 'utf-8'));
    } catch (err) {
      this.logger.error({ err }, 'Failed to parse Feishu credentials');
      throw new Error('Invalid Feishu credentials file');
    }

    if (!this.credentials?.appId || !this.credentials?.appSecret) {
      throw new Error('Feishu credentials missing appId or appSecret');
    }

    // Create REST client
    this.client = new Lark.Client({
      appId: this.credentials.appId,
      appSecret: this.credentials.appSecret,
      appType: Lark.AppType.SelfBuild,
    });

    // Verify connection and get bot info using raw request
    try {
      const response = await (this.client as any).request({
        method: 'GET',
        url: '/open-apis/bot/v3/info',
      });
      if (response.code === 0 && response.bot) {
        this.botOpenId = response.bot.open_id || null;
        this.logger.info({ botName: response.bot.bot_name, botOpenId: this.botOpenId }, 'Connected to Feishu');
      }
    } catch (err) {
      this.logger.error({ err }, 'Failed to verify Feishu connection');
      throw err;
    }

    // Set up WebSocket client
    await this.setupWebSocket();
  }

  private async setupWebSocket(): Promise<void> {
    if (!this.credentials) return;

    this.wsClient = new Lark.WSClient({
      appId: this.credentials.appId,
      appSecret: this.credentials.appSecret,
      loggerLevel: Lark.LoggerLevel.info,
    });

    this.eventDispatcher = new Lark.EventDispatcher({
      encryptKey: this.credentials.encryptKey,
      verificationToken: this.credentials.verificationToken,
    });

    // Register event handlers
    this.eventDispatcher.register({
      'im.message.receive_v1': async (data) => {
        this.logger.info({ data }, 'Received im.message.receive_v1 event');
        try {
          await this.handleMessageEvent(data as unknown as FeishuMessageEvent);
        } catch (err) {
          this.logger.error({ err }, 'Error handling Feishu message');
        }
      },
      'im.message.message_read_v1': async (data) => {
        this.logger.debug({ data }, 'Received message_read event');
        // Ignore read receipts
      },
      'im.chat.member.bot.added_v1': async (data) => {
        const event = data as unknown as { chat_id: string };
        this.logger.info({ chatId: event.chat_id }, 'Bot added to chat');
      },
      'im.chat.member.bot.deleted_v1': async (data) => {
        const event = data as unknown as { chat_id: string };
        this.logger.info({ chatId: event.chat_id }, 'Bot removed from chat');
      },
    });

    // Start WebSocket connection
    return new Promise((resolve, reject) => {
      try {
        this.wsClient!.start({ eventDispatcher: this.eventDispatcher! });
        this.logger.info('Feishu WebSocket client started');
        resolve();
      } catch (err) {
        reject(err);
      }
    });
  }

  private async handleMessageEvent(event: FeishuMessageEvent): Promise<void> {
    const messageId = event.message.message_id;
    const chatId = event.message.chat_id;
    const senderOpenId = event.sender.sender_id.open_id;
    const senderUserId = event.sender.sender_id.user_id;

    this.logger.info({
      eventId: event.event_id,
      messageId,
      chatId,
      senderOpenId,
      senderUserId,
      botOpenId: this.botOpenId,
      isBotMessage: senderOpenId === this.botOpenId || senderUserId === this.botOpenId
    }, 'Received Feishu message event');

    // Skip messages from bot itself
    if (senderOpenId === this.botOpenId || senderUserId === this.botOpenId) {
      this.logger.info({ senderOpenId, botOpenId: this.botOpenId }, 'Bot message, skipping');
      return;
    }

    // Skip if chat_id is not valid Feishu format (sanity check)
    if (!chatId.startsWith('oc_') && !chatId.startsWith('ou_')) {
      this.logger.warn({ chatId }, 'Invalid Feishu chat_id format, skipping');
      return;
    }

    const messageType = event.message.message_type;
    const chatType = event.message.chat_type === 'p2p' ? 'private' : 'group';
    const timestamp = event.message.create_time
      ? new Date(parseInt(event.message.create_time, 10)).toISOString()
      : new Date().toISOString();

    // Resolve sender name (senderUserId already defined above)
    const senderName = await this.resolveSenderName(senderOpenId || '');

    // Parse message content based on type
    const { content, mediaInfo } = this.parseMessageContent(event.message.content, messageType);

    // Get chat name
    const chatName = await this.getChatName(chatId);
    storeChatMetadata(chatId, timestamp, chatName);

    // Store message for registered groups
    if (this.registeredGroups[chatId]) {
      storeFeishuMessageEvent(
        { message: event.message as FeishuMessage, sender: event.sender as FeishuSender },
        chatId,
        false,
        senderName
      );
    }

    // Call the message listener callback
    if (this.onMessageCallback) {
      this.logger.info({
        messageId: event.message.message_id,
        chatId,
        sender: senderOpenId, // Always use open_id for Feishu
        senderName,
        content: mediaInfo ? `${content} ${mediaInfo}` : content,
        timestamp,
        chatType,
      }, 'Calling onMessageCallback');
      await this.onMessageCallback({
        id: event.message.message_id,
        chat_jid: chatId,
        sender: senderOpenId || 'unknown', // Always use open_id for Feishu
        sender_name: senderName,
        content: mediaInfo ? `${content} ${mediaInfo}` : content,
        timestamp,
        chat_type: chatType,
      });
    }
  }

  private parseMessageContent(content: string, messageType: string): { content: string; mediaInfo?: string } {
    try {
      const parsed = JSON.parse(content);

      switch (messageType) {
        case 'text':
          return { content: parsed.text || '' };

        case 'post':
          return { content: this.parsePostContent(parsed) };

        case 'image':
          return { content: '<media:image>', mediaInfo: `[Image: ${parsed.image_key || 'unknown'}]` };

        case 'file':
          return { content: '<media:document>', mediaInfo: `[File: ${parsed.file_name || parsed.file_key || 'unknown'}]` };

        case 'audio':
          return { content: '<media:audio>', mediaInfo: `[Audio: ${parsed.file_key || 'unknown'}]` };

        case 'video':
          return { content: '<media:video>', mediaInfo: `[Video: ${parsed.file_key || 'unknown'}]` };

        case 'sticker':
          return { content: '<media:sticker>', mediaInfo: `[Sticker: ${parsed.file_key || 'unknown'}]` };

        default:
          return { content: `[${messageType}]` };
      }
    } catch {
      return { content };
    }
  }

  private parsePostContent(parsed: any): string {
    // Parse rich text post content
    const title = parsed.title || '';
    const contentBlocks = parsed.content || [];
    let textContent = title ? `${title}\n\n` : '';

    for (const paragraph of contentBlocks) {
      if (Array.isArray(paragraph)) {
        for (const element of paragraph) {
          if (element.tag === 'text') {
            textContent += element.text || '';
          } else if (element.tag === 'a') {
            textContent += element.text || element.href || '';
          } else if (element.tag === 'at') {
            textContent += `@${element.user_name || element.user_id || ''}`;
          } else if (element.tag === 'img') {
            textContent += '<media:image>';
          }
        }
        textContent += '\n';
      }
    }

    return textContent.trim() || '[Rich Text Message]';
  }

  private async resolveSenderName(openId: string): Promise<string> {
    if (!this.client || !openId) return 'Unknown';

    try {
      const res = await this.client.contact.user.get({
        path: { user_id: openId },
        params: { user_id_type: 'open_id' },
      });

      const user = res.data?.user;
      if (user) {
        return user.name || user.en_name || openId;
      }
    } catch {
      // Best effort - fall back to openId
    }

    return openId;
  }

  private async getChatName(chatId: string): Promise<string> {
    if (!this.client) return chatId;

    try {
      const res = await this.client.im.chat.get({
        path: { chat_id: chatId },
      });

      return res.data?.name || chatId;
    } catch {
      return chatId;
    }
  }

  async registerCommands(): Promise<void> {
    // Feishu doesn't have a direct equivalent to Telegram's bot commands
    this.logger.info('Feishu does not support native slash command registration');
  }

  async sendMessage(chatId: string, text: string): Promise<void> {
    if (!this.client) {
      this.logger.warn('Cannot send message: client not connected');
      return;
    }

    // Validate Feishu chat_id format
    if (!chatId.startsWith('oc_') && !chatId.startsWith('ou_')) {
      this.logger.warn({ chatId }, 'Invalid Feishu chat_id format, skipping send');
      return;
    }

    try {
      // Determine receive_id_type based on chat_id format
      // oc_xxxxxx = group chat, ou_xxxxxx = user (open_id for DM)
      const receiveIdType = chatId.startsWith('oc_') ? 'chat_id' : 'open_id';

      // Build post message payload for rich text support
      const content = JSON.stringify({
        zh_cn: {
          content: [[{ tag: 'md', text: text }]],
        },
      });

      const response = await this.client.im.message.create({
        params: { receive_id_type: receiveIdType },
        data: {
          receive_id: chatId,
          content,
          msg_type: 'post',
        },
      });

      if (response.code !== 0) {
        throw new Error(`Feishu send failed: ${response.msg || `code ${response.code}`}`);
      }

      this.logger.info({ chatId, receiveIdType, messageId: response.data?.message_id }, 'Message sent');
    } catch (err) {
      this.logger.error({ chatId, err }, 'Failed to send message');
    }
  }

  async sendOrUpdateStatusMessage(
    chatId: string,
    sessionId: string,
    text: string,
    isNew: boolean = false,
    replyToMessageId?: string | number | undefined
  ): Promise<void> {
    if (!this.client) {
      this.logger.warn('Cannot send status message: client not connected');
      return;
    }

    try {
      // Determine receive_id_type based on chat_id format
      const receiveIdType = chatId.startsWith('oc_') ? 'chat_id' : 'open_id';

      // Initialize nested records if they don't exist
      if (!this.statusMessageIds[chatId]) {
        this.statusMessageIds[chatId] = {};
      }
      if (!this.accumulatedStatusMessages[chatId]) {
        this.accumulatedStatusMessages[chatId] = {};
      }

      // Feishu uses interactive_card for updatable status messages
      // Accumulate status text with line breaks
      const accumulated = this.accumulatedStatusMessages[chatId][sessionId] || '';
      const updatedText = accumulated ? accumulated + '\n' + text : text;

      this.logger.info({ chatId, sessionId, accumulated, text, updatedText }, 'Accumulating status');

      // Build interactive card message
      const card = {
        config: { wide_screen_mode: true },
        header: {
          template: 'blue',
          title: {
            tag: 'plain_text',
            content: '⏳ Processing...',
          },
        },
        elements: [
          {
            tag: 'div',
            text: {
              tag: 'lark_md',
              content: updatedText,
            },
          },
        ],
      };

      const content = JSON.stringify(card);

      if (isNew || !this.statusMessageIds[chatId][sessionId]) {
        // Send new card message
        let response;
        if (replyToMessageId && typeof replyToMessageId === 'string') {
          // Reply to the original message
          response = await this.client.im.message.reply({
            path: { message_id: replyToMessageId },
            data: {
              content,
              msg_type: 'interactive',
            },
          });
        } else {
          // Send as new message
          response = await this.client.im.message.create({
            params: { receive_id_type: receiveIdType },
            data: {
              receive_id: chatId,
              content,
              msg_type: 'interactive',
            },
          });
        }

        if (response.code !== 0) {
          throw new Error(`Feishu status send failed: ${response.msg || `code ${response.code}`}`);
        }

        this.statusMessageIds[chatId][sessionId] = response.data?.message_id || '';
        this.accumulatedStatusMessages[chatId][sessionId] = updatedText;
        this.logger.info({ chatId, sessionId, messageId: response.data?.message_id }, 'Status card sent');
      } else {
        // Update existing card message using patch
        const messageId = this.statusMessageIds[chatId][sessionId];

        const response = await this.client.im.message.patch({
          path: { message_id: messageId },
          data: { content },
        });

        if (response.code !== 0) {
          // If patch fails (message too old, etc.), send a new card
          this.logger.warn({ chatId, sessionId, error: response.msg }, 'Failed to patch card, sending new');

          const newResponse = await this.client.im.message.create({
            params: { receive_id_type: receiveIdType },
            data: {
              receive_id: chatId,
              content,
              msg_type: 'interactive',
            },
          });

          if (newResponse.code === 0) {
            this.statusMessageIds[chatId][sessionId] = newResponse.data?.message_id || '';
            this.accumulatedStatusMessages[chatId][sessionId] = updatedText;
          }
        } else {
          this.accumulatedStatusMessages[chatId][sessionId] = updatedText;
          this.logger.debug({ chatId, sessionId, messageId }, 'Status card updated');
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
      if (this.accumulatedStatusMessages[chatId]) {
        delete this.accumulatedStatusMessages[chatId][sessionId];
      }
    } else {
      // Clear all status messages for the chat
      delete this.statusMessageIds[chatId];
      delete this.accumulatedStatusMessages[chatId];
    }
  }

  /**
   * Set callback for handling new messages
   * Feishu detects commands (register, help, new) and adds '/' prefix for main flow
   */
  startMessageListener(onMessage: (msg: NewMessage) => Promise<void>): void {
    this.onMessageCallback = async (msg) => {
      // Feishu doesn't support native slash commands
      // Convert recognized commands to standard format with '/' prefix
      const content = msg.content.trim();
      const lowerContent = content.toLowerCase();

      // Convert recognized commands to slash format
      if (lowerContent === 'register' || lowerContent.startsWith('register ')) {
        msg.content = '/' + content;
      } else if (lowerContent === 'help') {
        msg.content = '/help';
      } else if (lowerContent === 'new') {
        msg.content = '/new';
      }

      // Pass to main callback
      await onMessage(msg);
    };
    this.logger.info('Feishu message listener registered');
  }

  getPollInterval(): number {
    return this.pollInterval;
  }

  needsPolling(): boolean {
    return false; // Feishu uses WebSocket, no polling needed
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
      "✨ Ready to assist! Just mention me in a group or send a DM!",
      "🤖 Online! What can I help you with?",
    ];

    // Find main session: either folder === mainGroupFolder OR isMainSession === true
    // And has valid Feishu chat_id format (oc_xxxxxx for group, ou_xxxxxx for user)
    const mainEntry = Object.entries(registeredGroups).find(
      ([jid, group]) =>
        (group.folder === mainGroupFolder || group.isMainSession === true) &&
        (jid.startsWith('oc_') || jid.startsWith('ou_'))
    );

    // Filter to groups with valid Feishu chat_id format
    const validGroups = Object.entries(registeredGroups).filter(
      ([jid]) => jid.startsWith('oc_') || jid.startsWith('ou_')
    );

    if (!mainEntry && validGroups.length === 0) {
      this.logger.info('No Feishu registered groups found. Use /register to register a Feishu chat.');
      return;
    }

    const mainChatId = mainEntry?.[0];
    if (!mainChatId) {
      this.logger.info('No main session found for Feishu. Startup greeting skipped.');
      return;
    }

    const greeting = greetings[Math.floor(Math.random() * greetings.length)];

    try {
      await this.sendMessage(mainChatId, greeting);
      this.logger.info({ chatId: mainChatId, name: registeredGroups[mainChatId].name }, 'Startup greeting sent');
    } catch (err) {
      this.logger.error({ chatId: mainChatId, err }, 'Failed to send startup greeting');
    }
  }
}
