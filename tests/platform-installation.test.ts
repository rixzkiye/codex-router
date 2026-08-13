import { chmod, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { InstallationManager, renderServiceDefinition } from "../src/platform/installation.js";

describe("managed platform installation", () => {
  it("renders least-privilege current-user service definitions for every supported host", () => {
    const input = { executable: "/managed/codex-router", configPath: "/managed/config.json", stateRoot: "/managed" };
    expect(renderServiceDefinition("linux", input).content).toContain("NoNewPrivileges=true");
    expect(renderServiceDefinition("darwin", input).content).toContain("com.rixzkiye.codex-router");
    expect(renderServiceDefinition("win32", input).content).toContain("LeastPrivilege");
  });

  it("installs atomically, verifies hashes, disables, rolls back, and removes only manifest-owned paths", async () => {
    const sandbox = await mkdtemp(path.join(os.tmpdir(), "codex-router-install-"));
    const root = path.join(sandbox, "managed");
    const releaseSource = path.join(sandbox, "release");
    const executable = path.join(releaseSource, "codex-router");
    const configPath = path.join(sandbox, "config.json");
    await import("node:fs/promises").then(({ mkdir }) => mkdir(releaseSource, { recursive: true }));
    await writeFile(executable, "#!/bin/sh\nexit 0\n", { mode: 0o700 });
    await chmod(executable, 0o700);
    await writeFile(configPath, "{}\n", { mode: 0o600 });
    const manager = new InstallationManager();
    const first = await manager.plan({ root, version: "1.0.0", releaseSource, entrypoint: "codex-router", configPath, host: "linux" });
    first.checks.splice(0, first.checks.length, { id: "fixture", state: "pass", message: "fixture" });
    const firstManifest = await manager.install(first, { consent: true });
    expect((await manager.verify(first.manifestFile)).ready).toBe(true);
    await writeFile(executable, "#!/bin/sh\nexit 1\n", { mode: 0o700 });
    const second = await manager.plan({ root, version: "1.1.0", releaseSource, entrypoint: "codex-router", configPath, host: "linux" });
    second.checks.splice(0, second.checks.length, { id: "fixture", state: "pass", message: "fixture" });
    const secondManifest = await manager.install(second, { consent: true });
    expect(secondManifest.previousRelease).toBe(firstManifest.activeRelease);
    const rolledBack = await manager.rollback(second.manifestFile, { consent: true });
    expect(rolledBack.activeRelease).toBe(firstManifest.activeRelease);
    expect((await manager.verify(second.manifestFile)).ready).toBe(true);
    expect(await readFile(rolledBack.serviceFile, "utf8")).toContain(firstManifest.executableFile);
    expect(await readFile(rolledBack.serviceFile, "utf8")).not.toContain(secondManifest.executableFile);
    expect((await manager.disable(second.manifestFile, { consent: true })).state).toBe("disabled");
    const foreign = path.join(sandbox, "keep.txt");
    await writeFile(foreign, "foreign");
    const removal = await manager.uninstall(second.manifestFile, { consent: true, removeRetainedReleases: true });
    expect(removal.removed).toContain(second.manifestFile);
    expect(await readFile(foreign, "utf8")).toBe("foreign");
  });

  it("refuses broad targets and every material operation without consent", async () => {
    const manager = new InstallationManager();
    await expect(manager.plan({ root: os.homedir(), version: "1", releaseSource: path.dirname(process.execPath), entrypoint: path.basename(process.execPath), configPath: "missing", host: "linux" })).rejects.toThrow(/dedicated/);
    const sandbox = await mkdtemp(path.join(os.tmpdir(), "codex-router-install-"));
    const configPath = path.join(sandbox, "config.json");
    await writeFile(configPath, "{}");
    const plan = await manager.plan({ root: path.join(sandbox, "managed"), version: "1", releaseSource: path.dirname(process.execPath), entrypoint: path.basename(process.execPath), configPath, host: "linux" });
    await expect(manager.install(plan, { consent: false })).rejects.toThrow(/consent/);
  });

  it("leaves the active service and manifest untouched when a rollback target fails integrity", async () => {
    const sandbox = await mkdtemp(path.join(os.tmpdir(), "codex-router-install-fault-"));
    const root = path.join(sandbox, "managed");
    const releaseSource = path.join(sandbox, "release");
    const executable = path.join(releaseSource, "bin", "codex-router");
    const configPath = path.join(sandbox, "config.json");
    await import("node:fs/promises").then(({ mkdir }) => mkdir(path.dirname(executable), { recursive: true }));
    await writeFile(executable, "#!/bin/sh\nexit 0\n", { mode: 0o700 });
    await writeFile(configPath, "{}\n", { mode: 0o600 });
    const manager = new InstallationManager();
    const first = await manager.plan({ root, version: "1.0.0", releaseSource, entrypoint: "bin/codex-router", configPath, host: "linux" });
    first.checks.splice(0, first.checks.length, { id: "fixture", state: "pass", message: "fixture" });
    const firstManifest = await manager.install(first, { consent: true });
    await writeFile(executable, "#!/bin/sh\nexit 1\n", { mode: 0o700 });
    const second = await manager.plan({ root, version: "1.1.0", releaseSource, entrypoint: "bin/codex-router", configPath, host: "linux" });
    second.checks.splice(0, second.checks.length, { id: "fixture", state: "pass", message: "fixture" });
    const active = await manager.install(second, { consent: true });
    const serviceBefore = await readFile(active.serviceFile, "utf8");
    const manifestBefore = await readFile(second.manifestFile, "utf8");
    await rm(firstManifest.executableFile);

    await expect(manager.rollback(second.manifestFile, { consent: true })).rejects.toThrow(/integrity/);
    expect(await readFile(active.serviceFile, "utf8")).toBe(serviceBefore);
    expect(await readFile(second.manifestFile, "utf8")).toBe(manifestBefore);
    expect((await manager.verify(second.manifestFile)).ready).toBe(true);
  });

  it("restores the previous service and manifest when update readiness fails after replacement", async () => {
    const sandbox = await mkdtemp(path.join(os.tmpdir(), "codex-router-update-fault-"));
    const root = path.join(sandbox, "managed");
    const releaseSource = path.join(sandbox, "release");
    const executable = path.join(releaseSource, "codex-router");
    const configPath = path.join(sandbox, "config.json");
    await import("node:fs/promises").then(({ mkdir }) => mkdir(releaseSource, { recursive: true }));
    await writeFile(executable, "#!/bin/sh\nexit 0\n", { mode: 0o700 });
    await writeFile(configPath, "{}\n", { mode: 0o600 });
    const manager = new InstallationManager();
    const first = await manager.plan({ root, version: "1.0.0", releaseSource, entrypoint: "codex-router", configPath, host: "linux" });
    first.checks.splice(0, first.checks.length, { id: "fixture", state: "pass", message: "fixture" });
    const active = await manager.install(first, { consent: true });
    const serviceBefore = await readFile(active.serviceFile);
    const manifestBefore = await readFile(first.manifestFile);

    await writeFile(executable, "#!/bin/sh\nexit 1\n", { mode: 0o700 });
    const second = await manager.plan({ root, version: "1.1.0", releaseSource, entrypoint: "codex-router", configPath, host: "linux" });
    second.checks.splice(0, second.checks.length, { id: "fixture", state: "pass", message: "fixture" });
    const verify = vi.spyOn(manager, "verify").mockResolvedValueOnce({ ready: false, checks: [], manifest: active });

    await expect(manager.install(second, { consent: true })).rejects.toThrow(/readiness/);
    verify.mockRestore();
    expect(await readFile(active.serviceFile)).toEqual(serviceBefore);
    expect(await readFile(first.manifestFile)).toEqual(manifestBefore);
    expect((await manager.verify(first.manifestFile)).ready).toBe(true);
    await expect(stat(second.releaseRoot)).rejects.toThrow();
  });
});
