import { execSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import * as path from "node:path";
import type { Agent, AgentRequest } from "./agent.js";
import type { SessionManager } from "../store/sessions.js";
import type { CoreConfig, ChannelEndpoint } from "./types.js";

const __filename = fileURLToPath(import.meta.url);
const PROJECT_ROOT = path.resolve(path.dirname(__filename), "..", "..");

// Per-session state (in-memory, not persisted)
interface SessionState {
  running: boolean;
  awaitingAnswer: boolean;
}

export class Orchestrator {
  private agent: Agent;
  private sessionManager: SessionManager;
  private config: CoreConfig;
  private sessionStates = new Map<string, SessionState>();
  private endpoints = new Map<string, ChannelEndpoint>();

  constructor(sessionManager: SessionManager, config: CoreConfig, agent: Agent) {
    this.sessionManager = sessionManager;
    this.config = config;
    this.agent = agent;
  }

  /**
   * Register a channel endpoint.  Starts a receive loop that pulls
   * inbound messages and dispatches them.
   */
  register(name: string, endpoint: ChannelEndpoint): void {
    this.endpoints.set(name, endpoint);
    this.receiveLoop(name, endpoint);
    console.log(`[orchestrator] Registered channel: ${name}`);
  }

  /** Expose session manager for channel-specific operations. */
  get sessions(): SessionManager {
    return this.sessionManager;
  }

  /** Restart the process (PM2 will auto-restart). */
  restart(): void {
    setTimeout(() => process.exit(0), 500);
  }

  /** Pull latest code and build. Returns pull output and whether a build was needed. */
  async update(): Promise<{ pulled: string; built: boolean }> {
    const pullOutput = execSync("git pull", {
      cwd: PROJECT_ROOT,
      encoding: "utf-8",
      timeout: 30000,
      windowsHide: true,
    });

    if (pullOutput.includes("Already up to date")) {
      return { pulled: pullOutput.trim(), built: false };
    }

    execSync("npm run build", {
      cwd: PROJECT_ROOT,
      encoding: "utf-8",
      timeout: 60000,
      windowsHide: true,
    });

    return { pulled: pullOutput.trim(), built: true };
  }

  // === Private ===

  /**
   * Continuously await messages from a channel endpoint and dispatch them.
   * Runs forever — one loop per registered channel.
   */
  private async receiveLoop(
    name: string,
    endpoint: ChannelEndpoint
  ): Promise<void> {
    while (true) {
      const { threadId, message } = await endpoint.receive();
      if (message.type !== "user") continue;
      this.handleMessage(endpoint, threadId, message.text);
    }
  }

  private handleMessage(
    endpoint: ChannelEndpoint,
    threadId: string,
    text: string
  ): void {
    const session = this.sessionManager.getByThread(threadId);
    if (!session) {
      console.error(`[orchestrator] No session for thread ${threadId}`);
      return;
    }

    // If agent is currently running, notify and reject
    if (this.sessionStates.get(session.id)?.running) {
      endpoint.send(threadId, {
        type: "text",
        text: "\u23f3 Agent is already processing. Please wait.",
        subtype: "notice",
      });
      return;
    }

    if (this.sessionStates.get(session.id)?.awaitingAnswer) {
      console.log(
        `[orchestrator] User answered question: ${text.substring(0, 100)}`
      );
    }

    console.log(
      `[orchestrator] Relaying to ${this.agent.name} in session "${session.name}" (thread ${threadId})`
    );
    console.log(`[orchestrator] Text: ${text.substring(0, 100)}...`);

    // Fire-and-forget — don't block the channel
    this.runAgent(session.id, text, threadId, endpoint).catch((err) =>
      console.error(`[orchestrator] Unhandled error in runAgent:`, err)
    );
  }

  private async runAgent(
    sessionId: string,
    text: string,
    threadId: string,
    endpoint: ChannelEndpoint
  ): Promise<void> {
    const session = this.sessionManager.getById(sessionId);
    if (!session) {
      throw new Error(`Session not found: ${sessionId}`);
    }

    // Mark as running
    this.sessionStates.set(sessionId, {
      running: true,
      awaitingAnswer: false,
    });
    this.sessionManager.touch(sessionId);

    console.log(`[orchestrator] Session "${session.name}" (${sessionId})`);
    console.log(`[orchestrator] Agent session ID: ${session.agentSessionId ?? "new"}`);
    console.log(`[orchestrator] Project path: ${session.projectPath}`);

    const request: AgentRequest = {
      prompt: text,
      threadId,
      endpoint,
      agentSessionId: session.agentSessionId,
      projectPath: session.projectPath,
      config: {
        maxTurns: this.config.maxTurnsPerMessage,
        maxBudget: this.config.maxBudgetPerMessage,
        verbosity: session.verbosity ?? 2,
      },
    };

    try {
      const result = await this.agent.run(request);

      // Persist agent session ID
      if (result.agentSessionId && !session.agentSessionId) {
        this.sessionManager.updateAgentSessionId(
          sessionId,
          result.agentSessionId
        );
      }

      // Persist usage
      this.sessionManager.addUsage(
        sessionId,
        result.usage,
        result.durationMs,
        result.numTurns
      );

      // If agent asked a question, mark session as awaiting answer
      if (result.questionAsked) {
        const state = this.sessionStates.get(sessionId);
        if (state) {
          state.awaitingAnswer = true;
        }
      }
    } catch (err: any) {
      endpoint.send(threadId, { type: "done" });
      endpoint.send(threadId, {
        type: "text",
        text: `\u26a0\ufe0f Error: ${err?.message || "Unknown error"}`,
        subtype: "notice",
      });
    } finally {
      const state = this.sessionStates.get(sessionId);
      if (state) {
        state.running = false;
        if (!state.awaitingAnswer) {
          this.sessionStates.delete(sessionId);
        }
      }
      this.sessionManager.touch(sessionId);
    }
  }
}
