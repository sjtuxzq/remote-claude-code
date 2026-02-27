import type { Api } from "grammy";

const MAX_MESSAGE_LENGTH = 4000;
const FLUSH_INTERVAL_MS = 500;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

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

  // All content is accumulated as HTML
  private pendingHtml = "";
  private currentMessageId: number | null = null;
  private currentMessageHtml = "";
  private flushTimer: ReturnType<typeof setInterval> | null = null;
  private flushPromise: Promise<void> = Promise.resolve();
  private finalized = false;

  // Track tool card positions so we can update 🔧→✅/❌ in-place
  private lastToolTag = "";

  constructor(api: Api, chatId: number, threadId: number, verbosity: number = 2) {
    this.api = api;
    this.chatId = chatId;
    this.threadId = threadId;
    this.verbosity = verbosity;

    this.flushTimer = setInterval(() => {
      this.scheduleFlush();
    }, FLUSH_INTERVAL_MS);
  }

  /** Append Claude's streamed text (will be HTML-escaped). */
  append(text: string): void {
    this.pendingHtml += escapeHtml(text);
    console.log(`[streamer] append: ${text.length} chars`);
  }

  /**
   * Append a tool card inline. Shows tool name + key input as a blockquote.
   * Skipped if verbosity is 1.
   */
  appendToolCard(name: string, input: Record<string, unknown>): void {
    if (this.verbosity < 2) return;

    const inputSummary = formatToolInput(name, input);
    let card = `\n\n🔧 <b>${escapeHtml(name)}</b>`;
    if (inputSummary) {
      card += `\n<blockquote>${escapeHtml(inputSummary)}</blockquote>`;
    }
    card += `\n`;

    this.lastToolTag = `🔧 <b>${escapeHtml(name)}</b>`;
    this.pendingHtml += card;
  }

  /**
   * Update the last tool card's icon from 🔧 to ✅/❌.
   * Edits the current message in-place.
   */
  appendToolResult(name: string, isError: boolean): void {
    if (this.verbosity < 2) return;
    if (!this.lastToolTag) return;

    const icon = isError ? "❌" : "✅";
    const updatedTag = this.lastToolTag.replace(/^🔧/, icon);

    // Update in pending html (not yet flushed)
    if (this.pendingHtml.includes(this.lastToolTag)) {
      this.pendingHtml = this.pendingHtml.replace(this.lastToolTag, updatedTag);
    }
    // Update in already-flushed message html
    if (this.currentMessageHtml.includes(this.lastToolTag)) {
      this.currentMessageHtml = this.currentMessageHtml.replace(this.lastToolTag, updatedTag);
      // Force a re-flush to edit the message
      if (!this.pendingHtml) {
        this.pendingHtml = "";
        this.scheduleFlush();
      }
    }

    this.lastToolTag = "";
  }

  appendError(error: string): void {
    this.pendingHtml += `\n⚠️ Error: ${escapeHtml(error)}\n`;
  }

  private scheduleFlush(): void {
    this.flushPromise = this.flushPromise.then(() => this.flush());
  }

  private async flush(): Promise<void> {
    const hasNewContent = this.pendingHtml.length > 0;
    const needsEdit = this.currentMessageId &&
      this.currentMessageHtml !== this._lastSentHtml;

    if (!hasNewContent && !needsEdit) return;

    const newHtml = this.pendingHtml;
    this.pendingHtml = "";

    console.log(`[streamer] Flushing ${newHtml.length} chars, currentMessageId: ${this.currentMessageId}`);

    try {
      // Check if adding to current message would exceed limit
      if (
        this.currentMessageId &&
        this.currentMessageHtml.length + newHtml.length > MAX_MESSAGE_LENGTH
      ) {
        console.log(`[streamer] Message limit reached, starting new message`);
        this.currentMessageId = null;
        this.currentMessageHtml = "";
        this._lastSentHtml = "";
      }

      this.currentMessageHtml += newHtml;

      // Skip if nothing to send
      if (!this.currentMessageHtml.trim()) return;

      if (!this.currentMessageId) {
        console.log(`[streamer] Sending new message (${this.currentMessageHtml.length} chars)`);
        const sent = await this.api.sendMessage(
          this.chatId,
          this.currentMessageHtml,
          {
            message_thread_id: this.threadId,
            parse_mode: "HTML",
          }
        );
        this.currentMessageId = sent.message_id;
        this._lastSentHtml = this.currentMessageHtml;
        console.log(`[streamer] Sent message ${sent.message_id}`);
      } else {
        try {
          await this.api.editMessageText(
            this.chatId,
            this.currentMessageId,
            this.currentMessageHtml,
            { parse_mode: "HTML" }
          );
          this._lastSentHtml = this.currentMessageHtml;
        } catch (err: any) {
          if (err?.error_code === 429) {
            const retryAfter = (err?.parameters?.retry_after ?? 5) * 1000;
            console.log(`[streamer] Rate limited on edit, waiting ${retryAfter}ms`);
            await sleep(retryAfter);
          } else if (
            !err?.message?.includes("message is not modified") &&
            !err?.message?.includes("MESSAGE_NOT_MODIFIED")
          ) {
            console.error("[streamer] Failed to edit message:", err?.message);
          }
        }
      }
    } catch (err: any) {
      if (err?.error_code === 429) {
        // Rate limited on sendMessage — put content back for retry
        const retryAfter = (err?.parameters?.retry_after ?? 5) * 1000;
        console.log(`[streamer] Rate limited on send, waiting ${retryAfter}ms`);
        await sleep(retryAfter);
      } else {
        console.error("[streamer] Flush error:", err);
      }
    }
  }

  // Track what was last sent to avoid no-op edits
  private _lastSentHtml = "";

  async finalize(): Promise<void> {
    if (this.finalized) return;
    this.finalized = true;

    if (this.flushTimer) {
      clearInterval(this.flushTimer);
      this.flushTimer = null;
    }

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
