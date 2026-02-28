import * as fs from "node:fs";
import * as path from "node:path";
import * as crypto from "node:crypto";
import type { Session, TokenUsage, CoreConfig } from "../core/types.js";

// Legacy session format (pre-refactor) for migration
interface LegacySession {
  threadId: number;
  chatId: number;
  userId: number;
  claudeSessionId?: string | null;
  agentSessionId?: string | null;
  projectPath: string;
  name: string;
  createdAt: string;
  lastActiveAt: string;
  totalUsage: TokenUsage;
  totalDurationMs: number;
  totalTurns: number;
  verbosity?: number;
}

function isLegacySession(s: any): s is LegacySession {
  return (typeof s.chatId === "number" && typeof s.threadId === "number" && !s.id) ||
    (s.claudeSessionId !== undefined && s.agentSessionId === undefined);
}

function migrateLegacySession(legacy: LegacySession): Session {
  // Handle both old Telegram format (chatId+threadId numbers) and claudeSessionId rename
  const isOldTelegram = typeof legacy.chatId === "number" && typeof legacy.threadId === "number" && !(legacy as any).id;

  if (isOldTelegram) {
    return {
      id: crypto.randomUUID(),
      threadId: `${legacy.chatId}:${legacy.threadId}`,
      channel: "telegram",
      agentSessionId: legacy.claudeSessionId ?? legacy.agentSessionId ?? null,
      projectPath: legacy.projectPath,
      name: legacy.name,
      createdAt: legacy.createdAt,
      lastActiveAt: legacy.lastActiveAt,
      totalUsage: legacy.totalUsage ?? { input_tokens: 0, output_tokens: 0 },
      totalDurationMs: legacy.totalDurationMs ?? 0,
      totalTurns: legacy.totalTurns ?? 0,
      verbosity: legacy.verbosity,
      channelMeta: {
        chatId: legacy.chatId,
        threadId: legacy.threadId,
        userId: legacy.userId,
      },
    };
  }

  // Just rename claudeSessionId → agentSessionId
  const s = legacy as any;
  s.agentSessionId = s.claudeSessionId ?? s.agentSessionId ?? null;
  delete s.claudeSessionId;
  return s as Session;
}

export class SessionManager {
  private filePath: string;
  private sessions: Session[];
  private config: CoreConfig;

  constructor(config: CoreConfig) {
    this.config = config;
    this.filePath = path.resolve(config.dataDir, "sessions.json");
    this.sessions = this.load();
  }

