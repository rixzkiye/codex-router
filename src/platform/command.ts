import { execFile } from "node:child_process";

export interface CommandResult {
  readonly code: number;
  readonly stdout: string;
  readonly stderr: string;
}

export interface CommandRunner {
  run(command: string, args: readonly string[]): Promise<CommandResult>;
}

export const systemCommandRunner: CommandRunner = {
  run: (command, args) => new Promise((resolve) => {
    execFile(command, [...args], { encoding: "utf8", windowsHide: true }, (error, stdout, stderr) => {
      const code = typeof (error as NodeJS.ErrnoException & { code?: unknown } | null)?.code === "number"
        ? (error as unknown as { code: number }).code
        : error ? 1 : 0;
      resolve({ code, stdout, stderr: stderr || (error ? error.message : "") });
    });
  })
};

export function commandFailure(command: string, args: readonly string[], result: CommandResult): Error {
  const detail = result.stderr.trim() || result.stdout.trim() || `exit code ${result.code}`;
  return new Error(`${command} ${args.join(" ")} failed: ${detail}`);
}
