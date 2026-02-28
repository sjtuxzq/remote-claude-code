import { execSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";

/**
 * Check if a path is inside a git repository.
 */
export function isGitRepo(dirPath: string): boolean {
  try {
    execSync("git rev-parse --git-dir", {
      cwd: dirPath,
      encoding: "utf-8",
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"],
    });
    return true;
  } catch {
    return false;
  }
}

/**
 * Get the root of the git repo (handles being called from subdirectories).
 */
export function getRepoRoot(dirPath: string): string {
  return execSync("git rev-parse --show-toplevel", {
    cwd: dirPath,
    encoding: "utf-8",
    windowsHide: true,
    stdio: ["ignore", "pipe", "pipe"],
  }).trim();
}

/**
 * Get the default branch name (main, master, etc.).
 */
export function getDefaultBranch(repoPath: string): string {
  try {
    const ref = execSync("git symbolic-ref refs/remotes/origin/HEAD", {
      cwd: repoPath,
      encoding: "utf-8",
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"],
    }).trim();
    return ref.replace("refs/remotes/origin/", "");
  } catch {
    // Fallback: check if main or master exists
    try {
      execSync("git rev-parse --verify main", {
        cwd: repoPath,
        encoding: "utf-8",
        windowsHide: true,
        stdio: ["ignore", "pipe", "pipe"],
      });
      return "main";
    } catch {
      return "master";
    }
  }
}

/**
 * Get the worktrees base directory for a given repo.
 * e.g., Q:\s\my-app → Q:\s\my-app-worktrees
 */
export function getWorktreeBaseDir(repoPath: string): string {
  return repoPath + "-worktrees";
}

/**
 * Resolve a unique branch name. If `desired` already exists, appends -2, -3, etc.
 */
export function resolveUniqueBranch(repoPath: string, desired: string): string {
  const exists = (name: string) => {
    try {
      execSync(`git rev-parse --verify "${name}"`, {
        cwd: repoPath,
        encoding: "utf-8",
        windowsHide: true,
        stdio: ["ignore", "pipe", "pipe"],
      });
      return true;
    } catch {
      return false;
    }
  };

  if (!exists(desired)) return desired;

  let counter = 2;
  while (exists(`${desired}-${counter}`)) {
    counter++;
  }
  return `${desired}-${counter}`;
}

/**
 * Create a git worktree with a new branch.
 * Returns the absolute path to the worktree directory and the branch name used.
 */
export function createWorktree(
  repoPath: string,
  branchName: string,
  baseBranch?: string
): { worktreePath: string; branch: string } {
  const base = baseBranch ?? getDefaultBranch(repoPath);
  const uniqueBranch = resolveUniqueBranch(repoPath, branchName);
  const baseDir = getWorktreeBaseDir(repoPath);
  const worktreePath = path.join(baseDir, uniqueBranch);

  // Ensure base directory exists
  if (!fs.existsSync(baseDir)) {
    fs.mkdirSync(baseDir, { recursive: true });
  }

  // Create worktree with new branch from base
  execSync(
    `git worktree add "${worktreePath}" -b "${uniqueBranch}" "${base}"`,
    {
      cwd: repoPath,
      encoding: "utf-8",
      windowsHide: true,
      timeout: 30000,
    }
  );

  console.log(
    `[worktree] Created worktree: ${worktreePath} (branch: ${uniqueBranch} from ${base})`
  );
  return { worktreePath, branch: uniqueBranch };
}

/**
 * Remove a git worktree and optionally delete its branch.
 */
export function removeWorktree(
  repoPath: string,
  worktreePath: string,
  branchName: string,
  deleteBranch: boolean = false
): void {
  try {
    execSync(`git worktree remove "${worktreePath}" --force`, {
      cwd: repoPath,
      encoding: "utf-8",
      windowsHide: true,
      timeout: 30000,
    });
    console.log(`[worktree] Removed worktree: ${worktreePath}`);
  } catch (err: any) {
    console.error(`[worktree] Failed to remove worktree: ${err?.message}`);
    // Try manual cleanup if git worktree remove fails
    try {
      if (fs.existsSync(worktreePath)) {
        fs.rmSync(worktreePath, { recursive: true, force: true });
      }
      execSync("git worktree prune", {
        cwd: repoPath,
        encoding: "utf-8",
        windowsHide: true,
      });
    } catch {
      // Best effort
    }
  }

  if (deleteBranch) {
    try {
      execSync(`git branch -D "${branchName}"`, {
        cwd: repoPath,
        encoding: "utf-8",
        windowsHide: true,
      });
      console.log(`[worktree] Deleted branch: ${branchName}`);
    } catch (err: any) {
      console.error(`[worktree] Failed to delete branch: ${err?.message}`);
    }
  }

}

/**
 * Get the status of a worktree branch — commits ahead/behind, uncommitted changes.
 */
export function getWorktreeStatus(
  worktreePath: string,
  repoPath: string,
  branchName: string
): { ahead: number; behind: number; dirty: boolean; summary: string } {
  const defaultBranch = getDefaultBranch(repoPath);

  let ahead = 0;
  let behind = 0;
  try {
    const counts = execSync(
      `git rev-list --left-right --count "${defaultBranch}...${branchName}"`,
      {
        cwd: repoPath,
        encoding: "utf-8",
        windowsHide: true,
        stdio: ["ignore", "pipe", "pipe"],
      }
    ).trim();
    const [b, a] = counts.split("\t").map(Number);
    behind = b;
    ahead = a;
  } catch {
    // Ignore
  }

  let dirty = false;
  try {
    const status = execSync("git status --porcelain", {
      cwd: worktreePath,
      encoding: "utf-8",
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"],
    }).trim();
    dirty = status.length > 0;
  } catch {
    // Ignore
  }

  const parts: string[] = [];
  if (ahead > 0) parts.push(`${ahead} commit${ahead > 1 ? "s" : ""} ahead`);
  if (behind > 0)
    parts.push(`${behind} commit${behind > 1 ? "s" : ""} behind`);
  if (dirty) parts.push("uncommitted changes");
  const summary =
    parts.length > 0 ? parts.join(", ") : "clean, up to date";

  return { ahead, behind, dirty, summary };
}
