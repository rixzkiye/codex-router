import { execFile } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { chmod, cp, lstat, mkdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const INSTALL_OWNER = "codex-router-platform/v1";

export type SupportedHost = "linux" | "darwin" | "win32";

export interface InstallCheck {
  id: string;
  state: "pass" | "warning" | "fail";
  message: string;
}

export interface InstallPlan {
  id: string;
  host: SupportedHost;
  root: string;
  releaseRoot: string;
  previousRelease: string | null;
  version: string;
  releaseSource: string;
  entrypoint: string;
  configPath: string;
  serviceFile: string;
  manifestFile: string;
  checks: InstallCheck[];
}

export interface InstallManifest {
  owner: typeof INSTALL_OWNER;
  version: 2;
  host: SupportedHost;
  releaseVersion: string;
  activeRelease: string;
  previousRelease: string | null;
  executableFile: string;
  entrypoint: string;
  configPath: string;
  serviceFile: string;
  releases: Record<string, {
    releaseVersion: string;
    entrypoint: string;
    executableHash: string;
    installedAt: string;
  }>;
  hashes: Record<string, string>;
  installedAt: string;
  state: "active" | "disabled" | "attention";
}

export interface ServiceDefinition {
  host: SupportedHost;
  fileName: string;
  content: string;
  installCommand: string[];
  startCommand: string[];
  stopCommand: string[];
}

export class InstallationManager {
  async plan(input: { root: string; version: string; releaseSource: string; entrypoint: string; configPath: string; host?: NodeJS.Platform }): Promise<InstallPlan> {
    const root = safeRoot(input.root);
    const host = normalizeHost(input.host ?? process.platform);
    const releaseSource = path.resolve(input.releaseSource);
    const entrypoint = safeRelative(input.entrypoint);
    const manifestFile = path.join(root, "install-manifest.json");
    const previous = await readManifest(manifestFile);
    const releaseRoot = path.join(root, "releases", safeVersion(input.version));
    const service = renderServiceDefinition(host, {
      executable: path.join(releaseRoot, entrypoint),
      configPath: path.resolve(input.configPath),
      stateRoot: root
    });
    const checks = await preflight(host, root, releaseSource, entrypoint, input.configPath, previous);
    return {
      id: randomUUID(),
      host,
      root,
      releaseRoot,
      previousRelease: previous?.activeRelease ?? null,
      version: safeVersion(input.version),
      releaseSource,
      entrypoint,
      configPath: path.resolve(input.configPath),
      serviceFile: path.join(root, "services", service.fileName),
      manifestFile,
      checks
    };
  }

  async install(plan: InstallPlan, options: { consent: boolean; signal?: AbortSignal }): Promise<InstallManifest> {
    if (!options.consent) throw new Error("Installation requires explicit operator consent");
    if (plan.checks.some((check) => check.state === "fail")) throw new Error("Installation preflight contains blocking failures");
    options.signal?.throwIfAborted();
    const staging = path.join(plan.root, ".staging", plan.id);
    let releaseInstalled = false;
    let serviceInstalled = false;
    let manifestInstalled = false;
    let previousService: Uint8Array | null = null;
    let previousManifestFile: Uint8Array | null = null;
    await mkdir(staging, { recursive: true, mode: 0o700 });
    try {
      const releaseStaging = path.join(staging, "release");
      const serviceStaging = path.join(staging, "service");
      await mkdir(serviceStaging, { recursive: true, mode: 0o700 });
      await cp(plan.releaseSource, releaseStaging, { recursive: true, force: false, errorOnExist: true });
      const targetExecutable = path.join(releaseStaging, plan.entrypoint);
      if (process.platform !== "win32") await chmod(targetExecutable, 0o700);
      const service = renderServiceDefinition(plan.host, {
        executable: path.join(plan.releaseRoot, plan.entrypoint),
        configPath: plan.configPath,
        stateRoot: plan.root
      });
      const stagedService = path.join(serviceStaging, service.fileName);
      await writeFile(stagedService, service.content, { mode: 0o600 });
      options.signal?.throwIfAborted();
      await mkdir(path.dirname(plan.releaseRoot), { recursive: true, mode: 0o700 });
      await mkdir(path.dirname(plan.serviceFile), { recursive: true, mode: 0o700 });
      if (await exists(plan.releaseRoot)) throw new Error(`Release ${plan.version} already exists`);
      const previousManifest = await readManifest(plan.manifestFile);
      if ((previousManifest?.activeRelease ?? null) !== plan.previousRelease) {
        throw new Error("Installation state changed after the plan was created; create a fresh plan");
      }
      previousService = (await exists(plan.serviceFile)) ? await readFile(plan.serviceFile) : null;
      previousManifestFile = (await exists(plan.manifestFile)) ? await readFile(plan.manifestFile) : null;
      options.signal?.throwIfAborted();
      await rename(releaseStaging, plan.releaseRoot);
      releaseInstalled = true;
      await rename(stagedService, plan.serviceFile);
      serviceInstalled = true;
      const executableFile = path.join(plan.releaseRoot, plan.entrypoint);
      const executableHash = await fileHash(executableFile);
      const hashes = {
        executable: executableHash,
        service: await fileHash(plan.serviceFile),
        config: await fileHash(plan.configPath)
      };
      const installedAt = new Date().toISOString();
      const manifest: InstallManifest = {
        owner: INSTALL_OWNER,
        version: 2,
        host: plan.host,
        releaseVersion: plan.version,
        activeRelease: plan.releaseRoot,
        previousRelease: plan.previousRelease,
        executableFile,
        entrypoint: plan.entrypoint,
        configPath: plan.configPath,
        serviceFile: plan.serviceFile,
        releases: {
          ...(previousManifest?.releases ?? {}),
          [plan.releaseRoot]: {
            releaseVersion: plan.version,
            entrypoint: plan.entrypoint,
            executableHash,
            installedAt
          }
        },
        hashes,
        installedAt,
        state: "active"
      };
      await atomicJson(plan.manifestFile, manifest);
      manifestInstalled = true;
      options.signal?.throwIfAborted();
      const readback = await this.verify(plan.manifestFile);
      if (!readback.ready) throw new Error("Installed release failed readiness verification");
      return readback.manifest;
    } catch (error) {
      if (manifestInstalled) {
        if (previousManifestFile) await atomicFile(plan.manifestFile, previousManifestFile);
        else await rm(plan.manifestFile, { force: true });
      }
      if (serviceInstalled) {
        if (previousService) await atomicFile(plan.serviceFile, previousService);
        else await rm(plan.serviceFile, { force: true });
      }
      if (releaseInstalled) await rm(plan.releaseRoot, { recursive: true, force: true });
      throw error;
    } finally {
      await rm(staging, { recursive: true, force: true });
    }
  }

  async verify(manifestFile: string): Promise<{ ready: boolean; checks: InstallCheck[]; manifest: InstallManifest }> {
    const manifest = await requireManifest(manifestFile);
    const checks: InstallCheck[] = [];
    for (const [id, file] of [["executable", manifest.executableFile], ["service", manifest.serviceFile], ["config", manifest.configPath]] as const) {
      const expected = manifest.hashes[id];
      if (!expected || !(await exists(file))) {
        checks.push({ id, state: "fail", message: `${id} is missing from the managed installation.` });
        continue;
      }
      checks.push((await fileHash(file)) === expected
        ? { id, state: "pass", message: `${id} hash matches the installation manifest.` }
        : { id, state: "fail", message: `${id} drifted from the installation manifest.` });
    }
    return { ready: checks.every((check) => check.state === "pass") && manifest.state === "active", checks, manifest };
  }

  async rollback(manifestFile: string, options: { consent: boolean }): Promise<InstallManifest> {
    if (!options.consent) throw new Error("Rollback requires explicit operator consent");
    const manifest = await requireManifest(manifestFile);
    if (!manifest.previousRelease || !(await exists(manifest.previousRelease))) throw new Error("No runnable rollback target is retained");
    const target = manifest.releases[manifest.previousRelease];
    if (!target) throw new Error("Rollback target is not owned by the installation manifest");
    const executableFile = path.join(manifest.previousRelease, target.entrypoint);
    if (!(await exists(executableFile)) || (await fileHash(executableFile)) !== target.executableHash) {
      throw new Error("Rollback target failed executable integrity verification");
    }
    const service = renderServiceDefinition(manifest.host, {
      executable: executableFile,
      configPath: manifest.configPath,
      stateRoot: path.dirname(manifestFile)
    });
    if (path.basename(manifest.serviceFile) !== service.fileName) {
      throw new Error("Managed service definition does not match the installation host");
    }
    const previousService = await readFile(manifest.serviceFile);
    await atomicFile(manifest.serviceFile, service.content);
    const updated: InstallManifest = {
      ...manifest,
      activeRelease: manifest.previousRelease,
      previousRelease: manifest.activeRelease,
      releaseVersion: target.releaseVersion,
      executableFile,
      entrypoint: target.entrypoint,
      hashes: {
        executable: target.executableHash,
        service: await fileHash(manifest.serviceFile),
        config: await fileHash(manifest.configPath)
      },
      installedAt: new Date().toISOString(),
      state: "active"
    };
    try {
      await atomicJson(manifestFile, updated);
      const readback = await this.verify(manifestFile);
      if (!readback.ready) throw new Error("Rolled-back installation failed readiness verification");
      return readback.manifest;
    } catch (error) {
      await atomicFile(manifest.serviceFile, previousService);
      await atomicJson(manifestFile, manifest);
      throw error;
    }
  }

  async disable(manifestFile: string, options: { consent: boolean }): Promise<InstallManifest> {
    if (!options.consent) throw new Error("Disable requires explicit operator consent");
    const manifest = await requireManifest(manifestFile);
    const updated = { ...manifest, state: "disabled" as const };
    await atomicJson(manifestFile, updated);
    return requireManifest(manifestFile);
  }

  async uninstall(manifestFile: string, options: { consent: boolean; removeRetainedReleases?: boolean }): Promise<{ removed: string[]; retained: string[] }> {
    if (!options.consent) throw new Error("Uninstall requires explicit operator consent");
    const manifest = await requireManifest(manifestFile);
    const root = safeRoot(path.dirname(manifestFile));
    const owned = [manifest.serviceFile, manifest.activeRelease];
    if (options.removeRetainedReleases && manifest.previousRelease) owned.push(manifest.previousRelease);
    const removed: string[] = [];
    for (const target of owned) {
      assertInside(root, target);
      if (!(await exists(target))) continue;
      await rm(target, { recursive: true, force: true });
      removed.push(target);
    }
    await rm(manifestFile, { force: true });
    removed.push(manifestFile);
    return {
      removed,
      retained: [path.join(root, "backups"), path.join(root, "logs"), path.join(root, "credentials"), path.join(root, "models")]
    };
  }
}

export function renderServiceDefinition(
  host: SupportedHost,
  input: { executable: string; configPath: string; stateRoot: string }
): ServiceDefinition {
  const args = [input.executable, "web", "--config", input.configPath, "--host", "127.0.0.1"];
  if (host === "linux") {
    return {
      host,
      fileName: "codex-router.service",
      content: [
        "[Unit]",
        "Description=Codex Router Platform",
        "After=network-online.target",
        "",
        "[Service]",
        `ExecStart=${systemdEscape(args)}`,
        `WorkingDirectory=${systemdPath(input.stateRoot)}`,
        "Restart=on-failure",
        "RestartSec=5",
        "NoNewPrivileges=true",
        "PrivateTmp=true",
        "",
        "[Install]",
        "WantedBy=default.target",
        ""
      ].join("\n"),
      installCommand: ["systemctl", "--user", "link"],
      startCommand: ["systemctl", "--user", "enable", "--now", "codex-router.service"],
      stopCommand: ["systemctl", "--user", "disable", "--now", "codex-router.service"]
    };
  }
  if (host === "darwin") {
    return {
      host,
      fileName: "com.rixzkiye.codex-router.plist",
      content: [
        "<?xml version=\"1.0\" encoding=\"UTF-8\"?>",
        "<!DOCTYPE plist PUBLIC \"-//Apple//DTD PLIST 1.0//EN\" \"http://www.apple.com/DTDs/PropertyList-1.0.dtd\">",
        "<plist version=\"1.0\"><dict>",
        "<key>Label</key><string>com.rixzkiye.codex-router</string>",
        `<key>ProgramArguments</key><array>${args.map((arg) => `<string>${xml(arg)}</string>`).join("")}</array>`,
        `<key>WorkingDirectory</key><string>${xml(input.stateRoot)}</string>`,
        "<key>RunAtLoad</key><true/><key>KeepAlive</key><dict><key>SuccessfulExit</key><false/></dict>",
        "</dict></plist>",
        ""
      ].join("\n"),
      installCommand: ["launchctl", "bootstrap", `gui/${process.getuid?.() ?? 0}`],
      startCommand: ["launchctl", "kickstart", "-k", `gui/${process.getuid?.() ?? 0}/com.rixzkiye.codex-router`],
      stopCommand: ["launchctl", "bootout", `gui/${process.getuid?.() ?? 0}/com.rixzkiye.codex-router`]
    };
  }
  return {
    host,
    fileName: "codex-router-task.xml",
    content: [
      "<?xml version=\"1.0\" encoding=\"UTF-16\"?>",
      "<Task version=\"1.4\" xmlns=\"http://schemas.microsoft.com/windows/2004/02/mit/task\">",
      "<Triggers><LogonTrigger><Enabled>true</Enabled></LogonTrigger></Triggers>",
      "<Principals><Principal id=\"Author\"><LogonType>InteractiveToken</LogonType><RunLevel>LeastPrivilege</RunLevel></Principal></Principals>",
      `<Actions Context=\"Author\"><Exec><Command>${xml(input.executable)}</Command><Arguments>${xml(args.slice(1).map(windowsArg).join(" "))}</Arguments><WorkingDirectory>${xml(input.stateRoot)}</WorkingDirectory></Exec></Actions>`,
      "<Settings><MultipleInstancesPolicy>IgnoreNew</MultipleInstancesPolicy><RestartOnFailure><Interval>PT5S</Interval><Count>3</Count></RestartOnFailure></Settings>",
      "</Task>",
      ""
    ].join("\n"),
    installCommand: ["schtasks.exe", "/Create", "/TN", "Codex Router", "/XML"],
    startCommand: ["schtasks.exe", "/Run", "/TN", "Codex Router"],
    stopCommand: ["schtasks.exe", "/End", "/TN", "Codex Router"]
  };
}

async function preflight(host: SupportedHost, root: string, releaseSource: string, entrypoint: string, configPath: string, previous: InstallManifest | null): Promise<InstallCheck[]> {
  const checks: InstallCheck[] = [
    { id: "host", state: "pass", message: `${host} current-user installation selected.` },
    { id: "state-root", state: "pass", message: `Managed state is scoped to ${root}.` }
  ];
  checks.push(await commandCheck("git", ["--version"]));
  checks.push(await commandCheck("codex", ["--version"], true));
  checks.push(await commandCheck("uv", ["--version"], true));
  checks.push((await exists(path.join(releaseSource, entrypoint))) ? { id: "artifact", state: "pass", message: "Release entrypoint exists inside the artifact root." } : { id: "artifact", state: "fail", message: "Release entrypoint is missing." });
  checks.push((await exists(configPath)) ? { id: "config", state: "pass", message: "Router configuration exists." } : { id: "config", state: "fail", message: "Router configuration is missing." });
  if (previous) checks.push({ id: "upgrade", state: "pass", message: `Recognized owned installation ${previous.releaseVersion}; rollback target will be retained.` });
  return checks;
}

async function commandCheck(command: string, args: string[], optional = false): Promise<InstallCheck> {
  try {
    await execFileAsync(command, args, { timeout: 10_000, windowsHide: true });
    return { id: command, state: "pass", message: `${command} is available.` };
  } catch {
    return { id: command, state: optional ? "warning" : "fail", message: `${command} is not available.` };
  }
}

async function readManifest(file: string): Promise<InstallManifest | null> {
  try {
    const info = await lstat(file);
    if (!info.isFile() || info.isSymbolicLink()) throw new Error("Installation manifest is not a regular file");
    const value: unknown = JSON.parse(await readFile(file, "utf8"));
    if (!isManifest(value)) throw new Error("Foreign or malformed installation manifest");
    return value;
  } catch (error) {
    if (isErrno(error, "ENOENT")) return null;
    throw error;
  }
}

async function requireManifest(file: string): Promise<InstallManifest> {
  const manifest = await readManifest(file);
  if (!manifest) throw new Error("Managed installation manifest was not found");
  return manifest;
}

function isManifest(value: unknown): value is InstallManifest {
  if (!isRecord(value)) return false;
  return value.owner === INSTALL_OWNER
    && value.version === 2
    && (value.host === "linux" || value.host === "darwin" || value.host === "win32")
    && typeof value.releaseVersion === "string"
    && typeof value.activeRelease === "string"
    && (value.previousRelease === null || typeof value.previousRelease === "string")
    && typeof value.executableFile === "string"
    && typeof value.entrypoint === "string"
    && typeof value.configPath === "string"
    && typeof value.serviceFile === "string"
    && isRecord(value.releases)
    && isRecord(value.hashes);
}

async function atomicJson(file: string, value: unknown): Promise<void> {
  await atomicFile(file, `${JSON.stringify(value, null, 2)}\n`);
}

async function atomicFile(file: string, value: string | Uint8Array): Promise<void> {
  await mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
  const temporary = `${file}.${randomUUID()}.tmp`;
  await writeFile(temporary, value, { mode: 0o600 });
  await rename(temporary, file);
}

async function fileHash(file: string): Promise<string> {
  return createHash("sha256").update(await readFile(file)).digest("hex");
}

function safeRoot(value: string): string {
  const root = path.resolve(value);
  const filesystemRoot = path.parse(root).root;
  if (root === filesystemRoot || root === path.resolve(os.homedir())) throw new Error("Installation root must be a dedicated non-root directory");
  return root;
}

function assertInside(root: string, target: string): void {
  const relative = path.relative(root, path.resolve(target));
  if (!relative || relative.startsWith("..") || path.isAbsolute(relative)) throw new Error(`Refusing to mutate path outside the managed installation: ${target}`);
}

function safeVersion(value: string): string {
  if (!/^[0-9A-Za-z][0-9A-Za-z._-]{0,63}$/.test(value)) throw new Error("Invalid release version");
  return value;
}

function safeRelative(value: string): string {
  const normalized = path.normalize(value);
  if (!normalized || normalized === "." || path.isAbsolute(normalized) || normalized.startsWith(`..${path.sep}`) || normalized === "..") {
    throw new Error("Release entrypoint must stay inside the artifact root");
  }
  return normalized;
}

function normalizeHost(host: NodeJS.Platform): SupportedHost {
  if (host === "linux" || host === "darwin" || host === "win32") return host;
  throw new Error(`Unsupported installation host: ${host}`);
}

function systemdQuote(value: string): string {
  return `\"${value.replaceAll("\\", "\\\\").replaceAll("\"", "\\\"")}\"`;
}

function systemdPath(value: string): string {
  if (/\r|\n/.test(value)) throw new Error("Service paths cannot contain newlines");
  return value.replaceAll("%", "%%");
}

function systemdEscape(args: string[]): string {
  return args.map(systemdQuote).join(" ");
}

function windowsArg(value: string): string {
  return `\"${value.replaceAll("\"", "\\\"")}\"`;
}

function xml(value: string): string {
  return value.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll("\"", "&quot;").replaceAll("'", "&apos;");
}

async function exists(file: string): Promise<boolean> {
  try { await stat(file); return true; } catch { return false; }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isErrno(error: unknown, code: string): boolean {
  return isRecord(error) && error.code === code;
}
