// === Core Config ===

export interface CoreConfig {
  allowedPaths: string[];
  dataDir: string;
  maxTurnsPerMessage?: number;
  maxBudgetPerMessage?: number;
}

// === Token Usage ===

export interface TokenUsage {
  input_tokens: number;
  output_tokens: number;
  cache_read_input_tokens?: number;
  cache_creation_input_tokens?: number;
}

// === Session ===

export interface Session {
  // --- Identity (3 levels) ---
  id: string;                    // Unique session ID (crypto.randomUUID())
  threadId: string;              // Channel-specific thread/conversation identifier
  channel: string;               // "telegram" | "cli" | ...

  // --- Agent state ---
  agentSessionId: string | null;  // Agent session ID for resume (null until first response)
  projectPath: string;           // Absolute path — used as cwd for claude process
  name: string;                  // Human-readable session name
  createdAt: string;             // ISO timestamp
  lastActiveAt: string;          // ISO timestamp
  totalUsage: TokenUsage;        // Cumulative token usage
  totalDurationMs: number;       // Cumulative API duration
  totalTurns: number;            // Cumulative turns
  verbosity?: number;            // 1 = hide tools, 2 = show tools (default)

  // --- Channel-specific metadata (opaque to core) ---
  channelMeta?: Record<string, unknown>;
}

// === Channel Message Protocol ===

/**
 * Discriminated union for all messages flowing through a MessageChannel.
 *
 * Both directions use the same type.  The `type` field identifies purpose:
 *
 *   Transport → Orchestrator:  "user"
 *   Orchestrator → Transport:  "assistant", "tool_call", "tool_result",
 *                               "text", "question", "done"
 */
export type ChannelMessage =
  | { type: "user"; text: string }
  | { type: "assistant"; text: string }
  | { type: "tool_call"; name: string; input: Record<string, unknown> }
  | { type: "tool_result"; name: string; isError: boolean }
  | { type: "text"; text: string; subtype: "notice" | "error" }
  | { type: "question"; question: AskUserQuestionInput }
  | { type: "done" };

/** One end of a MessageChannel.  send() pushes to the other end's queue. */
export interface ChannelEndpoint {
  send(threadId: string, message: ChannelMessage): void;
  receive(): Promise<{ threadId: string; message: ChannelMessage }>;
}

/**
 * Bidirectional async message pipe.
 *
 * `createMessageChannel()` returns two endpoints.  When one end calls
 * `send()`, the other end gets the message from `receive()`.
 *
 * Both the transport (Telegram, CLI) and the orchestrator each hold
 * one endpoint.  Neither knows about the other — they just send and
 * receive on their end.
 */
export function createMessageChannel(): [ChannelEndpoint, ChannelEndpoint] {
  type Item = { threadId: string; message: ChannelMessage };

  function makeQueue() {
    const queue: Item[] = [];
    let waiter: ((item: Item) => void) | null = null;

    return {
      push(item: Item): void {
        if (waiter) {
          const resolve = waiter;
          waiter = null;
          resolve(item);
        } else {
          queue.push(item);
        }
      },
      pull(): Promise<Item> {
        const queued = queue.shift();
        if (queued) return Promise.resolve(queued);
        return new Promise((resolve) => {
          waiter = resolve;
        });
      },
    };
  }

  // Two queues — one per direction
  const aToB = makeQueue(); // endpoint A sends → endpoint B receives
  const bToA = makeQueue(); // endpoint B sends → endpoint A receives

  const endpointA: ChannelEndpoint = {
    send: (threadId, message) => aToB.push({ threadId, message }),
    receive: () => bToA.pull(),
  };

  const endpointB: ChannelEndpoint = {
    send: (threadId, message) => bToA.push({ threadId, message }),
    receive: () => aToB.pull(),
  };

  return [endpointA, endpointB];
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
