import type { Api } from "grammy";

const MAX_MESSAGE_LENGTH = 4000;
const FLUSH_INTERVAL_MS = 500;

export class TelegramStreamer {
  private api: Api;
  private chatId: number;
  private threadId: number;

  private pendingText = "";
  private currentMessageId: number | null = null;
  private currentMessageText = "";
  private flushTimer: ReturnType<typeof setInterval> | null = null;
  private flushPromise: Promise<void> = Promise.resolve();
  private finalized = false;

  constructor(api: Api, chatId: number, threadId: number) {
    this.api = api;
    this.chatId = chatId;
    this.threadId = threadId;

    this.flushTimer = setInterval(() => {
      this.scheduleFlush();
    }, FLUSH_INTERVAL_MS);
  }

  append(text: string): void {
    this.pendingText += text;
    console.log(`[streamer] append: ${text.length} chars, pending total: ${this.pendingText.length}`);
  }

  appendToolUse(name: string): void {
    this.pendingText += `\n🔧 Using ${name}...\n`;
  }

  appendToolResult(name: string, isError: boolean): void {
    const icon = isError ? "❌" : "✅";
    this.pendingText += `${icon} ${name} completed\n`;
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
