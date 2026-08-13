import { execFile, spawn } from "node:child_process";
import { constants, lstat, readFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import type { EvidenceState, ProviderDefinition } from "./types.js";

const execFileAsync = promisify(execFile);

export interface AuthenticationObservation {
  state: EvidenceState;
  source: string | null;
  reference: string | null;
  checkedAt: string;
  expiresAt: string | null;
  message: string;
}

export interface OfficialCliProfile {
  executable: string;
  installPackage?: string;
  loginArgs: string[];
  logoutArgs: string[];
  statusArgs?: string[];
  needsTerminal: boolean;
}

export interface LoginLaunch {
  executable: string;
  args: string[];
  consequence: string;
  requiresTerminal: boolean;
}

const CLI_PROFILES: Readonly<Record<string, OfficialCliProfile>> = Object.freeze({
  "native-codex": {
    executable: "codex",
    loginArgs: ["login", "--device-auth"],
    logoutArgs: ["logout"],
    statusArgs: ["login", "status"],
    needsTerminal: true
  },
  "kimi-oauth": {
    executable: "kimi",
    installPackage: "@moonshot-ai/kimi-code",
    loginArgs: ["login"],
    logoutArgs: ["logout"],
    needsTerminal: true
  },
  "grok-oauth": {
    executable: "grok",
    installPackage: "@xai-official/grok",
    loginArgs: ["login", "--oauth"],
    logoutArgs: ["logout"],
    needsTerminal: true
  },
  commandcode: {
    executable: "command-code",
    installPackage: "command-code",
    loginArgs: ["login"],
    logoutArgs: ["logout"],
    needsTerminal: true
  }
});

export function officialCliProfile(providerId: string): OfficialCliProfile | null {
  return CLI_PROFILES[providerId] ?? null;
}

export async function observeAuthentication(
  provider: ProviderDefinition,
  environment: NodeJS.ProcessEnv = process.env
): Promise<AuthenticationObservation> {
  const checkedAt = new Date().toISOString();
  if (provider.credential.mechanism === "keyless") {
    return observation("ready", "local-runtime", null, checkedAt, null, "No credential crosses the loopback boundary.");
  }
  if (provider.id === "native-codex") return observeCodex(environment, checkedAt);
  if (provider.id === "kimi-oauth") return observeKimi(environment, checkedAt);
  if (provider.id === "grok-oauth") return observeGrok(environment, checkedAt);
  if (provider.id === "commandcode") return observeCommandCode(environment, checkedAt);
  for (const reference of provider.credential.references) {
    const variable = environmentVariable(reference);
    if (variable && environment[variable]) {
      return observation("ready", "environment", reference, checkedAt, null, `Credential reference ${reference} resolved.`);
    }
  }
  return observation("unavailable", null, null, checkedAt, null, "No declared credential reference resolved.");
}

export function loginLaunch(providerId: string): LoginLaunch {
  const profile = officialCliProfile(providerId);
  if (!profile) throw new Error(`Provider ${providerId} does not declare an official login CLI`);
  return {
    executable: profile.executable,
    args: [...profile.loginArgs],
    consequence: profile.installPackage
      ? `Uses the official ${profile.executable} CLI. If absent, install ${profile.installPackage} before sign-in.`
      : "Uses the installed Codex CLI and stores credentials inside the selected isolated CODEX_HOME.",
    requiresTerminal: profile.needsTerminal
  };
}

export async function runOfficialCli(
  providerId: string,
  action: "login" | "logout" | "status",
  options: { codexHome?: string; signal?: AbortSignal; inheritTerminal?: boolean } = {}
): Promise<{ exitCode: number; state: "completed" | "failed"; message: string }> {
  const profile = officialCliProfile(providerId);
  if (!profile) throw new Error(`Provider ${providerId} does not declare an official CLI`);
  const args = action === "login" ? profile.loginArgs : action === "logout" ? profile.logoutArgs : profile.statusArgs;
  if (!args) throw new Error(`${profile.executable} does not expose a status command`);
  if (profile.needsTerminal && action === "login" && !options.inheritTerminal) {
    throw new Error(`Run ${profile.executable} ${args.join(" ")} in an interactive terminal`);
  }
  const environment = {
    ...process.env,
    ...(options.codexHome ? { CODEX_HOME: options.codexHome } : {})
  };
  const result = await new Promise<{ code: number; stderr: string }>((resolve, reject) => {
    const child = spawn(profile.executable, args, {
      env: environment,
      stdio: options.inheritTerminal ? "inherit" : ["ignore", "ignore", "pipe"],
      signal: options.signal,
      windowsHide: true
    });
    let stderr = "";
    if (child.stderr) child.stderr.on("data", (chunk: Buffer) => { stderr += chunk.toString("utf8"); });
    child.once("error", reject);
    child.once("close", (code) => resolve({ code: code ?? 1, stderr }));
  });
  const safeDetail = sanitizeCliMessage(result.stderr);
  return result.code === 0
    ? { exitCode: 0, state: "completed", message: `${profile.executable} ${action} completed; authentication must still be read back.` }
    : { exitCode: result.code, state: "failed", message: safeDetail || `${profile.executable} exited with status ${result.code}.` };
}

async function observeCodex(environment: NodeJS.ProcessEnv, checkedAt: string): Promise<AuthenticationObservation> {
  try {
    await execFileAsync("codex", ["login", "status"], {
      env: environment,
      timeout: 10_000,
      windowsHide: true,
      encoding: "utf8"
    });
    return observation("ready", "official-codex-cli", "isolated:CODEX_HOME", checkedAt, null, "Codex reports an authenticated account.");
  } catch (error) {
    return observation("unavailable", "official-codex-cli", "isolated:CODEX_HOME", checkedAt, null, safeExecFailure(error, "Codex is not authenticated."));
  }
}

async function observeKimi(environment: NodeJS.ProcessEnv, checkedAt: string): Promise<AuthenticationObservation> {
  const root = environment.KIMI_CODE_HOME || path.join(os.homedir(), ".kimi-code");
  const file = path.join(root, "credentials", "kimi-code.json");
  const value = await protectedJson(file);
  if (!value) return observation("unavailable", "official-kimi-cli", "official-cli-session", checkedAt, null, "Run `kimi login` in an interactive terminal.");
  const access = stringValue(value.access_token);
  const refresh = stringValue(value.refresh_token);
  if (!access || !refresh) return observation("restricted", "official-kimi-cli", "official-cli-session", checkedAt, null, "Kimi session is incomplete or revoked.");
  const expiry = epochSeconds(value.expires_at);
  const expired = expiry !== null && expiry <= Date.now();
  return observation(expired ? "stale" : "ready", "official-kimi-cli", "official-cli-session", checkedAt, expiry === null ? null : new Date(expiry).toISOString(), expired ? "Access token is stale; the official session must refresh before routing." : "Official Kimi CLI session is present.");
}

async function observeGrok(environment: NodeJS.ProcessEnv, checkedAt: string): Promise<AuthenticationObservation> {
  const root = environment.GROK_HOME || path.join(os.homedir(), ".grok");
  const file = environment.GROK_AUTH_PATH || path.join(root, "auth.json");
  const value = await protectedJson(file);
  if (!value) return observation("unavailable", "official-grok-cli", "official-cli-session", checkedAt, null, "Run `grok login --oauth` in an interactive terminal.");
  const configured = Object.entries(value).some(([scope, entry]) => scope.startsWith("https://auth.x.ai::") && isRecord(entry) && Boolean(stringValue(entry.key)));
  return configured
    ? observation("ready", "official-grok-cli", "official-cli-session", checkedAt, null, "Official Grok CLI session is present.")
    : observation("restricted", "official-grok-cli", "official-cli-session", checkedAt, null, "Grok session is incomplete or revoked.");
}

async function observeCommandCode(environment: NodeJS.ProcessEnv, checkedAt: string): Promise<AuthenticationObservation> {
  const root = environment.COMMAND_CODE_HOME || path.join(os.homedir(), ".commandcode");
  const value = await protectedJson(path.join(root, "auth.json"));
  return value && stringValue(value.apiKey)
    ? observation("ready", "official-command-code-cli", "official-cli-session", checkedAt, null, "Official Command Code session is present.")
    : observation("unavailable", "official-command-code-cli", "official-cli-session", checkedAt, null, "Run `command-code login` in an interactive terminal.");
}

async function protectedJson(file: string): Promise<Record<string, unknown> | null> {
  try {
    const info = await lstat(file);
    if (!info.isFile() || info.isSymbolicLink()) return null;
    if (process.platform !== "win32" && (info.mode & (constants.S_IRWXG | constants.S_IRWXO)) !== 0) return null;
    const parsed: unknown = JSON.parse(await readFile(file, "utf8"));
    return isRecord(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

function observation(
  state: EvidenceState,
  source: string | null,
  reference: string | null,
  checkedAt: string,
  expiresAt: string | null,
  message: string
): AuthenticationObservation {
  return { state, source, reference, checkedAt, expiresAt, message };
}

function environmentVariable(reference: string): string | null {
  return /^env:[A-Z][A-Z0-9_]*$/.test(reference) ? reference.slice(4) : null;
}

function epochSeconds(value: unknown): number | null {
  const seconds = Number(value);
  return Number.isFinite(seconds) && seconds > 0 ? seconds * 1000 : null;
}

function stringValue(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value : null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function sanitizeCliMessage(value: string): string {
  return value
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line && !/(token|key|authorization)\s*[:=]/i.test(line))
    .slice(-2)
    .join(" ")
    .slice(0, 500);
}

function safeExecFailure(error: unknown, fallback: string): string {
  if (!isRecord(error)) return fallback;
  return sanitizeCliMessage(typeof error.stderr === "string" ? error.stderr : "") || fallback;
}
