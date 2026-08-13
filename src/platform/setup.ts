import { randomBytes } from "node:crypto";
import { chmod, mkdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createServer } from "node:net";
import { once } from "node:events";
import { loadConfig, type RouterConfig } from "../config.js";
import { systemCommandRunner, type CommandRunner } from "./command.js";
import { McpInstallationManager, type McpInspection, type McpInstallationSnapshot } from "./mcp-installation.js";
import { managedPaths, type ManagedPaths } from "./paths.js";
import { UserServiceManager, type ManagedServiceStatus, type ServiceLaunch, type SupportedServiceHost } from "./service-manager.js";

const SETUP_OWNER = "@rixzkiye/codex-router";

export interface SetupManifest {
  readonly owner: typeof SETUP_OWNER;
  readonly version: 1;
  readonly packageVersion: string;
  readonly configPath: string;
  readonly worktreeRoot: string;
  readonly nodeExecutable: string;
  readonly entryScript: string;
  readonly port: number;
  readonly background: boolean;
  readonly startAtLogin: boolean;
  readonly mcpEnabled: boolean;
  readonly installedAt: string;
  readonly updatedAt: string;
}

export interface SetupOptions {
  readonly worktreeRoot: string;
  readonly background: boolean;
  readonly startAtLogin: boolean;
  readonly mcpEnabled: boolean;
  readonly adoptMcp?: boolean;
  readonly port?: number;
}

export interface SetupDependencies {
  readonly paths?: ManagedPaths;
  readonly host?: SupportedServiceHost;
  readonly home?: string;
  readonly nodeExecutable?: string;
  readonly entryScript: string;
  readonly packageVersion: string;
  readonly runner?: CommandRunner;
  readonly codexCommand?: string;
  readonly serviceProbe?: (endpoint: string, controlToken: string) => Promise<void>;
  readonly portProbe?: (port: number) => Promise<void>;
}

export interface ManagedSetupStatus {
  readonly configured: boolean;
  readonly background: boolean;
  readonly startAtLogin: boolean;
  readonly service: ManagedServiceStatus;
  readonly mcp: Pick<McpInspection, "state" | "message"> | { state: "disabled"; message: string };
  readonly url: string;
  readonly paths: ManagedPaths;
}

export interface DoctorCheck {
  readonly id: string;
  readonly state: "pass" | "warning" | "fail";
  readonly message: string;
}

export class ManagedSetup {
  readonly paths: ManagedPaths;
  readonly host: SupportedServiceHost;
  readonly home: string;
  private readonly nodeExecutable: string;
  private readonly entryScript: string;
  private readonly packageVersion: string;
  private readonly runner: CommandRunner;
  private readonly codexCommand: string;
  private readonly serviceProbe: (endpoint: string, controlToken: string) => Promise<void>;
  private readonly portProbe: (port: number) => Promise<void>;

  constructor(dependencies: SetupDependencies) {
    this.host = dependencies.host ?? normalizeHost(process.platform);
    this.home = path.resolve(dependencies.home ?? os.homedir());
    this.paths = dependencies.paths ?? managedPaths({ platform: this.host, home: this.home });
    this.nodeExecutable = path.resolve(dependencies.nodeExecutable ?? process.execPath);
    this.entryScript = path.resolve(dependencies.entryScript);
    this.packageVersion = dependencies.packageVersion;
    this.runner = dependencies.runner ?? systemCommandRunner;
    this.codexCommand = dependencies.codexCommand ?? "codex";
    this.serviceProbe = dependencies.serviceProbe ?? probeManagedService;
    this.portProbe = dependencies.portProbe ?? assertLoopbackPortAvailable;
  }

  async manifest(): Promise<SetupManifest | null> {
    return readSetupManifest(this.paths.manifestFile);
  }

