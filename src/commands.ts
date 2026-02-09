/**
 * Command Parser and Handlers for NanoClaw
 * Handles special commands like /help, /new, /reset
 */

export interface Command {
  name: string;
  description: string;
  handler: CommandHandler;
}

export interface CommandContext {
  chatId: string;
  groupName: string;
  groupFolder: string;
  content: string;
  timestamp: string;
}

export interface CommandResult {
  handled: boolean;
  response?: string;
  shouldResetSession?: boolean;
}

export type CommandHandler = (context: CommandContext) => Promise<CommandResult>;

/**
 * Built-in commands
 */
export const commands: Command[] = [
  {
    name: 'help',
    description: 'Show all available commands',
    handler: handleHelp,
  },
  {
    name: 'new',
    description: 'Start a new conversation session (reset context)',
    handler: handleNew,
  },
  {
    name: 'register',
    description: 'Register current chat as workspace (Feishu only)',
    handler: handleRegister,
  },
];

/**
 * Parse a message to check if it's a command
 */
export function parseCommand(content: string, trigger: string): { isCommand: boolean; command?: Command; args?: string } {
  const trimmed = content.trim();

  // Check for /command format
  const cmdMatch = trimmed.match(/^\/(\w+)(?:\s+(.+))?$/);
  if (cmdMatch) {
    const cmdName = cmdMatch[1].toLowerCase();
    const args = cmdMatch[2];
    const command = commands.find(c => c.name === cmdName);
    return { isCommand: !!command, command, args };
  }

  return { isCommand: false };
}

/**
 * Handle /help command
 */
async function handleHelp(context: CommandContext): Promise<CommandResult> {
  const helpText = `📚 **Available Commands**

${commands.map(c => `**/${c.name}** - ${c.description}`).join('\n')}

💡 **Tips**
- Start with trigger word to have AI process
- Commands start with /
- Current session context is auto-saved
`;

  return { handled: true, response: helpText };
}

/**
 * Handle /new command - start fresh session
 */
async function handleNew(context: CommandContext): Promise<CommandResult> {
  return {
    handled: true,
    response: `✅ **New Session Started**

Previous context cleared. This is a fresh conversation.`,
    shouldResetSession: true,
  };
}

/**
 * Handle /register command - for Feishu self-registration
 * Note: For unregistered chats, this is handled in index.ts
 * This handler is for when /register is sent in an already registered group
 */
async function handleRegister(context: CommandContext): Promise<CommandResult> {
  // Import is not possible here due to circular dependency
  // This handler is for when /register is sent in an already registered group
  return {
    handled: true,
    response: `✅ Current Workspace Info:

Name: **${context.groupName}**
Folder: ${context.groupFolder}

Contact admin to re-register.`,
  };
}

/**
 * Check if content is a command and execute it
 */
export async function executeCommand(
  content: string,
  trigger: string,
  context: CommandContext
): Promise<CommandResult> {
  const { isCommand, command, args } = parseCommand(content, trigger);

  if (!isCommand || !command) {
    return { handled: false };
  }

  try {
    return await command.handler({ ...context, content: args || '' });
  } catch (error) {
    return {
      handled: true,
      response: `❌ **Command Error**: ${error instanceof Error ? error.message : String(error)}`,
    };
  }
}
