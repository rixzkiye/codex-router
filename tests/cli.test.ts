import { PassThrough } from "node:stream";
import { describe, expect, it, vi } from "vitest";
import { runRouterCli, type RouterCliRuntime } from "../src/cli.js";
import type { ManagedSetup, ManagedSetupStatus, SetupManifest } from "../src/platform/setup.js";

describe("Codex Router CLI dispatch", () => {
  it("prints help without loading or creating a router config", async () => {
    const harness = cliHarness(null);
    await runRouterCli(["--help"], harness.runtime);
    expect(harness.output()).toContain("codex-router mcp");
    expect(harness.setup.apply).not.toHaveBeenCalled();
    expect(harness.runMcp).not.toHaveBeenCalled();
  });

  it("uses explicit mcp mode for stdio protocol behavior", async () => {
    const harness = cliHarness(null);
    await runRouterCli(["mcp", "--config", "/tmp/router.json"], harness.runtime);
    expect(harness.runMcp).toHaveBeenCalledWith(["--config", "/tmp/router.json"]);
    expect(harness.runWeb).not.toHaveBeenCalled();
  });

  it("opens an existing background service instead of starting stdio", async () => {
    const harness = cliHarness(manifest({ background: true }));
    await runRouterCli([], harness.runtime);
    expect(harness.setup.startBackground).not.toHaveBeenCalled();
    expect(harness.openExternal).toHaveBeenCalledWith("http://127.0.0.1:4178/#bootstrap=ticket");
    expect(harness.runMcp).not.toHaveBeenCalled();
  });

  it("starts a stopped opted-in service before opening the Console", async () => {
    const harness = cliHarness(manifest({ background: true }), { serviceRunning: false });
    await runRouterCli(["open"], harness.runtime);
    expect(harness.setup.startBackground).toHaveBeenCalledOnce();
    expect(harness.setup.requestBootstrapUrl).toHaveBeenCalledOnce();
  });

  it("runs the Console in the foreground when that was the saved preference", async () => {
    const harness = cliHarness(manifest({ background: false }));
    await runRouterCli([], harness.runtime);
    expect(harness.runWeb).toHaveBeenCalledWith([], true);
    expect(harness.runMcp).not.toHaveBeenCalled();
  });

  it("can perform non-interactive first-run setup before any config exists", async () => {
    const harness = cliHarness(null);
    await runRouterCli(["setup", "--yes", "--foreground", "--no-mcp", "--worktree-root", "/projects"], harness.runtime);
    expect(harness.setup.apply).toHaveBeenCalledWith({
      worktreeRoot: "/projects",
      background: false,
      startAtLogin: false,
      mcpEnabled: false
    });
    expect(harness.runMcp).not.toHaveBeenCalled();
  });

  it("rejects setup options whose values are missing instead of silently using defaults", async () => {
    const harness = cliHarness(null);
    await expect(runRouterCli(["setup", "--yes", "--worktree-root", "--no-mcp"], harness.runtime)).rejects.toThrow(/--worktree-root requires a value/);
    expect(harness.setup.apply).not.toHaveBeenCalled();
  });
});

function cliHarness(existing: SetupManifest | null, options: { serviceRunning?: boolean } = {}) {
  const stdout = new PassThrough();
  let captured = "";
  stdout.on("data", (chunk) => { captured += chunk.toString(); });
  const status: ManagedSetupStatus = {
    configured: Boolean(existing),
    background: existing?.background ?? false,
    startAtLogin: existing?.startAtLogin ?? false,
    service: {
      state: options.serviceRunning === false ? "stopped" : "running",
      installed: true,
      running: options.serviceRunning !== false,
      startAtLogin: existing?.startAtLogin ?? false,
      message: "fixture"
    },
    mcp: { state: existing?.mcpEnabled ? "owned" : "disabled", message: "fixture" },
    url: "http://127.0.0.1:4178",
    paths: {
      configRoot: "/config",
      configFile: "/config/config.json",
      stateRoot: "/state",
      databaseFile: "/state/router.sqlite",
      manifestFile: "/state/setup-manifest.json",
      mcpManifestFile: "/state/mcp-manifest.json",
      controlTokenFile: "/state/control-token",
      serviceFile: "/service/codex-router.service",
      logFile: "/state/router.log"
    }
  };
  const setup = {
    manifest: vi.fn(async () => existing),
    status: vi.fn(async () => status),
    apply: vi.fn(async () => status),
    startBackground: vi.fn(async () => undefined),
    stop: vi.fn(async () => undefined),
    restart: vi.fn(async () => undefined),
    setBackground: vi.fn(async () => status),
    requestBootstrapUrl: vi.fn(async () => "http://127.0.0.1:4178/#bootstrap=ticket"),
    logsCommand: vi.fn(() => ({ command: "true", args: [] })),
    doctor: vi.fn(async () => []),
    uninstall: vi.fn(async () => ({ removed: [], retained: [] }))
  };
  const runMcp = vi.fn(async () => undefined);
  const runWeb = vi.fn(async () => undefined);
  const openExternal = vi.fn();
  const runtime: RouterCliRuntime = {
    setup: setup as unknown as ManagedSetup,
    cwd: "/projects",
    stdin: Object.assign(new PassThrough(), { isTTY: false }),
    stdout,
    stderr: new PassThrough(),
    runMcp,
    runWeb,
    runInference: vi.fn(async () => undefined),
    runPlatform: vi.fn(async () => undefined),
    openExternal
  };
  return { runtime, setup, runMcp, runWeb, openExternal, output: () => captured };
}

function manifest(overrides: Partial<SetupManifest> = {}): SetupManifest {
  return {
    owner: "@rixzkiye/codex-router",
    version: 1,
    packageVersion: "0.2.0",
    configPath: "/config/config.json",
    worktreeRoot: "/projects",
    nodeExecutable: "/usr/bin/node",
    entryScript: "/package/dist/index.js",
    port: 4178,
    background: true,
    startAtLogin: true,
    mcpEnabled: true,
    installedAt: "2026-08-13T00:00:00.000Z",
    updatedAt: "2026-08-13T00:00:00.000Z",
    ...overrides
  };
}
