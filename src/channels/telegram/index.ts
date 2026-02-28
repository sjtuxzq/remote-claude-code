import { Bot } from "grammy";
import type { Orchestrator } from "../../core/orchestrator.js";
import { createMessageChannel } from "../../core/types.js";
import { createAuthMiddleware, type TelegramConfig } from "./auth.js";
import { createCommandHandlers } from "./commands.js";
import { createMessageHandler } from "./message.js";
import { TelegramTransport } from "./streamer.js";

export async function startTelegram(
  orchestrator: Orchestrator,
  telegramConfig: TelegramConfig
): Promise<void> {
  const bot = new Bot(telegramConfig.botToken);

  // Create message channel — two endpoints connected by async queues
  const [transportEnd, orchestratorEnd] = createMessageChannel();

  // Orchestrator gets one end
  orchestrator.register("telegram", orchestratorEnd);

  // Telegram transport gets the other end
  const transport = new TelegramTransport(bot.api, transportEnd);

  console.log(`[telegram] Channel connected`);

  // Auth middleware — must be first
  bot.use(createAuthMiddleware(telegramConfig));

  // Command handlers
  const commands = createCommandHandlers(orchestrator);
  bot.command("start", commands.handleStart);
  bot.command("help", commands.handleHelp);
  bot.command("new", commands.handleNew);
  bot.command("reset", commands.handleReset);
  bot.command("delete", commands.handleDelete);
  bot.command("sessions", commands.handleSessions);
  bot.command("usage", commands.handleUsage);
  bot.command("repos", commands.handleRepos);
  bot.command("verbosity", commands.handleVerbosity);
  bot.command("restart", commands.handleRestart);
  bot.command("update", commands.handleUpdate);

  // Message handler — catch-all for topic messages
  const messageHandler = createMessageHandler(transport);
  bot.on("message:text", messageHandler);

  // Error handler
  bot.catch((err) => {
    console.error("Bot error:", err);
  });

  console.log("\ud83e\udd16 Claude Code Remote Bot starting...");
  console.log(`   Allowed users: ${telegramConfig.allowedUserIds.join(", ")}`);

  // Set bot commands on startup
  await bot.api.setMyCommands([
    { command: "new", description: "Start a new session (/new <name|path> [session-name])" },
    { command: "reset", description: "Reset session in current topic" },
    { command: "delete", description: "Delete session and close topic" },
    { command: "sessions", description: "List all sessions" },
    { command: "usage", description: "Show token usage" },
    { command: "repos", description: "List available project paths" },
    { command: "verbosity", description: "Set tool verbosity (1=hide, 2=collapsed, 3=expanded)" },
    { command: "restart", description: "Restart the bot" },
    { command: "update", description: "Pull latest code, build, and restart" },
    { command: "help", description: "Show help message" },
  ]);
  console.log("\ud83d\udccb Bot commands registered");

  bot.start({
    onStart: (botInfo) => {
      console.log(`\u2705 Bot started as @${botInfo.username}`);
    },
  });

  // Graceful shutdown
  const shutdown = () => {
    console.log("\n\ud83d\uded1 Shutting down...");
    bot.stop();
    process.exit(0);
  };

  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}