  async apply(options: SetupOptions): Promise<ManagedSetupStatus> {
    const existing = await this.manifest();
    const worktreeRoot = await safeWorktreeRoot(options.worktreeRoot, this.home);
    const port = options.port ?? existing?.port ?? 4178;
    if (!Number.isInteger(port) || port < 1 || port > 65_535) throw new Error("The Console port must be an integer between 1 and 65535.");
    if (await exists(this.paths.configFile) && !existing) {
      throw new Error(`Refusing to overwrite an unmanaged config at ${this.paths.configFile}. Move it or adopt it manually first.`);
    }
    const previousServiceStatus = existing ? await this.service(existing).status() : null;
    if (!previousServiceStatus?.running || port !== existing?.port) await this.portProbe(port);

    const previousManifest = await readOptional(this.paths.manifestFile);
    const previousConfig = await readOptional(this.paths.configFile);
    const previousControlToken = await readOptional(this.paths.controlTokenFile);
    const previousService = await readOptional(this.paths.serviceFile);
    const now = new Date().toISOString();
    const manifest: SetupManifest = {
      owner: SETUP_OWNER,
      version: 1,
      packageVersion: this.packageVersion,
      configPath: this.paths.configFile,
      worktreeRoot,
      nodeExecutable: this.nodeExecutable,
      entryScript: this.entryScript,
      port,
      background: options.background,
      startAtLogin: options.startAtLogin,
      mcpEnabled: options.mcpEnabled,
      installedAt: existing?.installedAt ?? now,
      updatedAt: now
    };
    const service = this.service(manifest);
    const mcp = this.mcp();
    let mcpSnapshot: McpInstallationSnapshot | null = null;
    let serviceTouched = false;
    try {
      await secureDirectory(this.paths.configRoot);
      await secureDirectory(this.paths.stateRoot);
      await secureDirectory(path.dirname(this.paths.logFile));
      if (!(await exists(this.paths.configFile))) {
        await atomicJson(this.paths.configFile, defaultManagedConfig(this.paths, worktreeRoot));
      } else if (existing && path.resolve(existing.worktreeRoot) !== worktreeRoot) {
        await updateManagedWorktreeRoot(this.paths.configFile, existing.worktreeRoot, worktreeRoot);
      }
      if (!(await exists(this.paths.controlTokenFile))) {
        await atomicSecret(this.paths.controlTokenFile, `${randomBytes(32).toString("base64url")}\n`);
      }
      if (options.mcpEnabled || existing?.mcpEnabled) mcpSnapshot = await mcp.snapshot();
      serviceTouched = true;
      await service.install();
      if (options.background && previousServiceStatus?.running && serviceRequiresRestart(existing, manifest, previousService, service)) {
        await service.restart();
      } else if (options.background) await service.start({ startAtLogin: options.startAtLogin });
      else await service.stop();
      if (options.mcpEnabled) await mcp.install(this.paths.configFile, options.adoptMcp ? { adoptForeign: true } : {});
      else if (existing?.mcpEnabled) {
        const removal = await mcp.uninstall(this.paths.configFile);
        if (!removal.removed && !removal.message.startsWith("No Codex MCP entry")) throw new Error(removal.message);
      }
      if (options.background) {
        const controlToken = (await readFile(this.paths.controlTokenFile, "utf8")).trim();
        await this.serviceProbe(`http://127.0.0.1:${port}/api/v1/bootstrap-ticket`, controlToken);
      }
      await atomicJson(this.paths.manifestFile, manifest);
      return this.status();
    } catch (error) {
      const rollbackErrors: unknown[] = [];
      const snapshot = mcpSnapshot;
      if (snapshot) await captureRollback(rollbackErrors, () => mcp.restore(snapshot));
      await captureRollback(rollbackErrors, () => restoreOptionalFile(this.paths.configFile, previousConfig));
      await captureRollback(rollbackErrors, () => restoreOptionalFile(this.paths.controlTokenFile, previousControlToken));
      await captureRollback(rollbackErrors, () => restoreOptionalFile(this.paths.manifestFile, previousManifest));
      if (serviceTouched) await captureRollback(rollbackErrors, () => this.restoreService(service, existing, previousService, previousServiceStatus));
      throwAfterRollback("Managed setup", error, rollbackErrors);
    }
  }

