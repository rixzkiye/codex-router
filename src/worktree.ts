import { execFile } from "node:child_process";
import { homedir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { realpath, stat } from "node:fs/promises";
import { RouterError } from "./errors.js";
import type { WorktreeRegistration } from "./store/registry.js";

const execFileAsync = promisify(execFile);

export interface WorktreeEvidence extends WorktreeRegistration {
  statusText: string;
  changedFiles: string[];
  untrackedFiles: string[];
  inspectedAt: string;
}

export class WorktreeInspector {
  readonly #roots: string[];

  private constructor(roots: string[]) {
    this.#roots = roots;
  }

  static async create(allowedRoots: string[]): Promise<WorktreeInspector> {
    const roots: string[] = [];
    for (const configured of allowedRoots) {
      const resolved = await realpath(configured);
      rejectBroadRoot(resolved);
      roots.push(withTrailingSeparator(resolved));
    }
    return new WorktreeInspector(roots);
  }

  async validate(requestedPath: string): Promise<string> {
    if (!path.isAbsolute(requestedPath)) {
      throw new RouterError("invalid_worktree", "Worktree path must be absolute");
    }
    const canonical = await realpath(requestedPath).catch(() => {
      throw new RouterError("invalid_worktree", "Worktree path does not exist");
    });
    const info = await stat(canonical);
    if (!info.isDirectory()) throw new RouterError("invalid_worktree", "Worktree path is not a directory");
    const comparable = withTrailingSeparator(canonical);
    if (!this.#roots.some((root) => comparable.startsWith(root))) {
      throw new RouterError("invalid_worktree", "Worktree path is outside configured allowed roots");
    }
    rejectBroadRoot(canonical);
    return canonical;
  }

  async inspect(canonicalPath: string): Promise<WorktreeEvidence> {
    const inspectedAt = new Date().toISOString();
    try {
      const [root, head, statusText, upstream] = await Promise.all([
        git(canonicalPath, ["rev-parse", "--show-toplevel"]),
        git(canonicalPath, ["rev-parse", "HEAD"]),
        git(canonicalPath, ["status", "--porcelain=v1", "-z", "--untracked-files=all"]),
        git(canonicalPath, ["rev-parse", "@{upstream}"]).catch(() => "")
      ]);
      const entries = statusText.split("\0").filter(Boolean);
      const changedFiles: string[] = [];
      const untrackedFiles: string[] = [];
      for (const entry of entries) {
        if (!/^[ MADRCU?!]{2} /.test(entry)) continue;
        const code = entry.slice(0, 2);
        const file = entry.slice(3);
        changedFiles.push(file);
        if (code === "??") untrackedFiles.push(file);
      }
      return {
        canonicalPath,
        repositoryId: root.trim(),
        headSha: head.trim() || null,
        baseSha: upstream.trim() || null,
        dirty: entries.length > 0,
        status: entries.length === 0 ? "clean" : "dirty",
        statusText: entries.map((entry) => `${entry.slice(0, 2)} ${entry.slice(3)}`).join("\n"),
        changedFiles,
        untrackedFiles,
        inspectedAt
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return {
        canonicalPath,
        repositoryId: null,
        headSha: null,
        baseSha: null,
        dirty: false,
        status: "not_git",
        statusText: message,
        changedFiles: [],
        untrackedFiles: [],
        inspectedAt
      };
    }
  }
}

async function git(cwd: string, args: string[]): Promise<string> {
  const { stdout } = await execFileAsync("git", ["-C", cwd, ...args], {
    encoding: "utf8",
    maxBuffer: 10 * 1024 * 1024
  });
  return stdout;
}

function rejectBroadRoot(candidate: string): void {
  const filesystemRoot = path.parse(candidate).root;
  const userHome = path.resolve(homedir());
  if (candidate === filesystemRoot || candidate === userHome) {
    throw new RouterError("invalid_worktree", "Filesystem root and user home are not valid worktree scopes");
  }
}

function withTrailingSeparator(value: string): string {
  return value.endsWith(path.sep) ? value : `${value}${path.sep}`;
}