  private load(): Session[] {
    try {
      if (fs.existsSync(this.filePath)) {
        const data = fs.readFileSync(this.filePath, "utf-8");
        const raw: any[] = JSON.parse(data);

        let migrated = 0;
        const sessions: Session[] = raw.map((s) => {
          if (isLegacySession(s)) {
            migrated++;
            return migrateLegacySession(s);
          }
          return s as Session;
        });

        if (migrated > 0) {
          console.log(`[sessions] Migrated ${migrated} sessions to new format`);
          // Save migrated format immediately
          this.sessions = sessions;
          this.save();
        }

        return sessions;
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

  create(opts: {
    threadId: string;
    channel: string;
    projectPath: string;
    name: string;
    channelMeta?: Record<string, unknown>;
    verbosity?: number;
    worktree?: { repoPath: string; branch: string; worktreePath: string };
  }): Session {
    const now = new Date().toISOString();
    const session: Session = {
      id: crypto.randomUUID(),
      threadId: opts.threadId,
      channel: opts.channel,
      agentSessionId: null,
      projectPath: opts.projectPath,
      name: opts.name,
      createdAt: now,
      lastActiveAt: now,
      totalUsage: { input_tokens: 0, output_tokens: 0 },
      totalDurationMs: 0,
      totalTurns: 0,
      verbosity: opts.verbosity,
      worktree: opts.worktree,
      channelMeta: opts.channelMeta,
    };
    this.sessions.push(session);
    this.save();
    return session;
  }

  getById(id: string): Session | undefined {
    return this.sessions.find((s) => s.id === id);
  }

  getByThread(threadId: string): Session | undefined {
    return this.sessions.find((s) => s.threadId === threadId);
  }

  getAllForChannel(channel: string): Session[] {
    return this.sessions.filter((s) => s.channel === channel);
  }

  updateAgentSessionId(id: string, agentSessionId: string): void {
    const session = this.getById(id);
    if (session) {
      session.agentSessionId = agentSessionId;
      this.save();
    }
  }

  updateVerbosity(id: string, verbosity: number): void {
    const session = this.getById(id);
    if (session) {
      session.verbosity = verbosity;
      this.save();
    }
  }

  touch(id: string): void {
    const session = this.getById(id);
    if (session) {
      session.lastActiveAt = new Date().toISOString();
      this.save();
    }
  }

  addUsage(id: string, usage: TokenUsage, durationMs: number, turns: number): void {
    const session = this.getById(id);
    if (!session) return;

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

  resetSession(id: string): boolean {
    const session = this.getById(id);
    if (!session) return false;
    session.agentSessionId = null;
    session.totalUsage = { input_tokens: 0, output_tokens: 0 };
    session.totalDurationMs = 0;
    session.totalTurns = 0;
    session.lastActiveAt = new Date().toISOString();
    this.save();
    return true;
  }

  deleteSession(id: string): boolean {
    const idx = this.sessions.findIndex((s) => s.id === id);
    if (idx === -1) return false;
    this.sessions.splice(idx, 1);
    this.save();
    return true;
  }

  // === Utilities ===

  /**
   * Resolve a user input to a project path.
   * If the input looks like a path, resolve it directly.
   * Otherwise, search allowed paths for a case-insensitive match.
   */
  validateProjectPath(input: string): { path: string | null; error: string | null } {
    const looksLikePath = input.startsWith("/") || input.startsWith("\\") ||
      input.startsWith("./") || input.startsWith("..") ||
      /^[A-Za-z]:[/\\]/.test(input);

    if (looksLikePath || this.config.allowedPaths.length === 0) {
      const resolved = path.resolve(input);
      return this.checkPathAllowed(resolved);
    }

    // Search allowed paths for a matching subdirectory by name (case-insensitive)
    const needle = input.toLowerCase();
    const matches: string[] = [];

    for (const allowedPath of this.config.allowedPaths) {
      const resolved = path.resolve(allowedPath);
      try {
        const entries = fs.readdirSync(resolved, { withFileTypes: true });
        for (const entry of entries) {
          if (entry.isDirectory() && entry.name.toLowerCase() === needle) {
            matches.push(path.join(resolved, entry.name));
          }
        }
      } catch {
        // Skip inaccessible paths
      }
    }

    if (matches.length === 1) {
      return { path: matches[0], error: null };
    }

    if (matches.length > 1) {
      const list = matches.map((m) => `  ${m}`).join("\n");
      return {
        path: null,
        error: `Ambiguous name "${input}" \u2014 multiple matches:\n${list}\n\nUse the full path instead.`,
      };
    }

    // No match found \u2014 fall back to treating it as a path
    const resolved = path.resolve(input);
    return this.checkPathAllowed(resolved);
  }

  private checkPathAllowed(resolved: string): { path: string | null; error: string | null } {
    if (this.config.allowedPaths.length > 0) {
      const allowed = this.config.allowedPaths.some((p) => {
        const resolvedAllowed = path.resolve(p);
        return resolved.startsWith(resolvedAllowed);
      });
      if (!allowed) {
        return {
          path: null,
          error: `Path not allowed: ${resolved}\n\nAllowed paths:\n${this.config.allowedPaths.map((p) => `  ${p}`).join("\n")}`,
        };
      }
    }

    // Validate path exists and is a directory
    try {
      const stat = fs.statSync(resolved);
      if (!stat.isDirectory()) {
        return { path: null, error: `Path is not a directory: ${resolved}` };
      }
    } catch {
      return { path: null, error: `Path does not exist: ${resolved}` };
    }

    return { path: resolved, error: null };
  }

  listRepos(): string[] {
    if (this.config.allowedPaths.length === 0) return [];

    const repos: string[] = [];
    for (const allowedPath of this.config.allowedPaths) {
      const resolved = path.resolve(allowedPath);
      try {
        const entries = fs.readdirSync(resolved, { withFileTypes: true });
        for (const entry of entries) {
          if (entry.isDirectory()) {
            repos.push(path.join(resolved, entry.name));
          }
        }
      } catch {
        repos.push(`(not accessible) ${resolved}`);
      }
    }
    return repos;
  }

  /** Enable worktree on an existing session. Updates projectPath, worktree, and resets agentSessionId. */
  enableWorktree(
    id: string,
    worktree: { repoPath: string; branch: string; worktreePath: string }
  ): boolean {
    const session = this.getById(id);
    if (!session) return false;
    session.worktree = worktree;
    session.projectPath = worktree.worktreePath;
    session.agentSessionId = null; // cwd changed, old session invalid
    this.save();
    return true;
  }

  /** Find all sessions targeting the same base repo (by worktree.repoPath or projectPath). */
  getSessionsForRepo(repoPath: string): Session[] {
    return this.sessions.filter(
      (s) => s.worktree?.repoPath === repoPath || s.projectPath === repoPath
    );
  }
}
