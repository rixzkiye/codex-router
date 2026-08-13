import { spawn } from "node:child_process";
import { stat } from "node:fs/promises";
import { createInterface } from "node:readline/promises";
import path from "node:path";
import type { Readable, Writable } from "node:stream";
import type { ManagedSetup, ManagedSetupStatus, SetupOptions } from "./platform/setup.js";

export interface RouterCliRuntime {
  readonly setup: ManagedSetup;
  readonly cwd: string;
  readonly home: string;
  readonly stdin: Readable & { isTTY?: boolean };
  readonly stdout: Writable;
  readonly stderr: Writable;
  readonly runMcp: (args: string[]) => Promise<void>;
  readonly runWeb: (args: string[], open: boolean) => Promise<void>;
  readonly runInference: (args: string[]) => Promise<void>;
  readonly runPlatform: (args: string[]) => Promise<void>;
  readonly openExternal?: (url: string) => void;
}

export async function runRouterCli(args: string[], runtime: RouterCliRuntime): Promise<void> {
  const command = args[0];
  if (command === "--help" || command === "-h" || command === "help") {
    runtime.stdout.write(usage());
    return;
  }
  if (command === "setup") {
    await setupCommand(args.slice(1), runtime, true);
    return;
  }
  if (command === "mcp") {
    await runtime.runMcp(args.slice(1));
    return;
  }
  if (command === "web") {
    await runtime.runWeb(args.slice(1), args.includes("--open"));
    return;
  }
  if (command === "inference") {
    await runtime.runInference(args.slice(1));
    return;
  }
  if (command === "platform") {
    await runtime.runPlatform(args.slice(1));
    return;
  }

  if (!command || command === "open") {
    let manifest = await runtime.setup.manifest();
    if (!manifest) {
      await setupCommand([], runtime, false);
      return;
    }
    if (manifest.background) {
      const status = await runtime.setup.status();
      if (!status.service.running) await runtime.setup.startBackground();
      await openManagedConsole(runtime);
      return;
    }
    await runtime.runWeb([], true);
    return;
  }

  if (command === "start") {
    if (args.includes("--background")) {
      const manifest = await requireSetup(runtime);
      if (!manifest.background) await runtime.setup.setBackground(true, false);
      else await runtime.setup.startBackground();
      await runtime.setup.requestBootstrapUrl();
      runtime.stdout.write("Codex Router started in the background.\n");
      return;
    }
    await requireSetup(runtime);
    await runtime.runWeb([], false);
    return;
  }
  if (command === "stop") {
    await requireSetup(runtime);
    await runtime.setup.stop();
    runtime.stdout.write("Codex Router background service stopped.\n");
    return;
  }
  if (command === "restart") {
    await requireSetup(runtime);
    await runtime.setup.restart();
    await runtime.setup.requestBootstrapUrl();
    runtime.stdout.write("Codex Router background service restarted.\n");
    return;
  }
  if (command === "status") {
    const status = await runtime.setup.status();
    if (args.includes("--json")) runtime.stdout.write(`${JSON.stringify(status, null, 2)}\n`);
    else runtime.stdout.write(statusText(status));
    if (!status.configured || status.service.state === "attention" || !["owned", "disabled"].includes(status.mcp.state)) process.exitCode = 1;
    return;
  }
  if (command === "logs") {
    await requireSetup(runtime);
    const child = runtime.setup.logsCommand(args.includes("--follow"));
    await inheritCommand(child.command, child.args);
    return;
  }
  if (command === "doctor") {
    const checks = await runtime.setup.doctor();
    runtime.stdout.write(`${checks.map((check) => `${check.state.toUpperCase().padEnd(7)} ${check.id}: ${check.message}`).join("\n")}\n`);
    if (checks.some((check) => check.state === "fail")) process.exitCode = 1;
    return;
  }
  if (command === "uninstall") {
    if (!args.includes("--yes")) throw new Error("Uninstall requires --yes. Add --purge only if config, database, and logs should also be deleted.");
    const result = await runtime.setup.uninstall({ purge: args.includes("--purge") });
    runtime.stdout.write(`Removed:\n${result.removed.map((entry) => `  ${entry}`).join("\n")}\n`);
    if (result.retained.length) runtime.stdout.write(`Retained:\n${result.retained.map((entry) => `  ${entry}`).join("\n")}\n`);
    return;
  }
  throw new Error(`Unknown command ${command}. Run codex-router --help.`);
}

