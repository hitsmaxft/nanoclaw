# Claude Agent SDK Message Types Reference

## ⚠️ Key Discovery: Tool Progress Messages

**IMPORTANT**: Despite `SDKToolProgressMessage` being defined in the SDK types, **these messages are NOT emitted** during actual query execution.

**How to actually detect tool calls:**
- Look for `assistant` type messages
- Check the `message.content` array
- Filter for blocks with `type === 'tool_use'`
- Extract the `name` field from each tool_use block

See the [Detecting Tool Calls](#detecting-tool-calls) section for the working implementation.

## Overview

The Claude Agent SDK (`@anthropic-ai/claude-agent-sdk` v0.2.29) uses a streaming message-based system where the `query()` function yields messages of different types during execution.

## SDKMessage Union Type

```typescript
SDKMessage =
  | SDKAssistantMessage
  | SDKUserMessage
  | SDKUserMessageReplay
  | SDKResultMessage
  | SDKSystemMessage
  | SDKPartialAssistantMessage
  | SDKCompactBoundaryMessage
  | SDKStatusMessage
  | SDKHookStartedMessage
  | SDKHookProgressMessage
  | SDKHookResponseMessage
  | SDKToolProgressMessage
  | SDKAuthStatusMessage
  | SDKTaskNotificationMessage
  | SDKFilesPersistedEvent
  | SDKToolUseSummaryMessage
```

## Key Message Types for Status Updates

### 1. SDKSystemMessage (Session Initialization)

```typescript
{
  type: 'system',
  subtype: 'init',
  agents?: string[],
  apiKeySource: ApiKeySource,
  betas?: string[],
  claude_code_version: string,
  cwd: string,
  tools: string[],
  mcp_servers: {
    name: string;
    status: string;
  }[],
  model: string,
  permissionMode: PermissionMode,
  slash_commands: string[],
  output_style: string,
  skills: string[],
  uuid: UUID,
  session_id: string
}
```

**Usage**: Emitted when a new session starts. Contains `session_id` for continuity.

### 2. SDKAssistantMessage (Tool Calls in Content)

```typescript
{
  type: 'assistant',
  message: {
    id: string,
    role: 'assistant',
    content: [
      { type: 'text', text: 'I'll help you...' },
      { type: 'tool_use', name: 'Bash', input: { command: '...' } },
      { type: 'tool_use', name: 'Read', input: { file_path: '...' } }
    ],
    usage: { ... },
    // ... other fields
  },
  parent_tool_use_id: string | null,
  uuid: UUID,
  session_id: string
}
```

**Key Insight**: Tool calls are in `message.content` as blocks with `type: 'tool_use'`. This is the **ONLY reliable way** to detect when tools are being used.

### 3. SDKToolProgressMessage (NOT EMITTED)

```typescript
{
  type: 'tool_progress',
  tool_use_id: string,
  tool_name: string,
  parent_tool_use_id: string | null,
  elapsed_time_seconds: number,
  uuid: UUID,
  session_id: string
}
```

**⚠️ IMPORTANT**: Despite being in the type definitions, `tool_progress` messages are **NOT emitted** by the SDK in practice. Do not rely on them.

## Message Flow During Query

```
1. SDKSystemMessage (init)
   ↓
2. SDKAssistantMessage (with tool_use blocks in content)
   ↓
3. SDKPartialAssistantMessage (stream_event, optional)
   ↓
4. SDKResultMessage (success)
```

**Key Point**: Tool calls are detected in the `assistant` message's `content` array as `tool_use` blocks. There are NO intermediate `tool_progress` messages.

## Detecting Tool Calls

### The Only Reliable Method: From SDKAssistantMessage Content

**⚠️ IMPORTANT**: `tool_progress` messages are NOT emitted by the SDK despite being in type definitions. The ONLY way to detect tool calls is from `assistant` messages.

```typescript
if (message.type === 'assistant') {
  const content = message.message?.content;

  if (content && Array.isArray(content)) {
    // Filter for tool_use blocks
    const toolUses = content.filter((block) => block.type === 'tool_use');

    for (const toolUse of toolUses) {
      const toolName = toolUse.name;  // "Bash", "Read", etc.
      console.log('Tool:', toolName);
    }
  }
}
```

### Complete Working Example

```typescript
// Helper function to extract tool names
function getToolNames(message: any): string[] {
  if (message.type !== 'assistant') return [];

  const content = message.message?.content;
  if (!content || !Array.isArray(content)) return [];

  return content
    .filter((block) => block.type === 'tool_use')
    .map((block) => block.name);
}

// Usage in query loop
for await (const message of query({ ... })) {
  const toolNames = getToolNames(message);

  if (toolNames.length > 0) {
    if (toolNames.length === 1) {
      console.log(`Using: ${toolNames[0]}...`);
    } else {
      console.log(`Using ${toolNames.length} tools: ${toolNames.join(', ')}...`);
    }
  }

  if ('result' in message) {
    console.log('Result:', message.result);
  }
}
```

## Important Notes

1. **`tool_progress` messages are NOT emitted** - Despite being in the type definitions, they don't actually appear in the message stream
2. **Tool calls are ONLY in `assistant` messages** - Look for `type: 'tool_use'` blocks in `message.content` array
3. **Multiple tools can be batched** - One `assistant` message may contain multiple `tool_use` blocks
4. **Tool names may have prefixes** - Strip MCP prefixes like `mcp__nanoclaw__` for cleaner display
5. **Message streaming is async** - Use `for await` to iterate through messages
6. **Check array before filtering** - Always verify `content` is an array before calling `.filter()`

## Example: Handling Tool Status

```typescript
// Helper function
function getToolNames(message: any): string[] {
  if (message.type !== 'assistant') return [];
  const content = message.message?.content;
  if (!content || !Array.isArray(content)) return [];

  return content
    .filter((block) => block.type === 'tool_use')
    .map((block) => block.name);
}

// Main query loop
for await (const message of query({ ... })) {
  // Session initialization
  if (message.type === 'system' && message.subtype === 'init') {
    console.log('Session:', message.session_id);
  }

  // Tool calls (from assistant message content)
  const toolNames = getToolNames(message);
  if (toolNames.length > 0) {
    console.log('Tools:', toolNames);
  }

  // Final result
  if ('result' in message) {
    console.log('Result:', message.result);
    break;
  }
}
```

### Output Example

When Andy runs `sleep 5`:
```
Session: abc123
Tools: ['Bash']
Result: Command completed successfully.
```

When Andy reads multiple files:
```
Session: abc123
Tools: ['Read', 'Read', 'Grep']
Result: Found 3 occurrences...
```

## Common Tool Names

- `Bash` - Execute shell commands
- `Read` - Read file contents
- `Write` - Write new files
- `Edit` - Edit existing files
- `Glob` - Find files by pattern
- `Grep` - Search file contents
- `WebSearch` - Search the web
- `WebFetch` - Fetch web content
- `mcp__nanoclaw__*` - Custom NanoClaw tools

## Type Reference Location

Full definitions: `/app/node_modules/@anthropic-ai/claude-agent-sdk/sdk.d.ts` (in container)
