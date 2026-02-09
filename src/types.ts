export interface AdditionalMount {
  hostPath: string; // Absolute path on host (supports ~ for home)
  containerPath: string; // Path inside container (under /workspace/extra/)
  readonly?: boolean; // Default: true for safety
}

/**
 * Mount Allowlist - Security configuration for additional mounts
 * This file should be stored at ~/.config/nanoclaw/mount-allowlist.json
 * and is NOT mounted into any container, making it tamper-proof from agents.
 */
export interface MountAllowlist {
  // Directories that can be mounted into containers
  allowedRoots: AllowedRoot[];
  // Glob patterns for paths that should never be mounted (e.g., ".ssh", ".gnupg")
  blockedPatterns: string[];
  // If true, non-main groups can only mount read-only regardless of config
  nonMainReadOnly: boolean;
}

export interface AllowedRoot {
  // Absolute path or ~ for home (e.g., "~/projects", "/var/repos")
  path: string;
  // Whether read-write mounts are allowed under this root
  allowReadWrite: boolean;
  // Optional description for documentation
  description?: string;
}

export interface ContainerConfig {
  additionalMounts?: AdditionalMount[];
  timeout?: number; // Default: 300000 (5 minutes)
}

export interface RegisteredGroup {
  name: string;
  folder: string;
  trigger: string;
  added_at: string;
  containerConfig?: ContainerConfig;
  requiresTrigger?: boolean; // Default: true for groups, false for solo chats
  allowedUsers?: string[]; // For private chats: restrict to specific sender IDs
  isMainSession?: boolean; // True if this is the main session (first p2p chat registered)
}

export interface NewMessage {
  id: string;
  chat_jid: string;
  sender: string;
  sender_name: string;
  content: string;
  timestamp: string;
  chat_type?: 'private' | 'group'; // Private chat vs group chat
}

export interface ScheduledTask {
  id: string;
  group_folder: string;
  chat_jid: string;
  prompt: string;
  schedule_type: 'cron' | 'interval' | 'once';
  schedule_value: string;
  context_mode: 'group' | 'isolated';
  next_run: string | null;
  last_run: string | null;
  last_result: string | null;
  status: 'active' | 'paused' | 'completed';
  created_at: string;
}

export interface TaskRunLog {
  task_id: string;
  run_at: string;
  duration_ms: number;
  status: 'success' | 'error';
  result: string | null;
  error: string | null;
}

/**
 * Messenger Interface - abstraction for different messaging platforms
 * Allows NanoClaw to work with Telegram, WhatsApp, Slack, etc.
 */
export interface Messenger {
  /**
   * Initialize messenger and connect to service
   */
  connect(): Promise<void>;

  /**
   * Register slash commands for discoverability
   */
  registerCommands(commands: Array<{ name: string; description: string }>): Promise<void>;

  /**
   * Send a text message to a chat
   */
  sendMessage(chatId: string, text: string): Promise<void>;

  /**
   * Send or update a status message with edit support
   */
  sendOrUpdateStatusMessage(chatId: string, sessionId: string, text: string, isNew: boolean, replyToMessageId?: string | number | undefined): Promise<void>;

  /**
   * Clear status message tracking for a chat or session
   */
  clearStatusMessage(chatId: string, sessionId?: string): void;

  /**
   * Start listening for incoming messages
   * @param onMessage Callback for handling new messages
   */
  startMessageListener(onMessage: (msg: NewMessage) => Promise<void>): void;

  /**
   * Get polling interval for checking new messages from database
   */
  getPollInterval(): number;

  /**
   * Whether this messenger requires database polling for messages
   * Returns false for WebSocket-based messengers (Feishu)
   * Returns true for polling-based messengers (Telegram)
   */
  needsPolling(): boolean;

  /**
   * Start messenger service
   */
  start(): Promise<void>;

  /**
   * Send startup greetings to registered groups
   */
  sendStartupGreetings(registeredGroups: Record<string, RegisteredGroup>, mainGroupFolder: string): Promise<void>;
}