async function setupCommand(args: string[], runtime: RouterCliRuntime, explicit: boolean): Promise<void> {
  const existing = await runtime.setup.manifest();
  const yes = args.includes("--yes");
  const foreground = args.includes("--foreground");
  const noMcp = args.includes("--no-mcp");
  const adoptMcp = args.includes("--adopt-mcp");
  const requestedRoot = option(args, "--worktree-root");
  const requestedPort = numericOption(args, "--port");
  const defaultWorktreeRoot = existing?.worktreeRoot ?? await suggestedWorktreeRoot(runtime.cwd, runtime.home);
  let options: SetupOptions;

  if (yes) {
    const worktreeRoot = requestedRoot ?? defaultWorktreeRoot;
    if (!worktreeRoot) throw new Error("No dedicated projects or worktrees directory was found. Pass --worktree-root /absolute/path.");
    options = {
      worktreeRoot,
      background: !foreground,
      startAtLogin: !foreground,
      mcpEnabled: !noMcp,
      ...(adoptMcp ? { adoptMcp: true } : {}),
      ...(requestedPort === undefined ? {} : { port: requestedPort })
    };
  } else {
    if (!runtime.stdin.isTTY) {
      throw new Error("Interactive setup needs a terminal. Use codex-router setup --yes --worktree-root /absolute/projects, or pass --foreground/--no-mcp to change defaults.");
    }
    const prompt = createInterface({ input: runtime.stdin, output: runtime.stdout });
    try {
      const worktreeRoot = requestedRoot ?? await askValue(prompt, "Allowed projects/worktrees root", defaultWorktreeRoot);
      const background = foreground ? false : await askYesNo(prompt, "Run Codex Router in the background", existing?.background ?? true);
      const startAtLogin = background && await askYesNo(prompt, "Start the background service when you sign in", existing?.startAtLogin ?? true);
      const mcpEnabled = noMcp ? false : await askYesNo(prompt, "Register the codex-router MCP server with Codex", existing?.mcpEnabled ?? true);
      options = {
        worktreeRoot,
        background,
        startAtLogin,
        mcpEnabled,
        ...(adoptMcp ? { adoptMcp: true } : {}),
        ...(requestedPort === undefined ? {} : { port: requestedPort })
      };
    } finally {
      prompt.close();
    }
  }

  const status = await runtime.setup.apply(options);
  runtime.stdout.write(setupSummary(status));
  if (options.background) await openManagedConsole(runtime);
  else if (!explicit) await runtime.runWeb([], true);
}

async function openManagedConsole(runtime: RouterCliRuntime): Promise<void> {
  const url = await runtime.setup.requestBootstrapUrl();
  runtime.stdout.write(`Codex Router Console: ${url}\n`);
  (runtime.openExternal ?? openExternal)(url);
}

async function requireSetup(runtime: RouterCliRuntime) {
  const manifest = await runtime.setup.manifest();
  if (!manifest) throw new Error("Codex Router is not set up. Run codex-router setup first.");
  return manifest;
}

function setupSummary(status: ManagedSetupStatus): string {
  return [
    "Codex Router setup completed.",
    `  Service: ${status.service.state} (${status.background ? "background" : "foreground preference"})`,
    `  Start at login: ${status.startAtLogin ? "yes" : "no"}`,
    `  MCP: ${status.mcp.state}`,
    `  Config: ${status.paths.configFile}`,
    `  Service definition: ${status.paths.serviceFile}`,
    `  Manifest: ${status.paths.manifestFile}`,
    `  Logs: ${status.paths.logFile}`,
    ""
  ].join("\n");
}

