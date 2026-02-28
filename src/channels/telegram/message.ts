import type { Context } from "grammy";
import type { TelegramTransport } from "./streamer.js";

/**
 * Create the Telegram message handler.
 *
 * Ultra-thin: constructs a threadId and forwards the text to the
 * transport.  The orchestrator (on the other end of the channel)
 * guards against unknown threads and handles everything else.
 */
export function createMessageHandler(transport: TelegramTransport) {
  return async function handleMessage(ctx: Context): Promise<void> {
    const message = ctx.message;
    if (!message?.text) return;
    if (!message.message_thread_id) return;
    if (message.text.startsWith("/")) return;

    const chatId = ctx.chat?.id;
    if (!chatId) return;

    const threadId = `${chatId}:${message.message_thread_id}`;
    transport.onUserMessage(threadId, message.text);
  };
}
