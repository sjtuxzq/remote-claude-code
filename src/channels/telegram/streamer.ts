import type { Api } from "grammy";
import type {
  ChannelEndpoint,
  ChannelMessage,
  AskUserQuestionInput,
} from "../../core/types.js";

const MAX_MESSAGE_LENGTH = 4000;
const FLUSH_INTERVAL_MS = 500;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Extract the most relevant field from a tool's input for display. */
function formatToolInput(
  name: string,
  input: Record<string, unknown>
): string | null {
  if (!input || Object.keys(input).length === 0) return null;

  let summary: string | null = null;

  switch (name) {
    case "Bash":
      summary = asString(input.command);
      break;
    case "Read":
    case "Write":
    case "Edit":
      summary = asString(input.file_path);
      break;
    case "Grep":
    case "Glob":
      summary = asString(input.pattern);
      if (input.path) summary += `  in ${asString(input.path)}`;
      break;
    case "Task":
      summary = asString(input.description) ?? asString(input.prompt);
      break;
    case "WebFetch":
      summary = asString(input.url);
      break;
    case "WebSearch":
      summary = asString(input.query);
      break;
    case "TodoWrite":
      summary = null;
      break;
    default: {
      for (const [, v] of Object.entries(input)) {
        if (typeof v === "string" && v.length > 0 && v.length < 300) {
          summary = v;
          break;
        }
      }
    }
  }

  if (!summary) return null;
  if (summary.length > 100) summary = summary.substring(0, 97) + "...";
  return summary;
}

function asString(v: unknown): string | null {
  return typeof v === "string" && v.length > 0 ? v : null;
}