  async status(): Promise<ManagedSetupStatus> {
    const manifest = await this.manifest();
    if (!manifest) {
      return {
        configured: false,
        background: false,
        startAtLogin: false,
        service: { state: "missing", installed: false, running: false, startAtLogin: false, message: "Run codex-router setup to create the managed installation." },
        mcp: { state: "disabled", message: "MCP setup has not been requested." },
        url: "http://127.0.0.1:4178",
        paths: this.paths
      };
    }
    const [service, mcp] = await Promise.all([
      this.service(manifest).status(),
      manifest.mcpEnabled
        ? this.mcp().inspect(manifest.configPath)
        : Promise.resolve({ state: "disabled" as const, message: "Codex MCP registration is disabled by setup preference." })
    ]);
    return {
      configured: true,
      background: manifest.background,
      startAtLogin: service.startAtLogin,
      service,
      mcp: { state: mcp.state, message: mcp.message },
      url: `http://127.0.0.1:${manifest.port}`,
      paths: this.paths
    };
  }

  async setBackground(enabled: boolean, startAtLogin: boolean): Promise<ManagedSetupStatus> {
    const manifest = await this.requireManifest();
    const updated: SetupManifest = { ...manifest, background: enabled, startAtLogin, updatedAt: new Date().toISOString() };
    const previousManifest = await readOptional(this.paths.manifestFile);
    const previousService = await readOptional(this.paths.serviceFile);
    const previousServiceStatus = await this.service(manifest).status();
    const service = this.service(updated);
    try {
      await service.install();
      // Persist before stop: a service manager may terminate this process as soon as stop succeeds.
      await atomicJson(this.paths.manifestFile, updated);
      if (enabled) await service.start({ startAtLogin });
      else await service.stop();
      return this.status();
    } catch (error) {
      const rollbackErrors: unknown[] = [];
      await captureRollback(rollbackErrors, () => restoreOptionalFile(this.paths.manifestFile, previousManifest));
      await captureRollback(rollbackErrors, () => this.restoreService(service, manifest, previousService, previousServiceStatus));
      throwAfterRollback("Background preference update", error, rollbackErrors);
    }
  }

  async startBackground(): Promise<void> {
    const manifest = await this.requireManifest();
    await this.service(manifest).start({ startAtLogin: manifest.startAtLogin });
  }

  async stop(): Promise<void> {
    const manifest = await this.requireManifest();
    await this.service(manifest).stop();
  }

  async restart(): Promise<void> {
    const manifest = await this.requireManifest();
    await this.service(manifest).restart();
  }

  async uninstall(options: { purge?: boolean } = {}): Promise<{ removed: string[]; retained: string[] }> {
    const manifest = await this.requireManifest();
    const removed: string[] = [];
    const mcpResult = await this.mcp().uninstall(manifest.configPath);
    if (mcpResult.removed) removed.push("Codex MCP entry codex-router");
    await this.service(manifest).uninstall();
    removed.push(this.paths.serviceFile);
    await rm(this.paths.manifestFile, { force: true });
    await rm(this.paths.controlTokenFile, { force: true });
    removed.push(this.paths.manifestFile, this.paths.controlTokenFile);
    if (options.purge) {
      await rm(this.paths.stateRoot, { recursive: true, force: true });
      if (this.paths.configRoot !== this.paths.stateRoot) await rm(this.paths.configRoot, { recursive: true, force: true });
      removed.push(this.paths.stateRoot, this.paths.configRoot);
      return { removed: unique(removed), retained: [] };
    }
    return { removed: unique(removed), retained: unique([this.paths.configFile, this.paths.databaseFile, this.paths.logFile]) };
  }

