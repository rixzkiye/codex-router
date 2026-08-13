import { randomBytes } from "node:crypto";
import { spawn } from "node:child_process";
import { constants } from "node:fs";
import { chmod, lstat, mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";

const REFERENCE = /^env:([A-Z][A-Z0-9_]*)$/;

export interface CredentialStore {
  /** Opens an operating-system prompt. The browser never supplies a secret value. */
  promptAndStore(reference: string, label: string, signal?: AbortSignal): Promise<{ reference: string; source: "protected-router-store" }>;
}

export class ProtectedCredentialStore implements CredentialStore {
  constructor(readonly file: string) {}

  async hydrate(environment: NodeJS.ProcessEnv = process.env): Promise<string[]> {
    const values = await this.#read();
    for (const [name, value] of Object.entries(values)) environment[name] = value;
    return Object.keys(values).map((name) => `env:${name}`);
  }

  async ensureGenerated(reference: string, environment: NodeJS.ProcessEnv = process.env): Promise<void> {
    const name = environmentName(reference);
    if (environment[name]) return;
    const values = await this.#read();
    if (values[name]) {
      environment[name] = values[name];
      return;
    }
    const value = randomBytes(32).toString("base64url");
    values[name] = value;
    await this.#write(values);
    environment[name] = value;
  }

  async promptAndStore(reference: string, label: string, signal?: AbortSignal): Promise<{ reference: string; source: "protected-router-store" }> {
    const name = environmentName(reference);
    signal?.throwIfAborted();
    const value = await nativeSecretPrompt(label, signal);
    if (!value || /[\u0000\r\n]/.test(value)) throw new Error("The secure prompt returned an invalid credential.");
    const values = await this.#read();
    values[name] = value;
    await this.#write(values);
    process.env[name] = value;
    return { reference, source: "protected-router-store" };
  }

  async #read(): Promise<Record<string, string>> {
    try {
      const info = await lstat(this.file);
      if (!info.isFile() || info.isSymbolicLink()) throw new Error("Protected credential store is not a regular file.");
      if (process.platform !== "win32" && (info.mode & (constants.S_IRWXG | constants.S_IRWXO)) !== 0) {
        throw new Error("Protected credential store has group or world permissions.");
      }
      const parsed: unknown = JSON.parse(await readFile(this.file, "utf8"));
      if (!isCredentialMap(parsed)) throw new Error("Protected credential store has an invalid shape.");
      return { ...parsed };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return {};
      throw error;
    }
  }

  async #write(values: Record<string, string>): Promise<void> {
    const directory = path.dirname(this.file);
    const existingDirectory = await lstat(directory).catch((error: NodeJS.ErrnoException) => error.code === "ENOENT" ? null : Promise.reject(error));
    if (existingDirectory && (!existingDirectory.isDirectory() || existingDirectory.isSymbolicLink())) {
      throw new Error("Protected credential directory is not a regular directory.");
    }
    await mkdir(directory, { recursive: true, mode: 0o700 });
    await chmod(directory, 0o700);
    const temporary = `${this.file}.${randomBytes(16).toString("hex")}.tmp`;
    await writeFile(temporary, `${JSON.stringify(values)}\n`, { encoding: "utf8", mode: 0o600, flag: "wx" });
    await chmod(temporary, 0o600);
    await rename(temporary, this.file);
  }
}

function environmentName(reference: string): string {
  const match = REFERENCE.exec(reference);
  if (!match) throw new Error("Protected credential storage accepts env:VARIABLE references only.");
  return match[1]!;
}

async function nativeSecretPrompt(label: string, signal?: AbortSignal): Promise<string> {
  if (process.platform === "linux") {
    return prompt("systemd-ask-password", ["--user", "--no-tty", "--echo=masked", "--timeout=300", "--id=codex-router", `Enter API key for ${label}`], signal);
  }
  if (process.platform === "darwin") {
    return prompt("osascript", ["-e", `text returned of (display dialog ${JSON.stringify(`Enter API key for ${label}`)} default answer \"\" with hidden answer buttons {\"Cancel\", \"Store\"} default button \"Store\")`], signal);
  }
  if (process.platform === "win32") {
    const script = [
      `$credential = Get-Credential -Message ${JSON.stringify(`Enter API key for ${label}`)}`,
      "if ($null -eq $credential) { exit 1 }",
      "$pointer = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($credential.Password)",
      "try { [Console]::Out.Write([Runtime.InteropServices.Marshal]::PtrToStringBSTR($pointer)) } finally { [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($pointer) }"
    ].join("; ");
    return prompt("powershell.exe", ["-NoProfile", "-Command", script], signal);
  }
  throw new Error("Native secure credential prompts are unavailable on this host.");
}

function prompt(command: string, args: string[], signal?: AbortSignal): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: ["ignore", "pipe", "pipe"], windowsHide: true, signal });
    const stdout: Buffer[] = [];
    child.stdout.on("data", (chunk: Buffer) => stdout.push(chunk));
    child.once("error", reject);
    child.once("close", (code) => {
      if (code !== 0) return reject(new Error("The native credential prompt was cancelled or unavailable."));
      resolve(Buffer.concat(stdout).toString("utf8").replace(/\r?\n$/, ""));
    });
  });
}

function isCredentialMap(value: unknown): value is Record<string, string> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    && Object.entries(value).every(([name, secret]) => REFERENCE.test(`env:${name}`) && typeof secret === "string" && secret.length > 0 && !/[\u0000\r\n]/.test(secret));
}
