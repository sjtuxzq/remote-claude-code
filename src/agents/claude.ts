import { spawn, execSync, type ChildProcess } from "node:child_process";
import type { Agent, AgentRequest, AgentResult } from "../core/agent.js";
import type { TokenUsage, AskUserQuestionInput } from "../core/types.js";

// === Claude-specific types ===

interface ClaudeSystemEvent {
  type: "system";
  subtype: "init";
  session_id: string;
  tools: unknown[];
  model: string;
}

interface ClaudeAssistantEvent {
  type: "assistant";
  message: {
    content: AssistantContentBlock[];
  };
  session_id: string;
}

interface ClaudeUserEvent {
  type: "user";
  message: {
    content: UserContentBlock[];
  };
  session_id: string;
}

interface ClaudeResultEvent {
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

interface ClaudeStreamEvent {
  type:
    | "content_block_delta"
    | "content_block_start"
    | "content_block_stop"
    | "message_start"
    | "message_delta"
    | "message_stop";
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

interface TextBlock {
  type: "text";
  text: string;
}

interface ToolUseBlock {
  type: "tool_use";
  id: string;
  name: string;
  input: Record<string, unknown>;
}

interface ToolResultBlock {
  type: "tool_result";
  tool_use_id: string;
  content: string | Array<{ type: string; text?: string }>;
  is_error?: boolean;
}

type AssistantContentBlock = TextBlock | ToolUseBlock;
type UserContentBlock = ToolResultBlock | TextBlock;

interface RunnerCallbacks {
  onSessionId: (sessionId: string) => void;
  onText: (text: string) => void;
  onToolUse: (name: string, input: Record<string, unknown>) => void;
  onToolResult: (name: string, isError: boolean) => void;
  onQuestion: (toolUseId: string, input: AskUserQuestionInput) => void;
  onError: (error: string) => void;
}

interface ClaudeResult {
  sessionId: string;
  costUsd: number;
  durationMs: number;
  numTurns: number;
  usage: TokenUsage;
  result?: string;
  isError?: boolean;
}

// === Resolve claude path once at startup ===

let claudePath: string;
try {
  claudePath = execSync(
    process.platform === "win32" ? "where claude" : "which claude",
    { encoding: "utf-8", windowsHide: true }
  )
    .trim()
    .split("\n")[0];
  console.log(`[claude-agent] Resolved claude path: ${claudePath}`);
} catch {
  console.error("[claude-agent] Could not find claude in PATH");
  claudePath = "claude";
}

// === Runner (process spawner) ===

function runClaude(
  args: string[],
  cwd: string,
  callbacks: RunnerCallbacks
): { promise: Promise<ClaudeResult | null>; process: ChildProcess } {
  console.log(`[claude-agent] Spawning: ${claudePath} ${args.join(" ")}`);

  // Clean env: remove CLAUDECODE to avoid "nested session" error
  const cleanEnv = { ...process.env };
  delete cleanEnv.CLAUDECODE;

  const proc = spawn(claudePath, args, {
    cwd,
    env: cleanEnv,
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: true,
  });

  console.log(`[claude-agent] Spawned claude (pid ${proc.pid}) in ${cwd}`);

  let buffer = "";
  let result: ClaudeResult | null = null;
  let streamedTextLength = 0;
  let lastToolName = "tool";

  const handleLine = (line: string) => {
    line = line.trim();
    if (!line) return;

    let event: any;
    try {
      event = JSON.parse(line);
    } catch {
      console.log(`[claude-agent] Non-JSON line: ${line.substring(0, 200)}`);
      return;
    }

    try {
      handleEvent(event);
    } catch (err) {
      console.error("Error handling Claude event:", err);
    }
  };

  const handleEvent = (event: any) => {
    switch (event.type) {
      case "system":
        console.log(`[claude-agent] Event: system/${event.subtype}`);
        if (event.session_id) {
          callbacks.onSessionId(event.session_id);
        }
        break;

      case "stream_event":
        handleStreamEvent(event.event);
        break;

      case "assistant":
        console.log(
          `[claude-agent] Event: assistant — content: ${JSON.stringify(event.message?.content).substring(0, 500)}`
        );
        handleAssistantEvent(event as ClaudeAssistantEvent);
        break;

      case "user":
        console.log(`[claude-agent] Event: user`);
        handleUserEvent(event);
        break;

      case "result":
        console.log(
          `[claude-agent] Event: result/${event.subtype} — result text: ${event.result?.substring(0, 300)}`
        );
        handleResultEvent(event);
        break;

      default:
        break;
    }
  };

  const handleStreamEvent = (inner: any) => {
    if (!inner) return;

    switch (inner.type) {
      case "content_block_delta":
        if (inner.delta?.type === "text_delta" && inner.delta?.text) {
          streamedTextLength += inner.delta.text.length;
          callbacks.onText(inner.delta.text);
        }
        break;

      case "content_block_start":
        if (
          inner.content_block?.type === "tool_use" &&
          inner.content_block?.name
        ) {
          lastToolName = inner.content_block.name;
          if (inner.content_block.name === "AskUserQuestion") {
            console.log(
              `[claude-agent] AskUserQuestion tool_use started (stream), id: ${inner.content_block.id}`
            );
          }
          // Tool use is emitted from handleAssistantEvent with full input
        }
        break;

      default:
        break;
    }
  };

  const handleAssistantEvent = (event: ClaudeAssistantEvent) => {
    if (!event.message?.content) return;

    for (const block of event.message.content as AssistantContentBlock[]) {
      if (block.type === "text" && block.text) {
        if (streamedTextLength > 0) {
          streamedTextLength = 0;
          continue;
        }
        callbacks.onText(block.text);
      } else if (block.type === "tool_use") {
        if (block.name === "AskUserQuestion") {
          console.log(
            `[claude-agent] AskUserQuestion from assistant event, id: ${block.id}, input: ${JSON.stringify(block.input).substring(0, 300)}`
          );
          callbacks.onQuestion(block.id, block.input as any);
        } else {
          lastToolName = block.name;
          callbacks.onToolUse(block.name, block.input ?? {});
        }
      }
    }
  };

  const handleUserEvent = (event: any) => {
    if (!event.message?.content) return;

    for (const block of event.message.content as UserContentBlock[]) {
      if (block.type === "tool_result") {
        const isError = block.is_error ?? false;
        callbacks.onToolResult(lastToolName, isError);
      }
    }
  };

  const handleResultEvent = (event: any) => {
    if (event.session_id) {
      callbacks.onSessionId(event.session_id);
    }
    result = {
      sessionId: event.session_id,
      costUsd: event.total_cost_usd ?? event.cost_usd ?? 0,
      durationMs: event.duration_ms ?? 0,
      numTurns: event.num_turns ?? 0,
      usage: {
        input_tokens: event.usage?.input_tokens ?? 0,
        output_tokens: event.usage?.output_tokens ?? 0,
        cache_read_input_tokens: event.usage?.cache_read_input_tokens ?? 0,
        cache_creation_input_tokens:
          event.usage?.cache_creation_input_tokens ?? 0,
      },
      result: event.result,
      isError: event.is_error,
    };
  };

  const promise = new Promise<ClaudeResult | null>((resolve) => {
    proc.stdout!.on("data", (chunk: Buffer) => {
      buffer += chunk.toString();
      const lines = buffer.split("\n");
      buffer = lines.pop() || "";
      for (const line of lines) {
        handleLine(line);
      }
    });

    proc.stderr!.on("data", (chunk: Buffer) => {
      const text = chunk.toString().trim();
      if (text) {
        console.error("[claude stderr]", text);
      }
    });

    proc.on("error", (err) => {
      callbacks.onError(`Failed to spawn claude: ${err.message}`);
      resolve(null);
    });

    proc.on("close", (code) => {
      console.log(`[claude-agent] Claude process exited with code ${code}`);
      if (buffer.trim()) {
        handleLine(buffer);
      }
      if (code !== 0 && !result) {
        callbacks.onError(`Claude process exited with code ${code}`);
      }
      resolve(result);
    });
  });

  return { promise, process: proc };
}

// === Build CLI args ===

function buildArgs(request: AgentRequest): string[] {
  const args: string[] = [
    "-p",
    request.prompt,
    "--output-format",
    "stream-json",
    "--verbose",
    "--include-partial-messages",
    "--dangerously-skip-permissions",
  ];

  if (request.agentSessionId) {
    args.push("--resume", request.agentSessionId);
  }

  if (request.config.maxTurns) {
    args.push("--max-turns", request.config.maxTurns.toString());
  }

  if (request.config.maxBudget) {
    args.push("--max-budget-usd", request.config.maxBudget.toString());
  }

  return args;
}

// === ClaudeAgent ===

export class ClaudeAgent implements Agent {
  readonly name = "claude";

