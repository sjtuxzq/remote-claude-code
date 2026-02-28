import * as readline from "node:readline";
import * as path from "node:path";
import type { Orchestrator } from "../../core/orchestrator.js";
import {
  createMessageChannel,
  type ChannelEndpoint,
  type ChannelMessage,
  type AskUserQuestionInput,
} from "../../core/types.js";
import {
  isGitRepo,
  getRepoRoot,
  createWorktree,
} from "../../git/worktree.js";

// ANSI color helpers
const dim = (s: string) => `\x1b[2m${s}\x1b[0m`;
const red = (s: string) => `\x1b[31m${s}\x1b[0m`;
const green = (s: string) => `\x1b[32m${s}\x1b[0m`;
const bold = (s: string) => `\x1b[1m${s}\x1b[0m`;
const cyan = (s: string) => `\x1b[36m${s}\x1b[0m`;

function formatTokens(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}k`;
  return `${n}`;
}

/** Format a tool input summary for CLI display. */
function formatToolInput(
  name: string,
  input: Record<string, unknown>
): string | null {
  if (!input || Object.keys(input).length === 0) return null;

  let summary: string | null = null;

  switch (name) {
    case "Bash":
      summary = (input.command as string) ?? null;
      break;
    case "Read":
    case "Write":
    case "Edit":
      summary = (input.file_path as string) ?? null;
      break;
    case "Grep":
    case "Glob":
      summary = (input.pattern as string) ?? null;
      if (input.path) summary += ` in ${input.path}`;
      break;
    case "Task":
      summary = ((input.description ?? input.prompt) as string) ?? null;
      break;
    case "WebFetch":
      summary = (input.url as string) ?? null;
      break;
    case "WebSearch":
      summary = (input.query as string) ?? null;
      break;
    case "TodoWrite":
      return null;
    default: {
      for (const v of Object.values(input)) {
        if (typeof v === "string" && v.length > 0 && v.length < 300) {
          summary = v;
          break;
        }
      }
    }
  }

  if (!summary) return null;
  if (summary.length > 80) summary = summary.substring(0, 77) + "...";
  return summary;
}

function printQuestion(question: AskUserQuestionInput): void {
  const lines: string[] = ["\n\u2753 Claude is asking:\n"];
  for (const q of question.questions) {
    lines.push(bold(q.question));
    if (q.options?.length) {
      for (let i = 0; i < q.options.length; i++) {
        const opt = q.options[i];
        const desc = opt.description ? dim(` \u2014 ${opt.description}`) : "";
        lines.push(`  ${i + 1}. ${opt.label}${desc}`);
      }
    }
    if (q.multiSelect) {
      lines.push(dim('(You can pick multiple, e.g. "1, 3")'));
    }
    lines.push("");
  }
  lines.push("Reply with your answer:");
  process.stdout.write(lines.join("\n") + "\n");
}

/**
 * Render a message from the orchestrator to stdout.
 * Returns true if the message is { type: "done" }.
 */
function renderMessage(message: ChannelMessage): boolean {
  switch (message.type) {
    case "assistant":
      process.stdout.write(message.text);
      break;
    case "tool_call": {
      const summary = formatToolInput(message.name, message.input);
      const detail = summary ? `: ${summary}` : "";
      process.stdout.write(dim(`\n  \ud83d\udd27 ${message.name}${detail}\n`));
      break;
    }
    case "tool_result": {
      const icon = message.isError ? red("\u274c") : green("\u2705");
      process.stdout.write(dim(`  ${icon} ${message.name}\n`));
      break;
    }
    case "text":
      if (message.subtype === "error") {
        process.stderr.write(red(`\n\u26a0\ufe0f Error: ${message.text}\n`));
      } else {
        process.stdout.write(cyan(`\n${message.text}\n`));
      }
      break;
    case "question":
      printQuestion(message.question);
      break;
    case "done":
      process.stdout.write("\n");
      return true;
  }
  return false;
}

/**
 * Send a user message and wait for the "done" response.
 * Reads messages from the endpoint until { type: "done" } arrives
 * for the given threadId.
 */
async function sendAndWait(
  endpoint: ChannelEndpoint,
  threadId: string,
  text: string
): Promise<void> {
  endpoint.send(threadId, { type: "user", text });

  // Read messages until we get "done" for this thread
  while (true) {
    const { message } = await endpoint.receive();
    const isDone = renderMessage(message);
    if (isDone) break;
  }
}

export async function startCli(orchestrator: Orchestrator): Promise<void> {
  const sessionManager = orchestrator.sessions;

  // Create message channel — two endpoints connected by async queues
  const [transportEnd, orchestratorEnd] = createMessageChannel();
  orchestrator.register("cli", orchestratorEnd);

  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  });

  const prompt = (question: string): Promise<string> =>
    new Promise((resolve) => rl.question(question, resolve));

  console.log(bold("\ud83e\udd16 Claude Code Remote \u2014 CLI Mode\n"));

  // Get project path from CLI args or prompt
  let projectPath = process.argv.slice(2).find((arg) => !arg.startsWith("-"));
  if (!projectPath) {
    const repos = sessionManager.listRepos();
    if (repos.length > 0) {
      console.log("Available projects:");
      repos.forEach((r) => console.log(`  ${r}`));
      console.log();
    }
    projectPath = await prompt("Project path: ");
  }

  if (!projectPath?.trim()) {
    console.error(red("No project path provided. Exiting."));
    process.exit(1);
  }

  // Validate and create initial session
  const resolved = sessionManager.validateProjectPath(projectPath.trim());
  if (resolved.error) {
    console.error(red(`\u26a0\ufe0f ${resolved.error}`));
    process.exit(1);
  }

  const sessionName = path.basename(resolved.path!);
  let finalPath = resolved.path!;
  let worktreeData: { repoPath: string; branch: string; worktreePath: string } | undefined;

  if (isGitRepo(resolved.path!)) {
    try {
      const repoRoot = getRepoRoot(resolved.path!);
      const branchName = `session-${new Date().toISOString().replace(/[-:T.]/g, "").substring(0, 15)}`;
      const wt = createWorktree(repoRoot, branchName);
      finalPath = wt.worktreePath;
      worktreeData = { repoPath: repoRoot, branch: wt.branch, worktreePath: wt.worktreePath };
    } catch (err: any) {
      console.error(red(`\u26a0\ufe0f Failed to create worktree: ${err?.message}`));
      process.exit(1);
    }
  }

  let currentSession = sessionManager.create({
    threadId: "cli:default",
    channel: "cli",
    projectPath: finalPath,
    name: sessionName,
    worktree: worktreeData,
  });

  console.log(green(`\n\u2705 Session "${sessionName}" created`));
  console.log(`\ud83d\udcc1 Project: ${resolved.path!}`);
  if (worktreeData) {
    console.log(`\ud83c\udf3f Branch: ${worktreeData.branch}`);
    console.log(`\ud83d\udcc2 Worktree: ${worktreeData.worktreePath}`);
    console.log(`\u2705 Auto-review enabled`);
  }
  console.log();
  console.log(
    dim(
      "Commands: new <path>, reset, sessions, usage, repos, verbosity <1|2>, restart, update, exit\n"
    )
  );

  // REPL loop
  let pendingSend: Promise<void> | null = null;

  // Handle stdin close (piped input / EOF) — wait for pending work
  rl.on("close", async () => {
    if (pendingSend) {
      await pendingSend;
    }
    console.log("\nBye!");
    process.exit(0);
  });

  const repl = async () => {
    while (true) {
      let input: string;
      try {
        input = await prompt(dim("> "));
      } catch {
        return;
      }
      const trimmed = input.trim();
      if (!trimmed) continue;

      // Handle commands
      if (trimmed === "exit" || trimmed === "quit") {
        console.log("Bye!");
        rl.close();
        process.exit(0);
      }

      if (trimmed === "reset") {
        sessionManager.resetSession(currentSession.id);
        console.log(green(`\ud83d\udd04 Session "${currentSession.name}" reset.`));
        continue;
      }

      if (trimmed.startsWith("new ")) {
        const newPath = trimmed.substring(4).trim();
        const newResolved = sessionManager.validateProjectPath(newPath);
        if (newResolved.error) {
          console.error(red(`\u26a0\ufe0f ${newResolved.error}`));
          continue;
        }
        const newName = path.basename(newResolved.path!);
        const threadId = `cli:${Date.now()}`;

        let newFinalPath = newResolved.path!;
        let newWorktreeData: { repoPath: string; branch: string; worktreePath: string } | undefined;

        if (isGitRepo(newResolved.path!)) {
          try {
            const repoRoot = getRepoRoot(newResolved.path!);
            const branchName = `session-${new Date().toISOString().replace(/[-:T.]/g, "").substring(0, 15)}`;
            const wt = createWorktree(repoRoot, branchName);
            newFinalPath = wt.worktreePath;
            newWorktreeData = { repoPath: repoRoot, branch: wt.branch, worktreePath: wt.worktreePath };
          } catch (err: any) {
            console.error(red(`\u26a0\ufe0f Failed to create worktree: ${err?.message}`));
            continue;
          }
        }

        currentSession = sessionManager.create({
          threadId,
          channel: "cli",
          projectPath: newFinalPath,
          name: newName,
          worktree: newWorktreeData,
        });

        console.log(green(`\u2705 Session "${newName}" created`));
        console.log(`\ud83d\udcc1 Project: ${newResolved.path!}`);
        if (newWorktreeData) {
          console.log(`\ud83c\udf3f Branch: ${newWorktreeData.branch}`);
          console.log(`\ud83d\udcc2 Worktree: ${newWorktreeData.worktreePath}`);
          console.log(`\u2705 Auto-review enabled`);
        }
        console.log();
        continue;
      }

      if (trimmed === "sessions") {
        const sessions = sessionManager.getAllForChannel("cli");
        if (sessions.length === 0) {
          console.log("No sessions.");
          continue;
        }
        console.log(bold("\ud83d\udccb Sessions:\n"));
        sessions.forEach((s, i) => {
          const active = s.lastActiveAt
            ? new Date(s.lastActiveAt).toLocaleString()
            : "never";
          const current = s.id === currentSession.id ? " (current)" : "";
          const resumed = s.agentSessionId ? "\ud83d\udfe2" : "\u26aa";
          console.log(`  ${i + 1}. ${resumed} ${s.name}${current}`);
          console.log(`     \ud83d\udcc1 ${s.projectPath}`);
          console.log(`     \ud83d\udd50 ${active}\n`);
        });
        continue;
      }

      if (trimmed === "usage") {
        const fresh = sessionManager.getById(currentSession.id);
        if (fresh) currentSession = fresh;
        const u = currentSession.totalUsage ?? {
          input_tokens: 0,
          output_tokens: 0,
        };
        const duration = (
          (currentSession.totalDurationMs ?? 0) / 1000
        ).toFixed(1);
        console.log(bold(`\ud83d\udcca Usage for "${currentSession.name}":\n`));
        console.log(`  Turns: ${currentSession.totalTurns ?? 0}`);
        console.log(`  Duration: ${duration}s`);
        console.log(`  Input tokens: ${formatTokens(u.input_tokens)}`);
        console.log(`  Output tokens: ${formatTokens(u.output_tokens)}`);
        if (u.cache_read_input_tokens)
          console.log(
            `  Cache read: ${formatTokens(u.cache_read_input_tokens)}`
          );
        console.log();
        continue;
      }

      if (trimmed === "repos") {
        const repos = sessionManager.listRepos();
        if (repos.length === 0) {
          console.log("No path restrictions configured.");
          continue;
        }
        console.log(bold("\ud83d\udcc2 Available projects:\n"));
        repos.forEach((r) => console.log(`  ${r}`));
        console.log();
        continue;
      }

      if (trimmed.startsWith("verbosity ")) {
        const level = parseInt(trimmed.substring(10).trim(), 10);
        if (level < 1 || level > 2) {
          console.log(red("Verbosity must be 1 or 2."));
          continue;
        }
        sessionManager.updateVerbosity(currentSession.id, level);
        const labels = ["", "Hide tool messages", "Show tool cards"];
        console.log(
          green(`\u2705 Verbosity set to ${level} \u2014 ${labels[level]}`)
        );
        continue;
      }

      if (trimmed === "restart") {
        console.log("\u267b\ufe0f Restarting...");
        orchestrator.restart();
        continue;
      }

      if (trimmed === "update") {
        console.log("\ud83d\udce5 Pulling latest changes...");
        try {
          const result = await orchestrator.update();
          console.log(`\ud83d\udce5 ${result.pulled}`);
          if (result.built) {
            console.log("\u2705 Build complete. \u267b\ufe0f Restarting...");
            orchestrator.restart();
          }
        } catch (err: any) {
          console.error(red(`\u26a0\ufe0f Update failed: ${err?.message}`));
        }
        continue;
      }

      // Not a command — send through the channel and wait for done
      pendingSend = sendAndWait(
        transportEnd,
        currentSession.threadId,
        trimmed
      );
      await pendingSend;
      pendingSend = null;

      // Refresh session after send (usage updated)
      const updated = sessionManager.getById(currentSession.id);
      if (updated) currentSession = updated;
    }
  };

  repl().catch((err) => {
    console.error("REPL error:", err);
    process.exit(1);
  });
}