function escapeHtml(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

function formatQuestion(input: AskUserQuestionInput): string {
  const lines: string[] = ["\u2753 Claude is asking:\n"];
  for (const q of input.questions) {
    lines.push(q.question);
    if (q.options && q.options.length > 0) {
      for (let i = 0; i < q.options.length; i++) {
        const opt = q.options[i];
        const desc = opt.description ? ` \u2014 ${opt.description}` : "";
        lines.push(`  ${i + 1}. ${opt.label}${desc}`);
      }
    }
    if (q.multiSelect) {
      lines.push('(You can pick multiple, e.g. "1, 3")');
    }
    lines.push("");
  }
  lines.push("Reply with your answer:");
  return lines.join("\n");
}

// === Per-thread streaming state ===

interface ThreadStreamState {
  pendingHtml: string;
  currentMessageId: number | null;
  currentMessageHtml: string;
  flushTimer: ReturnType<typeof setInterval> | null;
  flushPromise: Promise<void>;
  toolTagsByUseId: Map<string, string>; // toolUseId → HTML tag for icon replacement
  toolCounter: number; // monotonic counter for unique tool tags
  lastSentHtml: string;
  toolGroupOpen: boolean; // true while accumulating collapsed tool lines
}

function createStreamState(): ThreadStreamState {
  return {
    pendingHtml: "",
    currentMessageId: null,
    currentMessageHtml: "",
    flushTimer: null,
    flushPromise: Promise.resolve(),
    toolTagsByUseId: new Map(),
    toolCounter: 0,
    lastSentHtml: "",
    toolGroupOpen: false,
  };
}

/**
 * Telegram transport.
 *
 * Holds one end of a MessageChannel.  Sends user messages to the
 * orchestrator via `endpoint.send()`.  Runs a receive loop that
 * pulls orchestrator messages and renders them to Telegram.
 *
 * Per-thread streaming state (message buffering, flush timers)
 * is stored in a Map keyed by threadId.
 *
 * threadId format: "chatId:topicThreadId"
 */
export class TelegramTransport {
  private api: Api;
  private endpoint: ChannelEndpoint;
  private threadStates = new Map<string, ThreadStreamState>();

  constructor(api: Api, endpoint: ChannelEndpoint) {
    this.api = api;
    this.endpoint = endpoint;

    // Start receive loop for orchestrator → Telegram messages
    this.receiveLoop();
  }

  // === Public: called by Telegram bot handlers ===

  /**
   * Called by the Telegram message handler when a user sends text.
   * Pushes a user message to the orchestrator via the channel.
   */
  onUserMessage(threadId: string, text: string): void {
    this.endpoint.send(threadId, { type: "user", text });
  }

  // === Receive loop: pull messages from orchestrator ===

  private async receiveLoop(): Promise<void> {
    while (true) {
      const { threadId, message } = await this.endpoint.receive();
      this.handleMessage(threadId, message);
    }
  }

  private handleMessage(threadId: string, message: ChannelMessage): void {
    switch (message.type) {
      case "assistant":
        this.handleAssistant(threadId, message.text);
        break;
      case "tool_call":
        this.handleToolCall(threadId, message.toolUseId, message.name, message.input, message.collapsed);
        break;
      case "tool_result":
        this.handleToolResult(threadId, message.toolUseId, message.isError);
        break;
      case "text":
        if (message.subtype === "error") {
          this.handleError(threadId, message.text);
        } else {
          this.handleNotice(threadId, message.text);
        }
        break;
      case "question":
        this.handleQuestion(threadId, message.question);
        break;
      case "done":
        this.handleDone(threadId);
        break;
    }
  }

  // === Private: message type handlers ===

  /** Close any open collapsed tool group by appending the closing tag. */
  private closeToolGroup(state: ThreadStreamState): void {
    if (!state.toolGroupOpen) return;
    state.pendingHtml += `</blockquote>`;
    state.toolGroupOpen = false;
  }

  private handleAssistant(threadId: string, text: string): void {
    const state = this.getOrCreateState(threadId);
    this.closeToolGroup(state);
    state.pendingHtml += escapeHtml(text);
    console.log(`[telegram] append: ${text.length} chars`);
  }

  private handleToolCall(
    threadId: string,
    toolUseId: string,
    name: string,
    input: Record<string, unknown>,
    collapsed?: boolean
  ): void {
    const state = this.getOrCreateState(threadId);

    const escapedName = escapeHtml(name);
    const inputSummary = formatToolInput(name, input);
    // Append zero-width spaces to make each tag unique for string replacement
    const uid = "\u200B".repeat(++state.toolCounter);
    const toolTag = `\ud83d\udd27${uid} <b>${escapedName}</b>`;

    if (collapsed) {
      // Grouped collapsed: accumulate tool lines inside a single expandable blockquote
      if (!state.toolGroupOpen) {
        state.pendingHtml += `\n\n<blockquote expandable>`;
        state.toolGroupOpen = true;
      } else {
        state.pendingHtml += `\n`;
      }
      state.pendingHtml += toolTag;
      if (inputSummary) state.pendingHtml += `  ${escapeHtml(inputSummary)}`;
    } else {
      // Expanded: name outside, input in regular blockquote
      this.closeToolGroup(state);
      let card = `\n\n${toolTag}`;
      if (inputSummary) card += `\n<blockquote>${escapeHtml(inputSummary)}</blockquote>`;
      card += `\n`;
      state.pendingHtml += card;
    }

    state.toolTagsByUseId.set(toolUseId, toolTag);
  }

  private handleToolResult(
    threadId: string,
    toolUseId: string,
    isError: boolean
  ): void {
    const state = this.threadStates.get(threadId);
    if (!state) return;

    const toolTag = state.toolTagsByUseId.get(toolUseId);
    if (!toolTag) return;
    state.toolTagsByUseId.delete(toolUseId);

    const icon = isError ? "\u274c" : "\u2705";
    const updatedTag = toolTag.replace(/^\ud83d\udd27/, icon);

    if (state.pendingHtml.includes(toolTag)) {
      state.pendingHtml = state.pendingHtml.replace(
        toolTag,
        updatedTag
      );
    }
    if (state.currentMessageHtml.includes(toolTag)) {
      state.currentMessageHtml = state.currentMessageHtml.replace(
        toolTag,
        updatedTag
      );
      if (!state.pendingHtml) {
        state.pendingHtml = "";
        this.scheduleFlush(threadId, state);
      }
    }
  }

  private handleError(threadId: string, error: string): void {
    const state = this.getOrCreateState(threadId);
    this.closeToolGroup(state);
    state.pendingHtml += `\n\u26a0\ufe0f Error: ${escapeHtml(error)}\n`;
  }

  private handleNotice(threadId: string, text: string): void {
    const { chatId, topicThreadId } = this.parseChatAndTopic(threadId);
    this.api
      .sendMessage(chatId, text, {
        message_thread_id: topicThreadId,
      })
      .catch((err) =>
        console.error("[telegram] Failed to send notice:", err)
      );
  }

  private handleQuestion(
    threadId: string,
    question: AskUserQuestionInput
  ): void {
    const state = this.getOrCreateState(threadId);
    this.closeToolGroup(state);
    this.handleAssistant(threadId, "\n\n" + formatQuestion(question));
  }

  private handleDone(threadId: string): void {
    const state = this.threadStates.get(threadId);
    if (!state) return;

    // Close any open tool group
    this.closeToolGroup(state);

    // Stop flush timer
    if (state.flushTimer) {
      clearInterval(state.flushTimer);
      state.flushTimer = null;
    }

    // Final flush, then clean up
    this.scheduleFlush(threadId, state);
    state.flushPromise.then(() => {
      this.threadStates.delete(threadId);
      console.log(`[telegram] Done, cleaned up thread ${threadId}`);
    });
  }

  // === Private: per-thread streaming internals ===

  private getOrCreateState(threadId: string): ThreadStreamState {
    let state = this.threadStates.get(threadId);
    if (!state) {
      state = createStreamState();
      // Start flush timer for this thread
      state.flushTimer = setInterval(() => {
        this.scheduleFlush(threadId, state!);
      }, FLUSH_INTERVAL_MS);
      this.threadStates.set(threadId, state);
    }
    return state;
  }

  private scheduleFlush(threadId: string, state: ThreadStreamState): void {
    state.flushPromise = state.flushPromise.then(() =>
      this.flush(threadId, state)
    );
  }

  private async flush(
    threadId: string,
    state: ThreadStreamState
  ): Promise<void> {
    const hasNewContent = state.pendingHtml.length > 0;
    const needsEdit =
      state.currentMessageId &&
      state.currentMessageHtml !== state.lastSentHtml;

    if (!hasNewContent && !needsEdit) return;

    const { chatId, topicThreadId } = this.parseChatAndTopic(threadId);
    const newHtml = state.pendingHtml;
    state.pendingHtml = "";

    console.log(
      `[telegram] Flushing ${newHtml.length} chars for thread ${threadId}`
    );

    try {
      if (
        state.currentMessageId &&
        state.currentMessageHtml.length + newHtml.length > MAX_MESSAGE_LENGTH
      ) {
        console.log(
          `[telegram] Message limit reached, starting new message`
        );
        state.currentMessageId = null;
        state.currentMessageHtml = "";
        state.lastSentHtml = "";
      }

      state.currentMessageHtml += newHtml;

      if (!state.currentMessageHtml.trim()) return;

      if (!state.currentMessageId) {
        console.log(
          `[telegram] Sending new message (${state.currentMessageHtml.length} chars)`
        );
        const sent = await this.api.sendMessage(
          chatId,
          state.currentMessageHtml,
          {
            message_thread_id: topicThreadId,
            parse_mode: "HTML",
          }
        );
        state.currentMessageId = sent.message_id;
        state.lastSentHtml = state.currentMessageHtml;
        console.log(`[telegram] Sent message ${sent.message_id}`);
      } else {
        try {
          await this.api.editMessageText(
            chatId,
            state.currentMessageId,
            state.currentMessageHtml,
            { parse_mode: "HTML" }
          );
          state.lastSentHtml = state.currentMessageHtml;
        } catch (err: any) {
          if (err?.error_code === 429) {
            const retryAfter = (err?.parameters?.retry_after ?? 5) * 1000;
            console.log(
              `[telegram] Rate limited on edit, waiting ${retryAfter}ms`
            );
            await sleep(retryAfter);
          } else if (
            !err?.message?.includes("message is not modified") &&
            !err?.message?.includes("MESSAGE_NOT_MODIFIED")
          ) {
            console.error(
              "[telegram] Failed to edit message:",
              err?.message
            );
          }
        }
      }
    } catch (err: any) {
      if (err?.error_code === 429) {
        const retryAfter = (err?.parameters?.retry_after ?? 5) * 1000;
        console.log(
          `[telegram] Rate limited on send, waiting ${retryAfter}ms`
        );
        await sleep(retryAfter);
      } else {
        console.error("[telegram] Flush error:", err);
      }
    }
  }

  private parseChatAndTopic(threadId: string): {
    chatId: number;
    topicThreadId: number;
  } {
    const [chatStr, topicStr] = threadId.split(":");
    return {
      chatId: parseInt(chatStr, 10),
      topicThreadId: parseInt(topicStr, 10),
    };
  }
}
