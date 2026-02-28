import type { ChannelEndpoint, TokenUsage } from "./types.js";

// === Agent Request ===

export interface AgentRequest {
  prompt: string;
  threadId: string;
  endpoint: ChannelEndpoint; // Agent sends ChannelMessages here
  agentSessionId: string | null; // For resume (Claude) or thread (OpenAI)
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
}

// === Agent Interface ===

export interface Agent {
  readonly name: string;
  run(request: AgentRequest): Promise<AgentResult>;
}
