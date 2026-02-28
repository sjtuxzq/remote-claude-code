import type { ChannelEndpoint, TokenUsage } from "./types.js";

// === Agent Request ===

export interface AgentRequest {
  prompt: string;
  threadId: string;
  endpoint: ChannelEndpoint; // Agent sends ChannelMessages here
  agentSessionId: string | null; // For resume (Claude) or thread (OpenAI)
  newSessionId?: string; // Pre-generated UUID for new sessions (avoids waiting for CLI output)
  projectPath: string;
  config: {
    maxTurns?: number;
    maxBudget?: number;
    verbosity?: number; // Agent skips tool msgs if < 2
  };
}

// === Agent Result ===

export interface AgentResult {
  agentSessionId?: string; // New/updated session ID for persistence
  durationMs: number;
  numTurns: number;
  usage: TokenUsage;
  questionAsked?: boolean; // True if agent asked the user a question (awaiting answer)
  resultText?: string; // Raw result text from agent (for review pipeline parsing)
}

// === Agent Interface ===

export interface Agent {
  readonly name: string;
  run(request: AgentRequest): Promise<AgentResult>;
}
