import * as fs from "node:fs";
import * as path from "node:path";
import { coreConfig, channelType, getTelegramConfig } from "./config.js";
import { SessionManager } from "./store/sessions.js";
import { Orchestrator } from "./core/orchestrator.js";
import { ClaudeAgent } from "./agents/claude.js";

// Ensure data directory exists
const dataDir = path.resolve(coreConfig.dataDir);
if (!fs.existsSync(dataDir)) {
  fs.mkdirSync(dataDir, { recursive: true });
  console.log(`Created data directory: ${dataDir}`);
}

// Create shared core components
const sessionManager = new SessionManager(coreConfig);
const agent = new ClaudeAgent();
const orchestrator = new Orchestrator(sessionManager, coreConfig, agent);

console.log(`   Data dir: ${dataDir}`);
console.log(`   Channel: ${channelType}`);
console.log(`   Agent: ${agent.name}`);

// Boot the appropriate channel
if (channelType === "cli") {
  const { startCli } = await import("./channels/cli/index.js");
  await startCli(orchestrator);
} else if (channelType === "telegram") {
  const telegramConfig = getTelegramConfig();
  const { startTelegram } = await import("./channels/telegram/index.js");
  await startTelegram(orchestrator, telegramConfig);
} else {
  console.error(`Unknown channel type: ${channelType}`);
  console.error(`Supported channels: telegram, cli`);
  process.exit(1);
}