  async doctor(): Promise<DoctorCheck[]> {
    const manifest = await this.manifest();
    if (!manifest) return [{ id: "setup", state: "fail", message: "Managed setup is absent. Run codex-router setup." }];
    const status = await this.status();
    const config = await inspectManagedConfig(manifest.configPath);
    const checks: DoctorCheck[] = [
      { id: "config", state: config.ready ? "pass" : "fail", message: config.message },
      { id: "service", state: status.service.state === "attention" || status.service.state === "missing" ? "fail" : status.service.running ? "pass" : "warning", message: status.service.message },
      { id: "mcp", state: status.mcp.state === "owned" || status.mcp.state === "disabled" ? "pass" : status.mcp.state === "absent" ? "warning" : "fail", message: status.mcp.message },
      { id: "control-token", state: await isPrivateFile(this.paths.controlTokenFile) ? "pass" : "fail", message: this.paths.controlTokenFile },
      { id: "package-version", state: manifest.packageVersion === this.packageVersion ? "pass" : "warning", message: manifest.packageVersion === this.packageVersion ? this.packageVersion : `Service setup ${manifest.packageVersion}; installed CLI ${this.packageVersion}. Run codex-router setup to refresh it.` }
    ];
    return checks;
  }

  logsCommand(follow: boolean): { command: string; args: string[] } {
    return this.serviceForCurrentPackage().logsCommand(follow);
  }

  async requestBootstrapUrl(options: { attempts?: number; delayMs?: number } = {}): Promise<string> {
    const manifest = await this.requireManifest();
    const controlToken = (await readFile(this.paths.controlTokenFile, "utf8")).trim();
    const endpoint = `http://127.0.0.1:${manifest.port}/api/v1/bootstrap-ticket`;
    const attempts = options.attempts ?? 40;
    const delayMs = options.delayMs ?? 125;
    let lastError = "service did not respond";
    for (let attempt = 0; attempt < attempts; attempt += 1) {
      try {
        const response = await fetch(endpoint, { method: "POST", headers: { Authorization: `Bearer ${controlToken}` } });
        if (response.ok) {
          const body = await response.json() as { bootstrapUrl?: unknown };
          if (typeof body.bootstrapUrl === "string" && safeBootstrapUrl(body.bootstrapUrl, manifest.port)) return body.bootstrapUrl;
          lastError = "service returned an invalid bootstrap ticket";
        } else {
          lastError = `service returned HTTP ${response.status}`;
        }
      } catch (error) {
        lastError = error instanceof Error ? error.message : String(error);
      }
      await new Promise((resolve) => setTimeout(resolve, delayMs));
    }
    throw new Error(`Codex Router Console was not ready: ${lastError}`);
  }

  private async requireManifest(): Promise<SetupManifest> {
    const manifest = await this.manifest();
    if (!manifest) throw new Error("Codex Router is not set up. Run codex-router setup first.");
    return manifest;
  }

  private service(manifest: SetupManifest): UserServiceManager {
    return new UserServiceManager(this.paths, launchFromManifest(manifest, this.host, this.paths), this.runner);
  }

  private serviceForCurrentPackage(): UserServiceManager {
    const launch: ServiceLaunch = {
      host: this.host,
      nodeExecutable: this.nodeExecutable,
      entryScript: this.entryScript,
      configPath: this.paths.configFile,
      controlTokenFile: this.paths.controlTokenFile,
      port: 4178,
      startAtLogin: false
    };
    return new UserServiceManager(this.paths, launch, this.runner);
  }

  private mcp(): McpInstallationManager {
    return new McpInstallationManager(this.paths.mcpManifestFile, this.runner, this.codexCommand);
  }

  private async restoreService(
    currentService: UserServiceManager,
    previousManifest: SetupManifest | null,
    previousDefinition: Uint8Array | null,
    previousStatus: ManagedServiceStatus | null
  ): Promise<void> {
    if (!previousManifest || !previousDefinition) {
      await currentService.uninstall();
      return;
    }
    await writeFile(this.paths.serviceFile, previousDefinition, { mode: 0o600 });
    const previousService = this.service(previousManifest);
    await previousService.install();
    if (previousStatus?.running) await previousService.restart();
    else await previousService.stop();
  }
}

