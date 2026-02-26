import * as fs from "node:fs";
import * as path from "node:path";
import type { Session, TokenUsage } from "../types.js";
import { config } from "../config.js";

export class SessionStore {
  private filePath: string;
  private sessions: Session[];

  constructor() {
    this.filePath = path.resolve(config.dataDir, "sessions.json");
    this.sessions = this.load();
  }

  private load(): Session[] {
    try {
      if (fs.existsSync(this.filePath)) {
        const data = fs.readFileSync(this.filePath, "utf-8");
        return JSON.parse(data);
      }
    } catch (err) {
      console.error("Failed to load sessions, starting fresh:", err);
    }
    return [];
  }

  private save(): void {
    const dir = path.dirname(this.filePath);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }
    fs.writeFileSync(this.filePath, JSON.stringify(this.sessions, null, 2), "utf-8");
  }

  create(session: Session): Session {
    this.sessions.push(session);
    this.save();
    return session;
  }

  getByThread(chatId: number, threadId: number): Session | undefined {
    return this.sessions.find(
      (s) => s.chatId === chatId && s.threadId === threadId
    );
  }

  getAllForChat(chatId: number): Session[] {
    return this.sessions.filter((s) => s.chatId === chatId);
  }

  updateClaudeSessionId(
    chatId: number,
    threadId: number,
    claudeSessionId: string
  ): void {
    const session = this.getByThread(chatId, threadId);
    if (session) {
      session.claudeSessionId = claudeSessionId;
      this.save();
    }
  }

  touch(chatId: number, threadId: number): void {
    const session = this.getByThread(chatId, threadId);
    if (session) {
      session.lastActiveAt = new Date().toISOString();
      this.save();
    }
  }

  addUsage(
    chatId: number,
    threadId: number,
    usage: TokenUsage,
    durationMs: number,
    turns: number
  ): void {
    const session = this.getByThread(chatId, threadId);
    if (!session) return;

    // Initialize if missing (backwards compat with old session data)
    if (!session.totalUsage) {
      session.totalUsage = { input_tokens: 0, output_tokens: 0 };
    }
    session.totalUsage.input_tokens += usage.input_tokens;
    session.totalUsage.output_tokens += usage.output_tokens;
    session.totalUsage.cache_read_input_tokens =
      (session.totalUsage.cache_read_input_tokens ?? 0) +
      (usage.cache_read_input_tokens ?? 0);
    session.totalUsage.cache_creation_input_tokens =
      (session.totalUsage.cache_creation_input_tokens ?? 0) +
      (usage.cache_creation_input_tokens ?? 0);
    session.totalDurationMs = (session.totalDurationMs ?? 0) + durationMs;
    session.totalTurns = (session.totalTurns ?? 0) + turns;
    this.save();
  }

  resetSession(chatId: number, threadId: number): boolean {
    const session = this.getByThread(chatId, threadId);
    if (!session) return false;
    session.claudeSessionId = null;
    session.totalUsage = { input_tokens: 0, output_tokens: 0 };
    session.totalDurationMs = 0;
    session.totalTurns = 0;
    session.lastActiveAt = new Date().toISOString();
    this.save();
    return true;
  }

  deleteSession(chatId: number, threadId: number): boolean {
    const idx = this.sessions.findIndex(
      (s) => s.chatId === chatId && s.threadId === threadId
    );
    if (idx === -1) return false;
    this.sessions.splice(idx, 1);
    this.save();
    return true;
  }
}
