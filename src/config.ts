import "dotenv/config";
import type { CoreConfig } from "./core/types.js";
import type { TelegramConfig } from "./channels/telegram/auth.js";

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(`Missing required environment variable: ${name}`);
  }
  return value;
}

function optionalIntEnv(name: string): number | undefined {
  const value = process.env[name];
  if (!value) return undefined;
  const parsed = parseInt(value, 10);
  if (isNaN(parsed)) return undefined;
  return parsed;
}

function optionalFloatEnv(name: string): number | undefined {
  const value = process.env[name];
  if (!value) return undefined;
  const parsed = parseFloat(value);
  if (isNaN(parsed)) return undefined;
  return parsed;
}

function optionalIdListEnv(name: string): number[] {
  const value = process.env[name];
  if (!value) return [];
  return value
    .split(",")
    .map((id) => parseInt(id.trim(), 10))
    .filter((id) => !isNaN(id));
}

function optionalStringListEnv(name: string): string[] {
  const value = process.env[name];
  if (!value) return [];
  return value.split(",").map((s) => s.trim()).filter(Boolean);
}

/** Which channel to run. Defaults to "telegram". */
export const channelType: string = process.env.CHANNEL || "telegram";

/** Shared config — always validated regardless of channel. */
export const coreConfig: CoreConfig = {
  allowedPaths: optionalStringListEnv("ALLOWED_PATHS"),
  dataDir: process.env.DATA_DIR || "./data",
  maxTurnsPerMessage: optionalIntEnv("MAX_TURNS_PER_MESSAGE"),
  maxBudgetPerMessage: optionalFloatEnv("MAX_BUDGET_PER_MESSAGE"),
  maxReviewRounds: optionalIntEnv("MAX_REVIEW_ROUNDS") ?? 3,
};

/** Telegram-specific config — only validated when telegram channel boots. */
export function getTelegramConfig(): TelegramConfig {
  return {
    botToken: requireEnv("BOT_TOKEN"),
    allowedUserIds: requireEnv("ALLOWED_USER_IDS")
      .split(",")
      .map((id) => parseInt(id.trim(), 10))
      .filter((id) => !isNaN(id)),
    allowedChatIds: optionalIdListEnv("ALLOWED_CHAT_IDS"),
  };
}