  async run(request: AgentRequest): Promise<AgentResult> {
    const { prompt, threadId, endpoint, config } = request;
    const verbosity = config.verbosity ?? 2;
    const args = buildArgs(request);

    console.log(`[claude-agent] Args: ${args.join(" ")}`);
    console.log(`[claude-agent] Agent session ID: ${request.agentSessionId ?? "new"}`);
    console.log(`[claude-agent] Project path: ${request.projectPath}`);

    let agentSessionId: string | undefined;
    let lastToolName = "tool";
    let questionAsked = false;

    const callbacks: RunnerCallbacks = {
      onSessionId: (sessionId) => {
        if (!agentSessionId) {
          agentSessionId = sessionId;
        }
      },
      onText: (text) => {
        endpoint.send(threadId, { type: "assistant", text });
      },
      onToolUse: (name, input) => {
        lastToolName = name;
        if (verbosity >= 2) {
          endpoint.send(threadId, { type: "tool_call", name, input });
        }
      },
      onToolResult: (_name, isError) => {
        if (verbosity >= 2) {
          endpoint.send(threadId, {
            type: "tool_result",
            name: lastToolName,
            isError,
          });
        }
      },
      onQuestion: (_toolUseId, input) => {
        console.log(`[claude-agent] AskUserQuestion received`);
        questionAsked = true;
        endpoint.send(threadId, { type: "question", question: input });
      },
      onError: (error) => {
        endpoint.send(threadId, {
          type: "text",
          text: error,
          subtype: "error",
        });
      },
    };

    const { promise } = runClaude(args, request.projectPath, callbacks);
    const result = await promise;

    // Append completion indicator before done (unless question was asked)
    if (!questionAsked) {
      endpoint.send(threadId, {
        type: "assistant",
        text: "\n\n\ud83d\udcaf",
      });
    }

    endpoint.send(threadId, { type: "done" });

    return {
      agentSessionId,
      durationMs: result?.durationMs ?? 0,
      numTurns: result?.numTurns ?? 0,
      usage: result?.usage ?? { input_tokens: 0, output_tokens: 0 },
      questionAsked,
      resultText: result?.result,
    };
  }
}
