import { execFile } from "node:child_process";
import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createServer } from "node:net";
import { once } from "node:events";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";
import { loadConfig } from "../src/config.js";
import type { CommandResult, CommandRunner } from "../src/platform/command.js";
import { McpInstallationManager } from "../src/platform/mcp-installation.js";
import { managedPaths, type ManagedPaths } from "../src/platform/paths.js";
import { renderUserService, UserServiceManager, type ServiceLaunch } from "../src/platform/service-manager.js";
import { ManagedSetup } from "../src/platform/setup.js";

const execFileAsync = promisify(execFile);

class FakeHostRunner implements CommandRunner {
  readonly calls: Array<{ command: string; args: string[] }> = [];
  running = false;
  enabled = false;
  mcp: { command: string; args: string[]; env: Record<string, string> } | null = null;
  failMcpAdd = false;
  failNextServiceStop = false;
  onServiceStop: (() => Promise<void> | void) | null = null;

  async run(command: string, readonlyArgs: readonly string[]): Promise<CommandResult> {
    const args = [...readonlyArgs];
    this.calls.push({ command, args });
    if (command === "codex") return this.codex(args);
    if (command === "systemctl") {
      if (args.includes("is-active")) return result(this.running ? 0 : 3, this.running ? "active\n" : "inactive\n");
      if (args.includes("is-enabled")) return result(this.enabled ? 0 : 1, this.enabled ? "enabled\n" : "disabled\n");
      if (args.includes("stop")) {
        await this.onServiceStop?.();
        if (this.failNextServiceStop) {
          this.failNextServiceStop = false;
          return result(1, "", "fixture service stop failed");
        }
      }
      if (args.includes("enable")) this.enabled = true;
      if (args.includes("disable")) this.enabled = false;
      if (args.includes("start") || args.includes("restart") || args.includes("--now") && args.includes("enable")) this.running = true;
      if (args.includes("stop") || args.includes("--now") && args.includes("disable")) this.running = false;
      return result(0);
    }
    return result(0);
  }

  private codex(args: string[]): CommandResult {
    if (args[0] !== "mcp") return result(1, "", "unsupported");
    if (args[1] === "get") {
      if (!this.mcp) return result(1, "", "Error: No MCP server named 'codex-router' found.\n");
      return result(0, JSON.stringify({
        name: "codex-router",
        enabled: true,
        transport: { type: "stdio", command: this.mcp.command, args: this.mcp.args, env: this.mcp.env, env_vars: [], cwd: null }
      }));
    }
    if (args[1] === "remove") {
      this.mcp = null;
      return result(0);
    }
    if (args[1] === "add") {
      if (this.failMcpAdd) return result(1, "", "fixture MCP add failed");
      const separator = args.indexOf("--");
      const env: Record<string, string> = {};
      for (let index = 3; index < separator; index += 1) {
        if (args[index] !== "--env") continue;
        const entry = args[index + 1]!;
        const equals = entry.indexOf("=");
        env[entry.slice(0, equals)] = entry.slice(equals + 1);
        index += 1;
      }
      this.mcp = { command: args[separator + 1]!, args: args.slice(separator + 2), env };
      return result(0);
    }
    return result(1, "", "unsupported");
  }
}

