// === Token Usage ===

export interface TokenUsage {
  input_tokens: number;
  output_tokens: number;
  cache_read_input_tokens?: number;
  cache_creation_input_tokens?: number;
}

// === Session ===

export interface Session {
  threadId: number;             // Telegram forum topic message_thread_id
  chatId: number;               // Telegram chat_id
  userId: number;               // Telegram user_id
  claudeSessionId: string | null; // Claude Code session UUID (null until first response)
  projectPath: string;          // Absolute path — used as cwd for claude process
  name: string;                 // Human-readable topic name
  createdAt: string;            // ISO timestamp
  lastActiveAt: string;         // ISO timestamp
  totalUsage: TokenUsage;       // Cumulative token usage
  totalDurationMs: number;      // Cumulative API duration
  totalTurns: number;           // Cumulative turns
  verbosity?: number;           // 1 = hide tools, 2 = show tools (default)
}

// === Claude CLI Events ===

export interface ClaudeSystemEvent {
  type: "system";
  subtype: "init";
  session_id: string;
  tools: unknown[];
  model: string;
}

export interface ClaudeAssistantEvent {
  type: "assistant";
  message: {
    content: AssistantContentBlock[];
  };
  session_id: string;
}

export interface ClaudeUserEvent {
  type: "user";
  message: {
    content: UserContentBlock[];
  };
  session_id: string;
}

export interface ClaudeResultEvent {
  type: "result";
  subtype: "success" | "error";
  session_id: string;
  cost_usd: number;
  duration_ms: number;
  duration_api_ms: number;
  num_turns: number;
  result?: string;
  is_error?: boolean;
}

export interface ClaudeStreamEvent {
  type: "content_block_delta" | "content_block_start" | "content_block_stop" | "message_start" | "message_delta" | "message_stop";
  index?: number;
  delta?: {
    type: string;
    text?: string;
  };
  content_block?: {
    type: string;
    id?: string;
    name?: string;
    input?: string;
    text?: string;
  };
}

export type ClaudeEvent =
  | ClaudeSystemEvent
  | ClaudeAssistantEvent
  | ClaudeUserEvent
  | ClaudeResultEvent
  | ClaudeStreamEvent;

// === Content Blocks ===

export interface TextBlock {
  type: "text";
  text: string;
}

export interface ToolUseBlock {
  type: "tool_use";
  id: string;
  name: string;
  input: Record<string, unknown>;
}

export interface ToolResultBlock {
  type: "tool_result";
  tool_use_id: string;
  content: string | Array<{ type: string; text?: string }>;
  is_error?: boolean;
}

export type AssistantContentBlock = TextBlock | ToolUseBlock;
export type UserContentBlock = ToolResultBlock | TextBlock;

// === Claude Result ===

export interface ClaudeResult {
  sessionId: string;
  costUsd: number;
  durationMs: number;
  numTurns: number;
  usage: TokenUsage;
  result?: string;
  isError?: boolean;
}

// === AskUserQuestion ===

export interface AskUserQuestionOption {
  label: string;
  description?: string;
}

export interface AskUserQuestionItem {
  question: string;
  header?: string;
  options: AskUserQuestionOption[];
  multiSelect?: boolean;
}

export interface AskUserQuestionInput {
  questions: AskUserQuestionItem[];
}

// === Runner Callbacks ===

export interface RunnerCallbacks {
  onSessionId: (sessionId: string) => void;
  onText: (text: string) => void;
  onToolUse: (name: string, input: Record<string, unknown>) => void;
  onToolResult: (name: string, isError: boolean) => void;
  onQuestion: (toolUseId: string, input: AskUserQuestionInput) => void;
  onError: (error: string) => void;
}
