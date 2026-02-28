import type { Context, NextFunction } from "grammy";

export interface TelegramConfig {
  botToken: string;
  allowedUserIds: number[];
  allowedChatIds: number[];
}

export function createAuthMiddleware(config: TelegramConfig) {
  return async function authMiddleware(
    ctx: Context,
    next: NextFunction
  ): Promise<void> {
    const userId = ctx.from?.id;
    const chatId = ctx.chat?.id;
    const chatType = ctx.chat?.type;

    // In private chats: check user allowlist
    if (chatType === "private") {
      if (!userId || !config.allowedUserIds.includes(userId)) {
        return;
      }
      await next();
      return;
    }

    // In groups/supergroups: check chat allowlist OR user allowlist
    if (chatType === "group" || chatType === "supergroup") {
      const chatAllowed =
        chatId != null && config.allowedChatIds.includes(chatId);
      const userAllowed =
        userId != null && config.allowedUserIds.includes(userId);
      if (!chatAllowed && !userAllowed) {
        return;
      }
      await next();
      return;
    }

    // Other chat types (channels etc.) — ignore
  };
}