describe("managed installer experience", () => {
  it("uses OS-native current-user config, state, service, and log paths", () => {
    const home = path.join(path.sep, "users", "router");
    expect(managedPaths({ platform: "linux", home, env: {} })).toMatchObject({
      configFile: path.join(home, ".config", "codex-router", "config.json"),
      serviceFile: path.join(home, ".config", "systemd", "user", "codex-router.service"),
      logFile: path.join(home, ".local", "state", "codex-router", "logs", "router.log")
    });
    expect(managedPaths({ platform: "darwin", home, env: {} }).serviceFile).toBe(path.join(home, "Library", "LaunchAgents", "com.rixzkiye.codex-router.plist"));
    expect(managedPaths({ platform: "win32", home, env: { APPDATA: "C:\\Users\\router\\Roaming", LOCALAPPDATA: "C:\\Users\\router\\Local" } }).serviceFile).toContain("codex-router-task.xml");
  });

  it("renders bounded, current-user service contracts for Linux, macOS, and Windows", () => {
    const paths = fixturePaths("/managed");
    const base = { nodeExecutable: "/usr/bin/node", entryScript: "/pkg/dist/index.js", configPath: "/managed/config.json", controlTokenFile: "/managed/control-token", port: 4178, startAtLogin: true };
    const linux = renderUserService(paths, { ...base, host: "linux" });
    expect(linux.content).toContain('ExecStart="/usr/bin/node" "/pkg/dist/index.js" "web"');
    expect(linux.content).toContain("WorkingDirectory=/managed/state");
    expect(linux.content).not.toContain('WorkingDirectory="/managed/state"');
    expect(linux.content).toContain("--control-token-file");
    expect(linux.statusCommand).toEqual(["systemctl", "--user", "is-active", "codex-router.service"]);
    const darwin = renderUserService({ ...paths, serviceFile: "/Users/router/Library/LaunchAgents/com.rixzkiye.codex-router.plist" }, { ...base, host: "darwin" });
    expect(darwin.content).toContain("<key>RunAtLoad</key><true/>");
    expect(darwin.startCommand.slice(0, 2)).toEqual(["launchctl", "bootstrap"]);
    const windows = renderUserService({ ...paths, serviceFile: "C:\\router\\codex-router-task.xml" }, { ...base, host: "win32" });
    expect(windows.content).toContain('encoding="UTF-8"');
    expect(windows.content).toContain("<LogonTrigger>");
    expect(windows.startCommand).toEqual(["schtasks.exe", "/Run", "/TN", "Codex Router"]);
  });

  it.skipIf(process.platform !== "linux")("renders a Linux unit accepted by systemd", async () => {
    const root = await fixtureRoot("codex-router-systemd-unit-");
    const paths = fixturePaths(path.join(root, "managed"));
    const unit = path.join(root, "codex-router.service");
    const content = renderUserService(paths, {
      host: "linux",
      nodeExecutable: "/usr/bin/node",
      entryScript: "/package/dist/index.js",
      configPath: paths.configFile,
      controlTokenFile: paths.controlTokenFile,
      port: 4178,
      startAtLogin: true
    }).content;
    await writeFile(unit, content);
    await expect(execFileAsync("systemd-analyze", ["verify", unit])).resolves.toBeDefined();
  });

  it("adds, reads back, idempotently retains, and removes an owned Codex MCP entry", async () => {
    const root = await fixtureRoot("codex-router-mcp-");
    const runner = new FakeHostRunner();
    const manager = new McpInstallationManager(path.join(root, "mcp-manifest.json"), runner);
    const config = path.join(root, "config.json");
    expect((await manager.inspect(config)).state).toBe("absent");
    expect((await manager.install(config)).state).toBe("owned");
    expect(runner.mcp).toEqual({ command: "codex-router", args: ["mcp"], env: { CODEX_ROUTER_CONFIG: config } });
    const addCalls = runner.calls.filter((call) => call.command === "codex" && call.args[1] === "add");
    await manager.install(config);
    expect(runner.calls.filter((call) => call.command === "codex" && call.args[1] === "add")).toHaveLength(addCalls.length);
    expect(await manager.uninstall(config)).toMatchObject({ removed: true });
    expect(runner.mcp).toBeNull();
  });

  it("preserves foreign MCP configuration unless adoption is explicit", async () => {
    const root = await fixtureRoot("codex-router-mcp-foreign-");
    const runner = new FakeHostRunner();
    runner.mcp = { command: "foreign-router", args: ["serve"], env: { FOREIGN: "yes" } };
    const manager = new McpInstallationManager(path.join(root, "mcp-manifest.json"), runner);
    await expect(manager.install(path.join(root, "config.json"))).rejects.toThrow(/not owned/);
    expect(runner.mcp.command).toBe("foreign-router");
    expect(await manager.uninstall(path.join(root, "config.json"))).toMatchObject({ removed: false });
    expect(runner.mcp.command).toBe("foreign-router");
  });

  it("creates a private first-run config and idempotent managed state", async () => {
    const root = await fixtureRoot("codex-router-setup-");
    const worktrees = path.join(root, "projects");
    await mkdir(worktrees);
    const paths = fixturePaths(path.join(root, "managed"));
    const runner = new FakeHostRunner();
    const setup = fixtureSetup(paths, runner);
    const first = await setup.apply({ worktreeRoot: worktrees, background: true, startAtLogin: true, mcpEnabled: true });
    expect(first.service).toMatchObject({ state: "running", startAtLogin: true });
    expect(first.mcp.state).toBe("owned");
    const config = await loadConfig(paths.configFile);
    expect(config.allowedWorktreeRoots).toEqual([worktrees]);
    expect(config.runtimes).toEqual([]);
    if (process.platform !== "win32") {
      expect((await stat(paths.configFile)).mode & 0o077).toBe(0);
      expect((await stat(paths.controlTokenFile)).mode & 0o077).toBe(0);
    }
    const manifestBefore = await readFile(paths.manifestFile, "utf8");
    const restartCalls = runner.calls.filter((call) => call.command === "systemctl" && call.args.includes("restart")).length;
    await setup.apply({ worktreeRoot: worktrees, background: true, startAtLogin: true, mcpEnabled: true });
    expect(JSON.parse(await readFile(paths.manifestFile, "utf8"))).toMatchObject({ installedAt: JSON.parse(manifestBefore).installedAt });
    expect(runner.mcp).not.toBeNull();
    expect(runner.calls.filter((call) => call.command === "systemctl" && call.args.includes("restart"))).toHaveLength(restartCalls);
  });

  it("updates the managed worktree root in both config and manifest", async () => {
    const root = await fixtureRoot("codex-router-setup-root-update-");
    const firstRoot = path.join(root, "projects-a");
    const secondRoot = path.join(root, "projects-b");
    await Promise.all([mkdir(firstRoot), mkdir(secondRoot)]);
    const paths = fixturePaths(path.join(root, "managed"));
    const runner = new FakeHostRunner();
    const setup = fixtureSetup(paths, runner);
    await setup.apply({ worktreeRoot: firstRoot, background: true, startAtLogin: false, mcpEnabled: false });
    await setup.apply({ worktreeRoot: secondRoot, background: true, startAtLogin: false, mcpEnabled: false });
    expect((await loadConfig(paths.configFile)).allowedWorktreeRoots).toEqual([secondRoot]);
    expect(JSON.parse(await readFile(paths.manifestFile, "utf8"))).toMatchObject({ worktreeRoot: secondRoot });
    expect(runner.calls.some((call) => call.command === "systemctl" && call.args.includes("restart"))).toBe(true);
  });

  it("restores a foreign MCP entry and the previous root when an adopted update fails", async () => {
    const root = await fixtureRoot("codex-router-setup-adoption-rollback-");
    const firstRoot = path.join(root, "projects-a");
    const secondRoot = path.join(root, "projects-b");
    await Promise.all([mkdir(firstRoot), mkdir(secondRoot)]);
    const paths = fixturePaths(path.join(root, "managed"));
    const runner = new FakeHostRunner();
    const setup = fixtureSetup(paths, runner, async () => { throw new Error("fixture readiness failed"); });
    await setup.apply({ worktreeRoot: firstRoot, background: false, startAtLogin: false, mcpEnabled: false });
    const manifestBefore = await readFile(paths.manifestFile, "utf8");
    runner.mcp = { command: "foreign-router", args: ["serve"], env: { FOREIGN: "yes" } };

    await expect(setup.apply({
      worktreeRoot: secondRoot,
      background: true,
      startAtLogin: true,
      mcpEnabled: true,
      adoptMcp: true
    })).rejects.toThrow(/readiness failed/);

    expect(runner.mcp).toEqual({ command: "foreign-router", args: ["serve"], env: { FOREIGN: "yes" } });
    expect(await readFile(paths.manifestFile, "utf8")).toBe(manifestBefore);
    expect((await loadConfig(paths.configFile)).allowedWorktreeRoots).toEqual([firstRoot]);
    await expect(stat(paths.mcpManifestFile)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("restores an owned MCP entry when disabling it is followed by update failure", async () => {
    const root = await fixtureRoot("codex-router-setup-disable-rollback-");
    const worktrees = path.join(root, "projects");
    await mkdir(worktrees);
    const paths = fixturePaths(path.join(root, "managed"));
    const runner = new FakeHostRunner();
    const setup = fixtureSetup(paths, runner, async () => { throw new Error("fixture readiness failed"); });
    await setup.apply({ worktreeRoot: worktrees, background: false, startAtLogin: false, mcpEnabled: true });
    const owned = { ...runner.mcp!, args: [...runner.mcp!.args], env: { ...runner.mcp!.env } };

    await expect(setup.apply({ worktreeRoot: worktrees, background: true, startAtLogin: false, mcpEnabled: false })).rejects.toThrow(/readiness failed/);

    expect(runner.mcp).toEqual(owned);
    expect((await new McpInstallationManager(paths.mcpManifestFile, runner).inspect(paths.configFile)).state).toBe("owned");
    expect(JSON.parse(await readFile(paths.manifestFile, "utf8"))).toMatchObject({ mcpEnabled: true, background: false });
  });

  it("persists background disable before stopping and restores it if stop fails", async () => {
    const root = await fixtureRoot("codex-router-background-transaction-");
    const worktrees = path.join(root, "projects");
    await mkdir(worktrees);
    const paths = fixturePaths(path.join(root, "managed"));
    const runner = new FakeHostRunner();
    const setup = fixtureSetup(paths, runner);
    await setup.apply({ worktreeRoot: worktrees, background: true, startAtLogin: true, mcpEnabled: false });
    let backgroundAtStop: boolean | null = null;
    runner.onServiceStop = async () => {
      backgroundAtStop = JSON.parse(await readFile(paths.manifestFile, "utf8")).background as boolean;
    };
    await setup.setBackground(false, false);
    expect(backgroundAtStop).toBe(false);
    expect(JSON.parse(await readFile(paths.manifestFile, "utf8"))).toMatchObject({ background: false, startAtLogin: false });

    await setup.setBackground(true, true);
    runner.failNextServiceStop = true;
    await expect(setup.setBackground(false, false)).rejects.toThrow(/fixture service stop failed/);
    expect(JSON.parse(await readFile(paths.manifestFile, "utf8"))).toMatchObject({ background: true, startAtLogin: true });
    expect(runner.running).toBe(true);
  });

  it("rolls back config, token, service, and MCP ownership after setup failure", async () => {
    const root = await fixtureRoot("codex-router-setup-rollback-");
    const worktrees = path.join(root, "projects");
    await mkdir(worktrees);
    const paths = fixturePaths(path.join(root, "managed"));
    const runner = new FakeHostRunner();
    runner.failMcpAdd = true;
    const setup = fixtureSetup(paths, runner);
    await expect(setup.apply({ worktreeRoot: worktrees, background: true, startAtLogin: true, mcpEnabled: true })).rejects.toThrow(/fixture MCP add failed/);
    await expect(stat(paths.configFile)).rejects.toMatchObject({ code: "ENOENT" });
    await expect(stat(paths.controlTokenFile)).rejects.toMatchObject({ code: "ENOENT" });
    await expect(stat(paths.serviceFile)).rejects.toMatchObject({ code: "ENOENT" });
    await expect(stat(paths.manifestFile)).rejects.toMatchObject({ code: "ENOENT" });
    expect(runner.mcp).toBeNull();
  });

  it("rolls back the service transaction when bounded readiness fails", async () => {
    const root = await fixtureRoot("codex-router-setup-probe-rollback-");
    const worktrees = path.join(root, "projects");
    await mkdir(worktrees);
    const paths = fixturePaths(path.join(root, "managed"));
    const runner = new FakeHostRunner();
    const setup = fixtureSetup(paths, runner, async () => { throw new Error("fixture readiness failed"); });
    await expect(setup.apply({ worktreeRoot: worktrees, background: true, startAtLogin: false, mcpEnabled: false })).rejects.toThrow(/readiness failed/);
    await expect(stat(paths.serviceFile)).rejects.toMatchObject({ code: "ENOENT" });
    await expect(stat(paths.manifestFile)).rejects.toMatchObject({ code: "ENOENT" });
    expect(runner.running).toBe(false);
  });

  it("refuses an occupied Console port before creating or sending a control token", async () => {
    const root = await fixtureRoot("codex-router-setup-port-");
    const worktrees = path.join(root, "projects");
    await mkdir(worktrees);
    const paths = fixturePaths(path.join(root, "managed"));
    const server = createServer();
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("fixture port unavailable");
    const setup = new ManagedSetup({ paths, host: "linux", home: root, nodeExecutable: "/usr/bin/node", entryScript: "/package/dist/index.js", packageVersion: "0.2.0", runner: new FakeHostRunner(), serviceProbe: async () => undefined });
    try {
      await expect(setup.apply({ worktreeRoot: worktrees, background: false, startAtLogin: false, mcpEnabled: false, port: address.port })).rejects.toThrow(/already in use/);
      await expect(stat(paths.controlTokenFile)).rejects.toMatchObject({ code: "ENOENT" });
    } finally {
      server.close();
      await once(server, "close");
    }
  });

  it("reads service state without confusing installed, running, and login preference", async () => {
    const root = await fixtureRoot("codex-router-service-");
    const paths = fixturePaths(root);
    const runner = new FakeHostRunner();
    const launch: ServiceLaunch = { host: "linux", nodeExecutable: "/usr/bin/node", entryScript: "/pkg/dist/index.js", configPath: paths.configFile, controlTokenFile: paths.controlTokenFile, port: 4178, startAtLogin: false };
    const manager = new UserServiceManager(paths, launch, runner);
    await manager.install();
    expect(await manager.status()).toMatchObject({ state: "stopped", installed: true, startAtLogin: false });
    await manager.start();
    expect(await manager.status()).toMatchObject({ state: "running", startAtLogin: false });
    await manager.stop();
    expect(await manager.status()).toMatchObject({ state: "stopped" });
  });
});

function result(code: number, stdout = "", stderr = ""): CommandResult {
  return { code, stdout, stderr };
}

async function fixtureRoot(prefix: string): Promise<string> {
  return import("node:fs/promises").then(({ mkdtemp }) => mkdtemp(path.join(os.tmpdir(), prefix)));
}

function fixturePaths(root: string): ManagedPaths {
  return {
    configRoot: path.join(root, "config"),
    configFile: path.join(root, "config", "config.json"),
    stateRoot: path.join(root, "state"),
    databaseFile: path.join(root, "state", "router.sqlite"),
    manifestFile: path.join(root, "state", "setup-manifest.json"),
    mcpManifestFile: path.join(root, "state", "mcp-manifest.json"),
    controlTokenFile: path.join(root, "state", "control-token"),
    serviceFile: path.join(root, "service", "codex-router.service"),
    logFile: path.join(root, "state", "logs", "router.log")
  };
}

function fixtureSetup(paths: ManagedPaths, runner: CommandRunner, serviceProbe: (endpoint: string, controlToken: string) => Promise<void> = async () => undefined): ManagedSetup {
  return new ManagedSetup({
    paths,
    host: "linux",
    home: path.dirname(paths.configRoot),
    nodeExecutable: "/usr/bin/node",
    entryScript: "/package/dist/index.js",
    packageVersion: "0.2.0",
    runner,
    serviceProbe,
    portProbe: async () => undefined
  });
}
