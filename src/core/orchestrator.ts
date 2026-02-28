import { execSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import * as path from "node:path";
import * as crypto from "node:crypto";
import type { Agent, AgentRequest } from "./agent.js";
import type { SessionManager } from "../store/sessions.js";
import type { CoreConfig, ChannelEndpoint } from "./types.js";
import { getDefaultBranch, removeWorktree } from "../git/worktree.js";
import { CODING_INSTRUCTION } from "../prompts/instructions.js";

const __filename = fileURLToPath(import.meta.url);
const PROJECT_ROOT = path.resolve(path.dirname(__filename), "..", "..");

// Per-session state (in-memory, not persisted)
interface SessionState {
  running: boolean;
  awaitingAnswer: boolean;
  review?: {
    round: number;
    maxRounds: number;
    active: boolean;
  };
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

    // For worktree sessions, inject review instruction on first message
    let prompt = text;
    if (session.worktree && !session.agentSessionId) {
      prompt += `\n\n[IMPORTANT: ${CODING_INSTRUCTION}]`;
    }

    // For new sessions, generate a UUID upfront so we know the session ID immediately
    let newSessionId: string | undefined;
    if (!session.agentSessionId) {
      newSessionId = crypto.randomUUID();
      this.sessionManager.updateAgentSessionId(sessionId, newSessionId);
    }

    const request: AgentRequest = {
      prompt,
      threadId,
      endpoint,
      agentSessionId: session.agentSessionId,
      newSessionId,
      projectPath: session.projectPath,
      config: {
        maxTurns: this.config.maxTurnsPerMessage,
        maxBudget: this.config.maxBudgetPerMessage,
        verbosity: session.verbosity ?? 2,
      },
    };

    try {
      const result = await this.agent.run(request);

      // agentSessionId is already persisted before agent.run() for new sessions

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
          state.running = false;
        }
        this.sessionManager.touch(sessionId);
        return;
      }

      // Auto-trigger review pipeline when agent signals READY_FOR_REVIEW
      const resultText = result.resultText ?? "";
      if (session.worktree && resultText.includes("READY_FOR_REVIEW")) {
        // Clean up running state before entering review pipeline
        const state = this.sessionStates.get(sessionId);
        if (state) {
          state.running = false;
        }
        this.sessionManager.touch(sessionId);

        // Fire off review pipeline
        await this.runReviewPipeline(sessionId, threadId, endpoint);
        return;
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
        if (!state.awaitingAnswer && !state.review?.active) {
          this.sessionStates.delete(sessionId);
        }
      }
      this.sessionManager.touch(sessionId);
    }
  }

  /**
   * Autonomous review pipeline.
   *
   * 1. Spawns a fresh reviewer Claude on the original repo
   * 2. Reviewer diffs the worktree branch vs default branch
   * 3. If approved → merges and cleans up worktree
   * 4. If feedback → sends feedback to coder, coder fixes, re-review
   * 5. Loops up to maxRounds
   */
  private async runReviewPipeline(
    sessionId: string,
    threadId: string,
    endpoint: ChannelEndpoint
  ): Promise<void> {
    const maxRounds = this.config.maxReviewRounds;

    // Initialize review state
    let state = this.sessionStates.get(sessionId) ?? {
      running: false,
      awaitingAnswer: false,
    };
    state.review = {
      round: 0,
      maxRounds,
      active: true,
    };
    this.sessionStates.set(sessionId, state);

    try {
      for (let round = 1; round <= maxRounds; round++) {
        // Re-fetch session to get latest agentSessionId
        const session = this.sessionManager.getById(sessionId);
        if (!session?.worktree) {
          console.log(`[orchestrator] Session ${sessionId} no longer has worktree, stopping review`);
          return;
        }

        state.review!.round = round;

        // --- Run Reviewer ---
        const defaultBranch = getDefaultBranch(session.worktree.repoPath);
        const branch = session.worktree.branch;

        endpoint.send(threadId, {
          type: "text",
          text: `─── \ud83d\udd0d Auto-review round ${round}/${maxRounds} ───`,
          subtype: "notice",
        });

        console.log(`[orchestrator] Review round ${round}/${maxRounds} for session "${session.name}"`);
        console.log(`[orchestrator] Reviewing branch "${branch}" vs "${defaultBranch}"`);

        const reviewPrompt = [
          `You are a code reviewer. Review the changes on git branch "${branch}" compared to "${defaultBranch}".`,
          ``,
          `Steps:`,
          `1. Run: git diff ${defaultBranch}...${branch}`,
          `2. Review the diff for correctness, code quality, bugs, and style.`,
          `3. If everything looks good and ready to merge:`,
          `   - Run: git checkout ${defaultBranch}`,
          `   - Run: git merge ${branch} --no-edit`,
          `   - Respond with REVIEW_APPROVED on its own line, followed by a brief summary.`,
          `4. If there are issues:`,
          `   - Respond with REVIEW_FEEDBACK on its own line, followed by specific,`,
          `     actionable feedback items the developer should fix.`,
          ``,
          `Do NOT create new branches or make changes yourself. Only merge or give feedback.`,
        ].join("\n");

        const reviewRequest: AgentRequest = {
          prompt: reviewPrompt,
          threadId,
          endpoint,
          agentSessionId: null, // Fresh session for each review
          projectPath: session.worktree.repoPath, // Review from original repo
          config: {
            maxTurns: this.config.maxTurnsPerMessage,
            maxBudget: this.config.maxBudgetPerMessage,
            verbosity: session.verbosity ?? 2,
          },
        };

        state.running = true;
        const reviewResult = await this.agent.run(reviewRequest);
        state.running = false;

        // Persist reviewer usage to the session
        this.sessionManager.addUsage(
          sessionId,
          reviewResult.usage,
          reviewResult.durationMs,
          reviewResult.numTurns
        );

        // Parse reviewer output
        const resultText = reviewResult.resultText ?? "";
        const approved = resultText.includes("REVIEW_APPROVED");
        const hasFeedback = resultText.includes("REVIEW_FEEDBACK");

        if (approved) {
          // Reviewer merged the branch — clean up worktree
          console.log(`[orchestrator] Review APPROVED for session "${session.name}"`);

          endpoint.send(threadId, {
            type: "text",
            text: `\u2705 Branch "${branch}" merged into "${defaultBranch}"!\nWorktree cleaned up.`,
            subtype: "notice",
          });

          // Remove worktree (preserve branch in git history)
          try {
            removeWorktree(
              session.worktree.repoPath,
              session.worktree.worktreePath,
              session.worktree.branch,
              false // Don't delete branch
            );
          } catch (err: any) {
            console.error(`[orchestrator] Failed to remove worktree:`, err?.message);
          }

          return;
        }

        if (hasFeedback && round < maxRounds) {
          // Extract feedback text after the marker
          const feedbackIdx = resultText.indexOf("REVIEW_FEEDBACK");
          const feedback = feedbackIdx >= 0
            ? resultText.substring(feedbackIdx + "REVIEW_FEEDBACK".length).trim()
            : resultText;

          console.log(`[orchestrator] Review FEEDBACK for session "${session.name}", sending to coder`);

          endpoint.send(threadId, {
            type: "text",
            text: `─── \ud83d\udd04 Sending feedback to coder (round ${round + 1}/${maxRounds}) ───`,
            subtype: "notice",
          });

          // Build feedback prompt for the coding Claude
          const feedbackPrompt = [
            `A code reviewer examined your changes (branch "${branch}" vs "${defaultBranch}") and found issues.`,
            `Please address this feedback, then commit your fixes.`,
            `When done, include READY_FOR_REVIEW on its own line in your response.`,
            ``,
            feedback,
          ].join("\n");

          // Re-fetch session to get latest agentSessionId
          const freshSession = this.sessionManager.getById(sessionId);
          if (!freshSession) {
            console.error(`[orchestrator] Session ${sessionId} disappeared during review`);
            return;
          }

          const coderRequest: AgentRequest = {
            prompt: feedbackPrompt,
            threadId,
            endpoint,
            agentSessionId: freshSession.agentSessionId, // Resume coding session
            projectPath: freshSession.projectPath, // Worktree path
            config: {
              maxTurns: this.config.maxTurnsPerMessage,
              maxBudget: this.config.maxBudgetPerMessage,
              verbosity: freshSession.verbosity ?? 2,
            },
          };

          state.running = true;
          const coderResult = await this.agent.run(coderRequest);
          state.running = false;

          // Persist coder usage
          this.sessionManager.addUsage(
            sessionId,
            coderResult.usage,
            coderResult.durationMs,
            coderResult.numTurns
          );

          // Update agent session ID if it changed
          // (shouldn't change for resumed sessions, but safety net)
          if (coderResult.agentSessionId && coderResult.agentSessionId !== freshSession.agentSessionId) {
            this.sessionManager.updateAgentSessionId(
              sessionId,
              coderResult.agentSessionId
            );
          }

          // If coder asked a question, pause review and let user answer
          if (coderResult.questionAsked) {
            console.log(`[orchestrator] Coder asked a question during review round ${round}, pausing review`);
            state.awaitingAnswer = true;
            // When user answers → handleMessage → runAgent → completion triggers runReviewPipeline again
            return;
          }

          // Otherwise, continue the loop — next iteration will run the reviewer again
          continue;
        }

        // Either feedback on last round, or no marker found (treat as feedback/inconclusive)
        if (round >= maxRounds) {
          console.log(`[orchestrator] Max review rounds (${maxRounds}) reached for session "${session.name}"`);

          endpoint.send(threadId, {
            type: "text",
            text: [
              `\u26a0\ufe0f Max review rounds (${maxRounds}) reached.`,
              `Branch "${branch}" is NOT merged.`,
              `You can continue working and send another message, or delete the session to abandon.`,
            ].join("\n"),
            subtype: "notice",
          });
          return;
        }
      }
    } catch (err: any) {
      console.error(`[orchestrator] Review pipeline error for session ${sessionId}:`, err);

      endpoint.send(threadId, {
        type: "text",
        text: `\u26a0\ufe0f Review pipeline error: ${err?.message || "Unknown error"}`,
        subtype: "notice",
      });
    } finally {
      // Clean up review state
      const finalState = this.sessionStates.get(sessionId);
      if (finalState) {
        finalState.running = false;
        if (finalState.review) {
          finalState.review.active = false;
        }
        if (!finalState.awaitingAnswer) {
          this.sessionStates.delete(sessionId);
        }
      }
      this.sessionManager.touch(sessionId);
    }
  }
}
