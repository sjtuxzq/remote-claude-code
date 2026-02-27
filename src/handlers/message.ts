import type { Context } from "grammy";
import { runClaude } from "../claude/runner.js";
import { TelegramStreamer } from "../telegram/streamer.js";
import type { SessionStore } from "../store/sessions.js";
import type { RunnerCallbacks, AskUserQuestionInput } from "../types.js";
import { config } from "../config.js";

// Per-topic state
interface TopicState {
  running: boolean;
  // If Claude asked a question before exiting, store it here
  // Next user message will be sent as the answer via a new --resume run
  awaitingAnswer: boolean;
}

const topicStates = new Map<string, TopicState>();

function topicKey(chatId: number, threadId: number): string {
  return `${chatId}:${threadId}`;
}

function formatQuestion(input: AskUserQuestionInput): string {
  const lines: string[] = ["❓ Claude is asking:\n"];
  for (const q of input.questions) {
    lines.push(q.question);
    if (q.options && q.options.length > 0) {
      for (let i = 0; i < q.options.length; i++) {
        const opt = q.options[i];
        const desc = opt.description ? ` — ${opt.description}` : "";
        lines.push(`  ${i + 1}. ${opt.label}${desc}`);
      }
    }
    if (q.multiSelect) {
      lines.push("(You can pick multiple, e.g. \"1, 3\")");
    }
    lines.push("");
  }
  lines.push("Reply with your answer:");
  return lines.join("\n");
}

function buildArgs(prompt: string, session: { claudeSessionId: string | null }): string[] {
  const args: string[] = [
    "-p",
    prompt,
    "--output-format",
    "stream-json",
    "--verbose",
    "--include-partial-messages",
    "--dangerously-skip-permissions",
  ];

  if (session.claudeSessionId) {
    args.push("--resume", session.claudeSessionId);
  }

  if (config.maxTurnsPerMessage) {
    args.push("--max-turns", config.maxTurnsPerMessage.toString());
  }

  if (config.maxBudgetPerMessage) {
    args.push("--max-budget-usd", config.maxBudgetPerMessage.toString());
  }

  return args;
}

export function createMessageHandler(store: SessionStore) {

  async function runClaudeForTopic(
    chatId: number,
    threadId: number,
    prompt: string,
    session: ReturnType<SessionStore["getByThread"]> & {},
    api: Context["api"]
  ): Promise<void> {
    const key = topicKey(chatId, threadId);

    const args = buildArgs(prompt, session);
    console.log(`[message] Claude args: ${args.join(" ")}`);

    const streamer = new TelegramStreamer(api, chatId, threadId, session.verbosity ?? 2);
    let lastToolName = "tool";
    let questionAsked = false;

    const callbacks: RunnerCallbacks = {
      onSessionId: (sessionId) => {
        if (!session.claudeSessionId) {
          session.claudeSessionId = sessionId;
          store.updateClaudeSessionId(chatId, threadId, sessionId);
        }
      },
      onText: (text) => {
        streamer.append(text);
      },
      onToolUse: (name, input) => {
        lastToolName = name;
        streamer.sendToolCard(name, input);
      },
      onToolResult: (_name, isError) => {
        streamer.sendToolResult(lastToolName, isError);
      },
      onQuestion: (_toolUseId, input) => {
        console.log(`[message] AskUserQuestion received`);
        questionAsked = true;
        streamer.append("\n\n" + formatQuestion(input));
      },
      onError: (error) => {
        streamer.appendError(error);
      },
    };

    try {
      const { promise } = runClaude(args, session.projectPath, callbacks);
      const result = await promise;

      await streamer.finalize();

      if (result) {
        store.addUsage(chatId, threadId, result.usage, result.durationMs, result.numTurns);

        if (result.sessionId && !session.claudeSessionId) {
          store.updateClaudeSessionId(chatId, threadId, result.sessionId);
        }
      }

      // If Claude asked a question, mark topic as awaiting answer
      if (questionAsked) {
        const state = topicStates.get(key);
        if (state) {
          state.awaitingAnswer = true;
          state.running = false;
        }
      }
    } catch (err: any) {
      await streamer.finalize();
      await streamer.sendSummary(`⚠️ Error: ${err?.message || "Unknown error"}`);
    } finally {
      const state = topicStates.get(key);
      if (state) {
        state.running = false;
        // Clean up if not awaiting answer
        if (!state.awaitingAnswer) {
          topicStates.delete(key);
        }
      }
      store.touch(chatId, threadId);
    }
  }

  return async function handleMessage(ctx: Context): Promise<void> {
    const message = ctx.message;
    if (!message?.text) return;
    if (!message.message_thread_id) return;
    if (message.text.startsWith("/")) return;

    const chatId = ctx.chat?.id;
    if (!chatId) return;

    const threadId = message.message_thread_id;
    const session = store.getByThread(chatId, threadId);
    if (!session) return;

    const key = topicKey(chatId, threadId);
    const state = topicStates.get(key);

    // If Claude is currently running, reject
    if (state?.running) {
      await ctx.reply("⏳ Claude is already processing in this topic. Please wait.", {
        message_thread_id: threadId,
      });
      return;
    }

    // Whether this is a fresh message or an answer to a question,
    // we handle it the same way: run Claude with --resume and the user's text.
    // If awaiting answer, the session already has the claudeSessionId,
    // so --resume will continue the conversation with the answer as context.
    if (state?.awaitingAnswer) {
      console.log(`[message] User answered question: ${message.text.substring(0, 100)}`);
    }

    // Clear awaiting state
    topicStates.set(key, { running: true, awaitingAnswer: false });
    store.touch(chatId, threadId);

    console.log(`[message] Relaying to Claude in session "${session.name}" (thread ${threadId})`);
    console.log(`[message] Text: ${message.text.substring(0, 100)}...`);
    console.log(`[message] Claude session ID: ${session.claudeSessionId ?? "new"}`);
    console.log(`[message] Project path: ${session.projectPath}`);

    await runClaudeForTopic(chatId, threadId, message.text, session, ctx.api);
  };
}
