import { Bot } from "grammy";
import { config } from "./config.js";
import { authMiddleware } from "./middleware/auth.js";
import { createCommandHandlers } from "./handlers/commands.js";
import { createMessageHandler } from "./handlers/message.js";
import { SessionStore } from "./store/sessions.js";

export function createBot(): Bot {
  const bot = new Bot(config.botToken);
  const store = new SessionStore();

  // Auth middleware — must be first
  bot.use(authMiddleware);

  // Command handlers
  const commands = createCommandHandlers(store);
  bot.command("start", commands.handleStart);
  bot.command("help", commands.handleHelp);
  bot.command("new", commands.handleNew);
  bot.command("reset", commands.handleReset);
  bot.command("delete", commands.handleDelete);
  bot.command("sessions", commands.handleSessions);
  bot.command("usage", commands.handleUsage);
  bot.command("repos", commands.handleRepos);
  bot.command("verbosity", commands.handleVerbosity);

  // Message handler — catch-all for topic messages
  const messageHandler = createMessageHandler(store);
  bot.on("message:text", messageHandler);

  // Error handler
  bot.catch((err) => {
    console.error("Bot error:", err);
  });

  return bot;
}