function statusText(status: ManagedSetupStatus): string {
  return [
    `Setup       ${status.configured ? "configured" : "missing"}`,
    `Service     ${status.service.state} — ${status.service.message}`,
    `Background  ${status.background ? "enabled" : "disabled"}`,
    `Login       ${status.startAtLogin ? "enabled" : "disabled"}`,
    `MCP         ${status.mcp.state} — ${status.mcp.message}`,
    `Console     ${status.url}`,
    `Config      ${status.paths.configFile}`,
    `Service     ${status.paths.serviceFile}`,
    `Manifest    ${status.paths.manifestFile}`,
    `Logs        ${status.paths.logFile}`,
    ""
  ].join("\n");
}

function usage(): string {
  return `Codex Router\n\nUsage:\n  codex-router                         Set up if needed, then open the Console\n  codex-router setup [options]         Create config, user service, and Codex MCP entry\n  codex-router open                    Ensure the opted-in service is ready and open the Console\n  codex-router start [--background]    Run in the foreground or explicitly enable background mode\n  codex-router stop                    Stop the background service\n  codex-router restart                 Restart the background service\n  codex-router status [--json]         Read back setup, service, MCP, and managed paths\n  codex-router logs [--follow]         Show the managed service log\n  codex-router mcp                     Run the stdio MCP server\n  codex-router doctor                  Check the managed installation\n  codex-router uninstall --yes [--purge]\n\nSetup options:\n  --yes                                Accept safe defaults without prompts\n  --worktree-root <absolute-path>      Allowed projects/worktrees root\n  --foreground                         Do not run or start at login in the background\n  --no-mcp                             Do not register Codex MCP\n  --adopt-mcp                          Explicitly replace a conflicting codex-router MCP entry\n  --port <1-65535>                     Console port (default 4178)\n\nCompatibility commands:\n  codex-router web | inference | platform ...\n`;
}

async function suggestedWorktreeRoot(cwd: string, home: string): Promise<string | undefined> {
  const current = path.resolve(cwd);
  const userHome = path.resolve(home);
  if (current !== userHome) return current;
  for (const candidate of [path.join(userHome, "projects"), path.join(userHome, "worktrees")]) {
    if ((await stat(candidate).catch(() => null))?.isDirectory()) return candidate;
  }
  return undefined;
}

async function askValue(prompt: ReturnType<typeof createInterface>, label: string, defaultValue?: string): Promise<string> {
  const suffix = defaultValue ? ` [${defaultValue}]` : "";
  const answer = (await prompt.question(`${label}${suffix}: `)).trim();
  if (answer) return answer;
  if (defaultValue) return defaultValue;
  throw new Error(`${label} is required. Choose an existing dedicated projects or worktrees directory.`);
}

async function askYesNo(prompt: ReturnType<typeof createInterface>, label: string, defaultValue: boolean): Promise<boolean> {
  const marker = defaultValue ? "Y/n" : "y/N";
  const answer = (await prompt.question(`${label} [${marker}]: `)).trim().toLowerCase();
  if (!answer) return defaultValue;
  if (answer === "y" || answer === "yes") return true;
  if (answer === "n" || answer === "no") return false;
  throw new Error(`Expected yes or no for: ${label}`);
}

function option(args: string[], name: string): string | undefined {
  const index = args.indexOf(name);
  if (index < 0) return undefined;
  const value = args[index + 1];
  if (!value || value.startsWith("--")) throw new Error(`${name} requires a value.`);
  return value;
}

function numericOption(args: string[], name: string): number | undefined {
  const value = option(args, name);
  if (value === undefined) return undefined;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 1 || parsed > 65_535) throw new Error(`${name} must be an integer between 1 and 65535.`);
  return parsed;
}

function openExternal(url: string): void {
  const command = process.platform === "darwin" ? "open" : process.platform === "win32" ? "cmd" : "xdg-open";
  const args = process.platform === "win32" ? ["/c", "start", "", url] : [url];
  const child = spawn(command, args, { detached: true, stdio: "ignore" });
  child.once("error", () => undefined);
  child.unref();
}

async function inheritCommand(command: string, args: string[]): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const child = spawn(command, args, { stdio: "inherit" });
    child.once("error", reject);
    child.once("exit", (code, signal) => code === 0 ? resolve() : reject(new Error(`${command} exited with ${code ?? signal ?? "unknown status"}`)));
  });
}
