import * as fs from "node:fs";
import * as path from "node:path";
import { config } from "./config.js";
import { createBot } from "./bot.js";

// Ensure data directory exists
const dataDir = path.resolve(config.dataDir);
if (!fs.existsSync(dataDir)) {
  fs.mkdirSync(dataDir, { recursive: true });
  console.log(`Created data directory: ${dataDir}`);
}

// Create and start bot
const bot = createBot();

console.log("🤖 Claude Code Remote Bot starting...");
console.log(`   Allowed users: ${config.allowedUserIds.join(", ")}`);
console.log(`   Data dir: ${dataDir}`);

// Set bot commands on startup
await bot.api.setMyCommands([
  { command: "new", description: "Start a new session (/new <name|path> [session-name])" },
  { command: "reset", description: "Reset session in current topic" },
  { command: "delete", description: "Delete session and close topic" },
  { command: "sessions", description: "List all sessions" },
  { command: "usage", description: "Show token usage" },
  { command: "repos", description: "List available project paths" },
  { command: "verbosity", description: "Set tool verbosity (1=hide, 2=show)" },
  { command: "restart", description: "Restart the bot" },
  { command: "update", description: "Pull latest code, build, and restart" },
  { command: "help", description: "Show help message" },
]);
console.log("📋 Bot commands registered");

bot.start({
  onStart: (botInfo) => {
    console.log(`✅ Bot started as @${botInfo.username}`);
  },
});

// Graceful shutdown
const shutdown = () => {
  console.log("\n🛑 Shutting down...");
  bot.stop();
  process.exit(0);
};

process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
