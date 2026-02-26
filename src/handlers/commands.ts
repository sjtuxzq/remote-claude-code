import * as fs from "node:fs";
import * as path from "node:path";
import type { Context } from "grammy";
import type { SessionStore } from "../store/sessions.js";
import type { Session } from "../types.js";
import { config } from "../config.js";

function formatTokens(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}k`;
  return `${n}`;
}

function threadOpts(ctx: Context) {
  return ctx.message?.message_thread_id
    ? { message_thread_id: ctx.message.message_thread_id }
    : {};
}

function isPathAllowed(projectPath: string): boolean {
  if (config.allowedPaths.length === 0) return true;
  const resolved = path.resolve(projectPath);
  return config.allowedPaths.some((allowed) => {
    const resolvedAllowed = path.resolve(allowed);
    return resolved.startsWith(resolvedAllowed);
  });
}

export function createCommandHandlers(store: SessionStore) {
  async function handleStart(ctx: Context): Promise<void> {
    const chatType = ctx.chat?.type;
    const isGroup = chatType === "group" || chatType === "supergroup";

    await ctx.reply(
      "🤖 Claude Code Remote Bot\n\n" +
        (isGroup
          ? "This bot creates forum topics for Claude sessions.\n" +
            "Make sure Topics are enabled in group settings and the bot is an admin.\n\n"
          : "") +
        "Commands:\n" +
        "/new <path> [name] — Start a new Claude session\n" +
        "/reset — Reset session in current topic (fresh conversation)\n" +
        "/delete — Delete session and close topic\n" +
        "/sessions — List all sessions\n" +
        "/usage — Show token usage\n" +
        "/repos — List available project paths\n" +
        "/help — Show this message\n\n" +
        "Send messages in a session topic to chat with Claude."
    );
  }

  async function handleHelp(ctx: Context): Promise<void> {
    await handleStart(ctx);
  }

  async function handleNew(ctx: Context): Promise<void> {
    const chatId = ctx.chat?.id;
    const userId = ctx.from?.id;
    if (!chatId || !userId) return;

    const text = ctx.message?.text || "";
    const match = text.match(/^\/new(?:@\S+)?\s+(\S+)(?:\s+(.+))?$/);
    if (!match) {
      await ctx.reply(
        "Usage: /new <project-path> [session-name]\n" +
          "Example: /new /home/user/my-project my-session\n\n" +
          "Use /repos to see available projects.",
        threadOpts(ctx)
      );
      return;
    }

    const projectPath = path.resolve(match[1]);
    const sessionName = match[2]?.trim() || path.basename(projectPath);

    // Check allowed paths
    if (!isPathAllowed(projectPath)) {
      await ctx.reply(
        `⚠️ Path not allowed: ${projectPath}\n\nAllowed paths:\n${config.allowedPaths.map((p) => `• ${p}`).join("\n")}\n\nUse /repos to see available projects.`,
        threadOpts(ctx)
      );
      return;
    }

    // Validate path exists
    try {
      const stat = fs.statSync(projectPath);
      if (!stat.isDirectory()) {
        await ctx.reply(`⚠️ Path is not a directory: ${projectPath}`, threadOpts(ctx));
        return;
      }
    } catch {
      await ctx.reply(`⚠️ Path does not exist: ${projectPath}`, threadOpts(ctx));
      return;
    }

    // Create forum topic
    let topic;
    try {
      topic = await ctx.api.createForumTopic(chatId, sessionName);
    } catch (err: any) {
      const chatType = ctx.chat?.type;
      const isGroup = chatType === "group" || chatType === "supergroup";
      const hint = isGroup
        ? "Make sure:\n1. Topics are enabled in group settings\n2. The bot is a group admin with 'Manage Topics' permission"
        : "Make sure:\n1. Threaded mode is enabled for this bot in BotFather\n2. You may need to restart the chat";
      await ctx.reply(
        `⚠️ Failed to create forum topic.\n${hint}\n\nError: ${err?.message}`
      );
      return;
    }

    // Create session record
    const now = new Date().toISOString();
    const session: Session = {
      threadId: topic.message_thread_id,
      chatId,
      userId,
      claudeSessionId: null,
      projectPath,
      name: sessionName,
      createdAt: now,
      lastActiveAt: now,
      totalUsage: { input_tokens: 0, output_tokens: 0 },
      totalDurationMs: 0,
      totalTurns: 0,
    };

    store.create(session);

    // Send welcome message in the new topic
    await ctx.api.sendMessage(
      chatId,
      `🚀 Session "${sessionName}" created!\n📁 Project: ${projectPath}\n\nSend a message here to start chatting with Claude.`,
      { message_thread_id: topic.message_thread_id }
    );

    // Confirm in the original thread/General
    await ctx.reply(
      `✅ Created session "${sessionName}" — check the new topic!`,
      threadOpts(ctx)
    );
  }

  async function handleReset(ctx: Context): Promise<void> {
    const chatId = ctx.chat?.id;
    if (!chatId) return;

    const threadId = ctx.message?.message_thread_id;
    if (!threadId) {
      await ctx.reply("⚠️ Use /reset inside a session topic.", threadOpts(ctx));
      return;
    }

    const session = store.getByThread(chatId, threadId);
    if (!session) {
      await ctx.reply("⚠️ This topic is not a tracked session.", { message_thread_id: threadId });
      return;
    }

    store.resetSession(chatId, threadId);
    await ctx.reply(
      `🔄 Session "${session.name}" reset.\nConversation history cleared. Next message starts a fresh Claude session.\n📁 Project: ${session.projectPath}`,
      { message_thread_id: threadId }
    );
  }

  async function handleDelete(ctx: Context): Promise<void> {
    const chatId = ctx.chat?.id;
    if (!chatId) return;

    const threadId = ctx.message?.message_thread_id;
    if (!threadId) {
      await ctx.reply("⚠️ Use /delete inside a session topic.", threadOpts(ctx));
      return;
    }

    const session = store.getByThread(chatId, threadId);
    if (!session) {
      await ctx.reply("⚠️ This topic is not a tracked session.", { message_thread_id: threadId });
      return;
    }

    const name = session.name;
    store.deleteSession(chatId, threadId);

    // Try to close/delete the forum topic
    try {
      await ctx.api.closeForumTopic(chatId, threadId);
    } catch {
      // Ignore — may not have permission or topic already closed
    }
    try {
      await ctx.api.deleteForumTopic(chatId, threadId);
    } catch {
      // Ignore — deleteForumTopic may fail, topic stays closed
      await ctx.reply(`🗑️ Session "${name}" deleted. You can close this topic manually.`, {
        message_thread_id: threadId,
      });
    }
  }

  async function handleSessions(ctx: Context): Promise<void> {
    const chatId = ctx.chat?.id;
    if (!chatId) return;

    const sessions = store.getAllForChat(chatId);
    if (sessions.length === 0) {
      await ctx.reply("No sessions yet. Use /new to create one.", threadOpts(ctx));
      return;
    }

    const lines = sessions.map((s, i) => {
      const active = s.lastActiveAt
        ? new Date(s.lastActiveAt).toLocaleString()
        : "never";
      const resumed = s.claudeSessionId ? "🟢" : "⚪";
      return `${i + 1}. ${resumed} ${s.name}\n   📁 ${s.projectPath}\n   🕐 ${active}`;
    });

    await ctx.reply(`📋 Sessions:\n\n${lines.join("\n\n")}`, threadOpts(ctx));
  }

  async function handleUsage(ctx: Context): Promise<void> {
    const chatId = ctx.chat?.id;
    if (!chatId) return;

    const threadId = ctx.message?.message_thread_id;

    // If sent from a session topic, show usage for that session
    if (threadId) {
      const session = store.getByThread(chatId, threadId);
      if (session) {
        const u = session.totalUsage ?? { input_tokens: 0, output_tokens: 0 };
        const duration = ((session.totalDurationMs ?? 0) / 1000).toFixed(1);
        const lines = [
          `📊 Usage for "${session.name}"`,
          ``,
          `Turns: ${session.totalTurns ?? 0}`,
          `Duration: ${duration}s`,
          `Input tokens: ${formatTokens(u.input_tokens)}`,
          `Output tokens: ${formatTokens(u.output_tokens)}`,
        ];
        if (u.cache_read_input_tokens) {
          lines.push(`Cache read: ${formatTokens(u.cache_read_input_tokens)}`);
        }
        if (u.cache_creation_input_tokens) {
          lines.push(`Cache write: ${formatTokens(u.cache_creation_input_tokens)}`);
        }
        await ctx.reply(lines.join("\n"), { message_thread_id: threadId });
        return;
      }
    }

    // Otherwise show usage for all sessions in this chat
    const sessions = store.getAllForChat(chatId);
    if (sessions.length === 0) {
      await ctx.reply("No sessions yet.", threadOpts(ctx));
      return;
    }

    let totalInput = 0, totalOutput = 0, totalCache = 0, totalTurns = 0;

    const lines = sessions.map((s) => {
      const u = s.totalUsage ?? { input_tokens: 0, output_tokens: 0 };
      totalInput += u.input_tokens;
      totalOutput += u.output_tokens;
      totalCache += u.cache_read_input_tokens ?? 0;
      totalTurns += s.totalTurns ?? 0;
      return `• ${s.name}: ↓${formatTokens(u.input_tokens)} ↑${formatTokens(u.output_tokens)} (${s.totalTurns ?? 0} turns)`;
    });

    const summary = [
      `📊 Usage across all sessions`,
      ``,
      ...lines,
      ``,
      `Total: ↓${formatTokens(totalInput)} ↑${formatTokens(totalOutput)} (${totalTurns} turns)`,
    ];
    if (totalCache) {
      summary.push(`Cache read: ${formatTokens(totalCache)}`);
    }

    await ctx.reply(summary.join("\n"), threadOpts(ctx));
  }

  async function handleRepos(ctx: Context): Promise<void> {
    if (config.allowedPaths.length === 0) {
      await ctx.reply("No path restrictions configured. Any path is allowed.", threadOpts(ctx));
      return;
    }

    const repos: string[] = [];

    for (const allowedPath of config.allowedPaths) {
      const resolved = path.resolve(allowedPath);
      try {
        const entries = fs.readdirSync(resolved, { withFileTypes: true });
        for (const entry of entries) {
          if (entry.isDirectory()) {
            const fullPath = path.join(resolved, entry.name);
            repos.push(fullPath);
          }
        }
      } catch {
        repos.push(`⚠️ ${resolved} (not accessible)`);
      }
    }

    if (repos.length === 0) {
      await ctx.reply("No projects found in allowed paths.", threadOpts(ctx));
      return;
    }

    const lines = repos.map((r) => `• ${r}`);
    await ctx.reply(
      `📂 Available projects:\n\n${lines.join("\n")}\n\nUse: /new <path> [name]`,
      threadOpts(ctx)
    );
  }

  return {
    handleStart,
    handleHelp,
    handleNew,
    handleReset,
    handleDelete,
    handleSessions,
    handleUsage,
    handleRepos,
  };
}
