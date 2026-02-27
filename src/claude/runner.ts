import { spawn, execSync, type ChildProcess } from "node:child_process";
import type {
  ClaudeResult,
  RunnerCallbacks,
  ClaudeAssistantEvent,
  AssistantContentBlock,
  UserContentBlock,
} from "../types.js";

// Resolve the full path to claude once at startup
let claudePath: string;
try {
  claudePath = execSync(
    process.platform === "win32" ? "where claude" : "which claude",
    { encoding: "utf-8" }
  ).trim().split("\n")[0];
  console.log(`[runner] Resolved claude path: ${claudePath}`);
} catch {
  console.error("[runner] Could not find claude in PATH");
  claudePath = "claude";
}

export function runClaude(
  args: string[],
  cwd: string,
  callbacks: RunnerCallbacks
): { promise: Promise<ClaudeResult | null>; process: ChildProcess } {
  console.log(`[runner] Spawning: ${claudePath} ${args.join(" ")}`);

  // Clean env: remove CLAUDECODE to avoid "nested session" error
  const cleanEnv = { ...process.env };
  delete cleanEnv.CLAUDECODE;

  const proc = spawn(claudePath, args, {
    cwd,
    env: cleanEnv,
    stdio: ["ignore", "pipe", "pipe"],
  });

  console.log(`[runner] Spawned claude (pid ${proc.pid}) in ${cwd}`);

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
      console.log(`[runner] Non-JSON line: ${line.substring(0, 200)}`);
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
        console.log(`[runner] Event: system/${event.subtype}`);
        if (event.session_id) {
          callbacks.onSessionId(event.session_id);
        }
        break;

      case "stream_event":
        handleStreamEvent(event.event);
        break;

      case "assistant":
        console.log(`[runner] Event: assistant — content: ${JSON.stringify(event.message?.content).substring(0, 500)}`);
        handleAssistantEvent(event as ClaudeAssistantEvent);
        break;

      case "user":
        console.log(`[runner] Event: user`);
        handleUserEvent(event);
        break;

      case "result":
        console.log(`[runner] Event: result/${event.subtype} — result text: ${event.result?.substring(0, 300)}`);
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
        if (inner.content_block?.type === "tool_use" && inner.content_block?.name) {
          lastToolName = inner.content_block.name;
          if (inner.content_block.name === "AskUserQuestion") {
            console.log(`[runner] AskUserQuestion tool_use started (stream), id: ${inner.content_block.id}`);
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
          console.log(`[runner] AskUserQuestion from assistant event, id: ${block.id}, input: ${JSON.stringify(block.input).substring(0, 300)}`);
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
        cache_creation_input_tokens: event.usage?.cache_creation_input_tokens ?? 0,
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
      console.log(`[runner] Claude process exited with code ${code}`);
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
