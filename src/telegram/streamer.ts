import type { Api } from "grammy";

const MAX_MESSAGE_LENGTH = 4000;
const FLUSH_INTERVAL_MS = 500;

/** Extract the most relevant field from a tool's input for display. */
function formatToolInput(name: string, input: Record<string, unknown>): string | null {
  if (!input || Object.keys(input).length === 0) return null;

  let summary: string | null = null;

  switch (name) {
    case "Bash":
      summary = asString(input.command);
      break;
    case "Read":
      summary = asString(input.file_path);
      break;
    case "Write":
      summary = asString(input.file_path);
      break;
    case "Edit":
      summary = asString(input.file_path);
      break;
    case "Grep":
      summary = asString(input.pattern);
      if (input.path) summary += `  in ${asString(input.path)}`;
      break;
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
      summary = null; // Not interesting enough to show
      break;
    default: {
      // Fallback: show first short string-valued field
      for (const [, v] of Object.entries(input)) {
        if (typeof v === "string" && v.length > 0 && v.length < 300) {
          summary = v;
          break;
        }
      }
    }
  }

  if (!summary) return null;

  // Truncate long summaries
  if (summary.length > 100) {
    summary = summary.substring(0, 97) + "...";
  }

  return summary;
}

function asString(v: unknown): string | null {
  return typeof v === "string" && v.length > 0 ? v : null;
}

/** Escape HTML special characters for Telegram HTML parse_mode. */
function escapeHtml(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

export class TelegramStreamer {
  private api: Api;
  private chatId: number;
  private threadId: number;
  private verbosity: number;

  private pendingText = "";
  private currentMessageId: number | null = null;
  private currentMessageText = "";
  private flushTimer: ReturnType<typeof setInterval> | null = null;
  private flushPromise: Promise<void> = Promise.resolve();
  private finalized = false;

  // Track the current tool card message so we can edit it on completion
  private toolMessageId: number | null = null;
  private toolCardText = "";

  constructor(api: Api, chatId: number, threadId: number, verbosity: number = 2) {
    this.api = api;
    this.chatId = chatId;
    this.threadId = threadId;
    this.verbosity = verbosity;

    this.flushTimer = setInterval(() => {
      this.scheduleFlush();
    }, FLUSH_INTERVAL_MS);
  }

  append(text: string): void {
    this.pendingText += text;
    console.log(`[streamer] append: ${text.length} chars, pending total: ${this.pendingText.length}`);
  }

  /**
   * Send a tool card as a separate message.
   * Shows tool name and key input. Skipped if verbosity is 1.
   */
  async sendToolCard(name: string, input: Record<string, unknown>): Promise<void> {
    if (this.verbosity < 2) return;

    // Flush any pending response text first so tool card appears after it
    this.scheduleFlush();
    await this.flushPromise;

    // Start a fresh response message after the tool card
    this.currentMessageId = null;
    this.currentMessageText = "";

    const inputSummary = formatToolInput(name, input);
    let html = `🔧 <b>${escapeHtml(name)}</b>`;
    if (inputSummary) {
      html += `\n<code>${escapeHtml(inputSummary)}</code>`;
    }

    this.toolCardText = html;

    try {
      const sent = await this.api.sendMessage(this.chatId, html, {
        message_thread_id: this.threadId,
        parse_mode: "HTML",
      });
      this.toolMessageId = sent.message_id;
      console.log(`[streamer] Sent tool card: ${name} (msg ${sent.message_id})`);
    } catch (err) {
      console.error("[streamer] Failed to send tool card:", err);
      this.toolMessageId = null;
    }
  }

  /**
   * Edit the tool card to show completion status (✅ or ❌).
   * Skipped if verbosity is 1.
   */
  async sendToolResult(name: string, isError: boolean): Promise<void> {
    if (this.verbosity < 2) return;

    if (!this.toolMessageId) return;

    const icon = isError ? "❌" : "✅";
    // Replace the 🔧 prefix with the result icon
    const updatedText = this.toolCardText.replace(/^🔧/, icon);

    try {
      await this.api.editMessageText(
        this.chatId,
        this.toolMessageId,
        updatedText,
        { parse_mode: "HTML" },
      );
      console.log(`[streamer] Updated tool card: ${icon} ${name}`);
    } catch (err: any) {
      if (
        !err?.message?.includes("message is not modified") &&
        !err?.message?.includes("MESSAGE_NOT_MODIFIED")
      ) {
        console.error("[streamer] Failed to edit tool card:", err?.message);
      }
    }

    this.toolMessageId = null;
    this.toolCardText = "";
  }

  appendError(error: string): void {
    this.pendingText += `\n⚠️ Error: ${error}\n`;
  }

  private scheduleFlush(): void {
    this.flushPromise = this.flushPromise.then(() => this.flush());
  }

  private async flush(): Promise<void> {
    if (!this.pendingText) return;

    const text = this.pendingText;
    this.pendingText = "";

    console.log(`[streamer] Flushing ${text.length} chars, currentMessageId: ${this.currentMessageId}`);

    try {
      // Check if adding to current message would exceed limit
      if (
        this.currentMessageId &&
        this.currentMessageText.length + text.length > MAX_MESSAGE_LENGTH
      ) {
        // Start a new message
        console.log(`[streamer] Message limit reached, starting new message`);
        this.currentMessageId = null;
        this.currentMessageText = "";
      }

      this.currentMessageText += text;

      if (!this.currentMessageId) {
        // Send a new message
        console.log(`[streamer] Sending new message (${this.currentMessageText.length} chars)`);
        const sent = await this.api.sendMessage(
          this.chatId,
          this.currentMessageText,
          {
            message_thread_id: this.threadId,
          }
        );
        this.currentMessageId = sent.message_id;
        console.log(`[streamer] Sent message ${sent.message_id}`);
      } else {
        // Edit existing message
        try {
          await this.api.editMessageText(
            this.chatId,
            this.currentMessageId,
            this.currentMessageText
          );
        } catch (err: any) {
          if (
            !err?.message?.includes("message is not modified") &&
            !err?.message?.includes("MESSAGE_NOT_MODIFIED")
          ) {
            console.error("[streamer] Failed to edit message:", err?.message);
          }
        }
      }
    } catch (err) {
      console.error("[streamer] Flush error:", err);
    }
  }

  async finalize(): Promise<void> {
    if (this.finalized) return;
    this.finalized = true;

    // Stop the flush timer
    if (this.flushTimer) {
      clearInterval(this.flushTimer);
      this.flushTimer = null;
    }

    // Wait for any in-progress flush, then do a final flush
    this.scheduleFlush();
    await this.flushPromise;
    console.log(`[streamer] Finalized`);
  }

  async sendSummary(summary: string): Promise<void> {
    try {
      await this.api.sendMessage(this.chatId, summary, {
        message_thread_id: this.threadId,
      });
    } catch (err) {
      console.error("[streamer] Failed to send summary:", err);
    }
  }
}
