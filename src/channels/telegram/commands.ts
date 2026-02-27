import * as path from "node:path";
import type { Context } from "grammy";
import type { Orchestrator } from "../../core/orchestrator.js";

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

export function createCommandHandlers(
  orchestrator: Orchestrator
) {
  const sessionManager = orchestrator.sessions;

  async function handleStart(ctx: Context): Promise<void> {
    const chatType = ctx.chat?.type;
    const isGroup = chatType === "group" || chatType === "supergroup";

    await ctx.reply(
      "\ud83e\udd16 Claude Code Remote Bot\n\n" +
        (isGroup
          ? "This bot creates forum topics for Claude sessions.\n" +
            "Make sure Topics are enabled in group settings and the bot is an admin.\n\n"
          : "") +
        "Commands:\n" +
        "/new <name|path> [session-name] \u2014 Start a new Claude session\n" +
        "/reset \u2014 Reset session in current topic (fresh conversation)\n" +
        "/delete \u2014 Delete session and close topic\n" +
        "/archive \u2014 Close topic (keeps session data)\n" +
        "/unarchive \u2014 Reopen an archived topic\n" +
        "/sessions \u2014 List all sessions\n" +
        "/usage \u2014 Show token usage\n" +
        "/verbosity \u2014 Set tool message verbosity (1=hide, 2=show)\n" +
        "/repos \u2014 List available project paths\n" +
        "/update \u2014 Pull latest code, build, and restart\n" +
        "/help \u2014 Show this message\n\n" +
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
        "Usage: /new <name-or-path> [session-name]\n" +
          "Example: /new my-project\n" +
          "Example: /new /home/user/my-project my-session\n\n" +
          "Use /repos to see available projects.",
        threadOpts(ctx)
      );
      return;
    }

    const pathInput = match[1];
    const repoName = path.basename(pathInput);
    const sessionName = match[2]?.trim() || repoName;
    const topicTitle = match[2]?.trim() ? `${repoName}:${match[2].trim()}` : repoName;

    // Validate path via core
    const resolved = sessionManager.validateProjectPath(pathInput);
    if (resolved.error) {
      await ctx.reply(`\u26a0\ufe0f ${resolved.error}`, threadOpts(ctx));
      return;
    }
    const projectPath = resolved.path!;

    // Create forum topic (Telegram-specific)
    let topic;
    try {
      topic = await ctx.api.createForumTopic(chatId, topicTitle);
    } catch (err: any) {
      const chatType = ctx.chat?.type;
      const isGroup = chatType === "group" || chatType === "supergroup";
      const hint = isGroup
        ? "Make sure:\n1. Topics are enabled in group settings\n2. The bot is a group admin with 'Manage Topics' permission"
        : "Make sure:\n1. Threaded mode is enabled for this bot in BotFather\n2. You may need to restart the chat";
      await ctx.reply(
        `\u26a0\ufe0f Failed to create forum topic.\n${hint}\n\nError: ${err?.message}`
      );
      return;
    }

    const threadId = `${chatId}:${topic.message_thread_id}`;

    // Create session via core
    try {
      sessionManager.create({
        threadId,
        channel: "telegram",
        projectPath,
        name: sessionName,
        channelMeta: {
          chatId,
          threadId: topic.message_thread_id,
          userId,
        },
      });
    } catch (err: any) {
      await ctx.reply(`\u26a0\ufe0f Failed to create session: ${err?.message}`, threadOpts(ctx));
      return;
    }

    // Send welcome message in the new topic
    await ctx.api.sendMessage(
      chatId,
      `\ud83d\ude80 Session "${sessionName}" created!\n\ud83d\udcc1 Project: ${projectPath}\n\nSend a message here to start chatting with Claude.`,
      { message_thread_id: topic.message_thread_id }
    );

    // Unpin the auto-pinned service message
    try {
      await ctx.api.unpinAllForumTopicMessages(chatId, topic.message_thread_id);
    } catch {
      // Ignore
    }

    // Confirm in the original thread/General
    await ctx.reply(
      `\u2705 Created session "${sessionName}" \u2014 check the new topic!`,
      threadOpts(ctx)
    );
  }

  async function handleReset(ctx: Context): Promise<void> {
    const chatId = ctx.chat?.id;
    if (!chatId) return;

    const topicThreadId = ctx.message?.message_thread_id;
    if (!topicThreadId) {
      await ctx.reply("\u26a0\ufe0f Use /reset inside a session topic.", threadOpts(ctx));
      return;
    }

    const threadId = `${chatId}:${topicThreadId}`;
    const session = sessionManager.getByThread(threadId);
    if (!session) {
      await ctx.reply("\u26a0\ufe0f This topic is not a tracked session.", { message_thread_id: topicThreadId });
      return;
    }

    sessionManager.resetSession(session.id);
    await ctx.reply(
      `\ud83d\udd04 Session "${session.name}" reset.\nConversation history cleared. Next message starts a fresh Claude session.\n\ud83d\udcc1 Project: ${session.projectPath}`,
      { message_thread_id: topicThreadId }
    );
  }

  async function handleDelete(ctx: Context): Promise<void> {
    const chatId = ctx.chat?.id;
    if (!chatId) return;

    const topicThreadId = ctx.message?.message_thread_id;
    if (!topicThreadId) {
      await ctx.reply("\u26a0\ufe0f Use /delete inside a session topic.", threadOpts(ctx));
      return;
    }

    const threadId = `${chatId}:${topicThreadId}`;
    const session = sessionManager.getByThread(threadId);
    if (!session) {
      await ctx.reply("\u26a0\ufe0f This topic is not a tracked session.", { message_thread_id: topicThreadId });
      return;
    }

    const name = session.name;
    sessionManager.deleteSession(session.id);

    // Try to close/delete the forum topic (Telegram-specific)
    try {
      await ctx.api.closeForumTopic(chatId, topicThreadId);
    } catch {
      // Ignore
    }
    try {
      await ctx.api.deleteForumTopic(chatId, topicThreadId);
    } catch {
      await ctx.reply(`\ud83d\uddd1\ufe0f Session "${name}" deleted. You can close this topic manually.`, {
        message_thread_id: topicThreadId,
      });
    }
  }

  async function handleSessions(ctx: Context): Promise<void> {
    const chatId = ctx.chat?.id;
    if (!chatId) return;

    const topicThreadId = ctx.message?.message_thread_id;

    // If inside a topic, show info for this session only
    if (topicThreadId) {
      const threadId = `${chatId}:${topicThreadId}`;
      const session = sessionManager.getByThread(threadId);
      if (!session) {
        await ctx.reply("\u26a0\ufe0f This topic is not a tracked session.", { message_thread_id: topicThreadId });
        return;
      }

      const active = session.lastActiveAt
        ? new Date(session.lastActiveAt).toLocaleString()
        : "never";
      const lines = [
        `\ud83d\udccb Session: ${session.name}`,
        ``,
        `\ud83d\udcc1 ${session.projectPath}`,
        `\ud83d\udd50 Last active: ${active}`,
        `\ud83d\udd11 Session ID: ${session.claudeSessionId ?? "none (new session)"}`,
      ];
      await ctx.reply(lines.join("\n"), { message_thread_id: topicThreadId });
      return;
    }

    // Otherwise list all Telegram sessions for this chat
    const sessions = sessionManager.getAllForChannel("telegram").filter(
      (s) => (s.channelMeta as any)?.chatId === chatId
    );
    if (sessions.length === 0) {
      await ctx.reply("No sessions yet. Use /new to create one.", threadOpts(ctx));
      return;
    }

    const lines = sessions.map((s, i) => {
      const active = s.lastActiveAt
        ? new Date(s.lastActiveAt).toLocaleString()
        : "never";
      const resumed = s.claudeSessionId ? "\ud83d\udfe2" : "\u26aa";
      const sessionId = s.claudeSessionId ? `\n   \ud83d\udd11 ${s.claudeSessionId}` : "";
      return `${i + 1}. ${resumed} ${s.name}\n   \ud83d\udcc1 ${s.projectPath}\n   \ud83d\udd50 ${active}${sessionId}`;
    });

    await ctx.reply(`\ud83d\udccb Sessions:\n\n${lines.join("\n\n")}`, threadOpts(ctx));
  }

  async function handleUsage(ctx: Context): Promise<void> {
    const chatId = ctx.chat?.id;
    if (!chatId) return;

    const topicThreadId = ctx.message?.message_thread_id;

    // If sent from a session topic, show usage for that session
    if (topicThreadId) {
      const threadId = `${chatId}:${topicThreadId}`;
      const session = sessionManager.getByThread(threadId);
      if (session) {
        const u = session.totalUsage ?? { input_tokens: 0, output_tokens: 0 };
        const duration = ((session.totalDurationMs ?? 0) / 1000).toFixed(1);
        const lines = [
          `\ud83d\udcca Usage for "${session.name}"`,
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
        await ctx.reply(lines.join("\n"), { message_thread_id: topicThreadId });
        return;
      }
    }

    // Otherwise show usage for all sessions in this chat
    const sessions = sessionManager.getAllForChannel("telegram").filter(
      (s) => (s.channelMeta as any)?.chatId === chatId
    );
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
      return `\u2022 ${s.name}: \u2193${formatTokens(u.input_tokens)} \u2191${formatTokens(u.output_tokens)} (${s.totalTurns ?? 0} turns)`;
    });

    const summary = [
      `\ud83d\udcca Usage across all sessions`,
      ``,
      ...lines,
      ``,
      `Total: \u2193${formatTokens(totalInput)} \u2191${formatTokens(totalOutput)} (${totalTurns} turns)`,
    ];
    if (totalCache) {
      summary.push(`Cache read: ${formatTokens(totalCache)}`);
    }

    await ctx.reply(summary.join("\n"), threadOpts(ctx));
  }

  async function handleRepos(ctx: Context): Promise<void> {
    const repos = sessionManager.listRepos();

    if (repos.length === 0) {
      await ctx.reply("No path restrictions configured. Any path is allowed.", threadOpts(ctx));
      return;
    }

    const lines = repos.map((r) => `\u2022 ${r}`);
    await ctx.reply(
      `\ud83d\udcc2 Available projects:\n\n${lines.join("\n")}\n\nUse: /new <path> [name]`,
      threadOpts(ctx)
    );
  }

  async function handleVerbosity(ctx: Context): Promise<void> {
    const chatId = ctx.chat?.id;
    if (!chatId) return;

    const topicThreadId = ctx.message?.message_thread_id;
    if (!topicThreadId) {
      await ctx.reply("\u26a0\ufe0f Use /verbosity inside a session topic.", threadOpts(ctx));
      return;
    }

    const threadId = `${chatId}:${topicThreadId}`;
    const session = sessionManager.getByThread(threadId);
    if (!session) {
      await ctx.reply("\u26a0\ufe0f This topic is not a tracked session.", { message_thread_id: topicThreadId });
      return;
    }

    const text = ctx.message?.text || "";
    const match = text.match(/^\/verbosity(?:@\S+)?\s+(\d+)$/);

    if (!match) {
      const current = session.verbosity ?? 2;
      await ctx.reply(
        `\ud83d\udd27 Tool verbosity: ${current}\n\n` +
          `1 \u2014 Hide tool messages\n` +
          `2 \u2014 Show tool cards with inputs\n\n` +
          `Usage: /verbosity <1|2>`,
        { message_thread_id: topicThreadId }
      );
      return;
    }

    const level = parseInt(match[1], 10);
    if (level < 1 || level > 2) {
      await ctx.reply("\u26a0\ufe0f Verbosity must be 1 or 2.", { message_thread_id: topicThreadId });
      return;
    }

    sessionManager.updateVerbosity(session.id, level);

    const labels = ["", "Hide tool messages", "Show tool cards"];
    await ctx.reply(
      `\u2705 Verbosity set to ${level} \u2014 ${labels[level]}`,
      { message_thread_id: topicThreadId }
    );
  }

  async function handleArchive(ctx: Context): Promise<void> {
    const chatId = ctx.chat?.id;
    if (!chatId) return;

    const topicThreadId = ctx.message?.message_thread_id;
    if (!topicThreadId) {
      await ctx.reply("\u26a0\ufe0f Use /archive inside a session topic.", threadOpts(ctx));
      return;
    }

    const threadId = `${chatId}:${topicThreadId}`;
    const session = sessionManager.getByThread(threadId);
    if (!session) {
      await ctx.reply("\u26a0\ufe0f This topic is not a tracked session.", { message_thread_id: topicThreadId });
      return;
    }

    await ctx.reply(`\ud83d\udce6 Session "${session.name}" archived. Use /new to reopen or resume later.`, {
      message_thread_id: topicThreadId,
    });

    try {
      await ctx.api.closeForumTopic(chatId, topicThreadId);
    } catch {
      await ctx.reply("\u26a0\ufe0f Could not close the topic. You may need to close it manually.", {
        message_thread_id: topicThreadId,
      });
    }
  }

  async function handleUnarchive(ctx: Context): Promise<void> {
    const chatId = ctx.chat?.id;
    if (!chatId) return;

    const topicThreadId = ctx.message?.message_thread_id;
    if (!topicThreadId) {
      await ctx.reply("\u26a0\ufe0f Use /unarchive inside an archived session topic.", threadOpts(ctx));
      return;
    }

    const threadId = `${chatId}:${topicThreadId}`;
    const session = sessionManager.getByThread(threadId);
    if (!session) {
      await ctx.reply("\u26a0\ufe0f This topic is not a tracked session.", { message_thread_id: topicThreadId });
      return;
    }

    try {
      await ctx.api.reopenForumTopic(chatId, topicThreadId);
      await ctx.reply(`\ud83d\udce4 Session "${session.name}" unarchived. You can continue chatting.`, {
        message_thread_id: topicThreadId,
      });
    } catch {
      await ctx.reply("\u26a0\ufe0f Could not reopen the topic. You may need to reopen it manually.", {
        message_thread_id: topicThreadId,
      });
    }
  }

  async function handleRestart(ctx: Context): Promise<void> {
    await ctx.reply("\u267b\ufe0f Restarting...", threadOpts(ctx));
    orchestrator.restart();
  }

  async function handleUpdate(ctx: Context): Promise<void> {
    await ctx.reply("\ud83d\udce5 Pulling latest changes...", threadOpts(ctx));

    try {
      const result = await orchestrator.update();
      await ctx.reply(`\ud83d\udce5 ${result.pulled}`, threadOpts(ctx));

      if (!result.built) {
        return;
      }

      await ctx.reply("\u2705 Build complete. \u267b\ufe0f Restarting...", threadOpts(ctx));
      orchestrator.restart();
    } catch (err: any) {
      const stderr = err?.stderr?.toString?.() || "";
      const msg = stderr || err?.message || "Unknown error";
      await ctx.reply(`\u26a0\ufe0f Update failed:\n${msg}`, threadOpts(ctx));
    }
  }

  return {
    handleStart,
    handleHelp,
    handleNew,
    handleReset,
    handleDelete,
    handleArchive,
    handleUnarchive,
    handleSessions,
    handleUsage,
    handleRepos,
    handleVerbosity,
    handleRestart,
    handleUpdate,
  };
}