export function defaultManagedConfig(paths: ManagedPaths, worktreeRoot: string): RouterConfig {
  return {
    databasePath: paths.databaseFile,
    allowedWorktreeRoots: [path.resolve(worktreeRoot)],
    maxWaitMs: 30_000,
    leaseTtlMs: 120_000,
    idempotencyTtlMs: 7 * 24 * 60 * 60 * 1000,
    runtimes: []
  };
}

export async function readSetupManifest(file: string): Promise<SetupManifest | null> {
  try {
    const parsed = JSON.parse(await readFile(file, "utf8")) as Partial<SetupManifest>;
    if (parsed.owner !== SETUP_OWNER || parsed.version !== 1 || typeof parsed.configPath !== "string"
      || typeof parsed.nodeExecutable !== "string" || typeof parsed.entryScript !== "string"
      || typeof parsed.port !== "number" || typeof parsed.background !== "boolean"
      || typeof parsed.startAtLogin !== "boolean" || typeof parsed.mcpEnabled !== "boolean") {
      throw new Error(`Invalid Codex Router setup manifest at ${file}`);
    }
    return parsed as SetupManifest;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
}

function launchFromManifest(manifest: SetupManifest, host: SupportedServiceHost, paths: ManagedPaths): ServiceLaunch {
  return {
    host,
    nodeExecutable: manifest.nodeExecutable,
    entryScript: manifest.entryScript,
    configPath: manifest.configPath,
    controlTokenFile: paths.controlTokenFile,
    port: manifest.port,
    startAtLogin: manifest.startAtLogin
  };
}

async function safeWorktreeRoot(candidate: string, home: string): Promise<string> {
  const root = path.resolve(candidate);
  const parsed = path.parse(root);
  if (root === parsed.root) throw new Error("Filesystem root cannot be an allowed worktree root.");
  if (root === home) throw new Error("The user home directory is too broad; choose a dedicated projects or worktrees directory.");
  const info = await stat(root).catch(() => null);
  if (!info?.isDirectory()) throw new Error(`Allowed worktree root does not exist or is not a directory: ${root}`);
  return root;
}

async function secureDirectory(directory: string): Promise<void> {
  await mkdir(directory, { recursive: true, mode: 0o700 });
  await chmod(directory, 0o700);
}

async function atomicJson(file: string, value: unknown): Promise<void> {
  await atomicSecret(file, `${JSON.stringify(value, null, 2)}\n`);
}

async function atomicSecret(file: string, value: string | Uint8Array): Promise<void> {
  await secureDirectory(path.dirname(file));
  const temporary = `${file}.${process.pid}.tmp`;
  await writeFile(temporary, value, { mode: 0o600 });
  await chmod(temporary, 0o600);
  await rename(temporary, file);
}

async function exists(file: string): Promise<boolean> {
  return stat(file).then(() => true, (error: NodeJS.ErrnoException) => error.code === "ENOENT" ? false : Promise.reject(error));
}

async function readOptional(file: string): Promise<Uint8Array | null> {
  return readFile(file).catch((error: NodeJS.ErrnoException) => error.code === "ENOENT" ? null : Promise.reject(error));
}

async function restoreOptionalFile(file: string, contents: Uint8Array | null): Promise<void> {
  if (!contents) {
    await rm(file, { force: true });
    return;
  }
  await atomicSecret(file, contents);
}

async function updateManagedWorktreeRoot(file: string, previousRoot: string, nextRoot: string): Promise<void> {
  const config = await loadConfig(file);
  const normalizedPrevious = path.resolve(previousRoot);
  if (!config.allowedWorktreeRoots.some((root) => path.resolve(root) === normalizedPrevious)) {
    throw new Error(`Managed config worktree roots drifted from the setup manifest. Expected ${normalizedPrevious}; reconcile ${file} before changing the setup root.`);
  }
  const raw = JSON.parse(await readFile(file, "utf8")) as Record<string, unknown>;
  raw.allowedWorktreeRoots = unique(config.allowedWorktreeRoots.map((root) => path.resolve(root) === normalizedPrevious ? nextRoot : root));
  await atomicJson(file, raw);
  await loadConfig(file);
}

async function captureRollback(errors: unknown[], action: () => Promise<unknown>): Promise<void> {
  try {
    await action();
  } catch (error) {
    errors.push(error);
  }
}

function throwAfterRollback(operation: string, error: unknown, rollbackErrors: unknown[]): never {
  if (rollbackErrors.length === 0) throw error;
  const original = error instanceof Error ? error.message : String(error);
  throw new AggregateError([error, ...rollbackErrors], `${operation} failed (${original}) and rollback was incomplete.`);
}

function serviceRequiresRestart(
  previousManifest: SetupManifest | null,
  nextManifest: SetupManifest,
  previousDefinition: Uint8Array | null,
  nextService: UserServiceManager
): boolean {
  if (!previousManifest || !previousDefinition) return true;
  return previousManifest.packageVersion !== nextManifest.packageVersion
    || path.resolve(previousManifest.worktreeRoot) !== path.resolve(nextManifest.worktreeRoot)
    || Buffer.from(previousDefinition).toString("utf8") !== nextService.definition().content;
}

async function isPrivateFile(file: string): Promise<boolean> {
  try {
    const info = await stat(file);
    return process.platform === "win32" || (info.mode & 0o077) === 0;
  } catch {
    return false;
  }
}

async function inspectManagedConfig(file: string): Promise<{ ready: boolean; message: string }> {
  try {
    await loadConfig(file);
    if (!(await isPrivateFile(file))) return { ready: false, message: `Managed config permissions are too broad: ${file}` };
    return { ready: true, message: `Schema and private permissions passed: ${file}` };
  } catch (error) {
    return { ready: false, message: `Managed config is invalid: ${error instanceof Error ? error.message : String(error)}` };
  }
}

function normalizeHost(host: NodeJS.Platform): SupportedServiceHost {
  if (host === "linux" || host === "darwin" || host === "win32") return host;
  throw new Error(`Managed background services are not supported on ${host}. Use codex-router start in the foreground.`);
}

function unique(values: string[]): string[] {
  return [...new Set(values)];
}

function safeBootstrapUrl(value: string, port: number): boolean {
  try {
    const parsed = new URL(value);
    return parsed.protocol === "http:"
      && parsed.hostname === "127.0.0.1"
      && parsed.port === String(port)
      && parsed.pathname === "/"
      && /^#bootstrap=[A-Za-z0-9_-]+$/.test(parsed.hash);
  } catch {
    return false;
  }
}

async function probeManagedService(endpoint: string, controlToken: string): Promise<void> {
  let lastError = "service did not respond";
  for (let attempt = 0; attempt < 40; attempt += 1) {
    try {
      const response = await fetch(endpoint, { method: "POST", headers: { Authorization: `Bearer ${controlToken}` } });
      if (response.ok) return;
      lastError = `HTTP ${response.status}`;
    } catch (error) {
      lastError = error instanceof Error ? error.message : String(error);
    }
    await new Promise((resolve) => setTimeout(resolve, 125));
  }
  throw new Error(`Managed service failed its bounded readiness probe: ${lastError}`);
}

async function assertLoopbackPortAvailable(port: number): Promise<void> {
  const server = createServer();
  server.unref();
  server.listen(port, "127.0.0.1");
  try {
    await Promise.race([
      once(server, "listening"),
      once(server, "error").then(([error]) => Promise.reject(error))
    ]);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EADDRINUSE") {
      throw new Error(`Console port ${port} is already in use; no control token was sent. Choose another port with --port.`);
    }
    throw error;
  } finally {
    if (server.listening) {
      server.close();
      await once(server, "close");
    }
  }
}
