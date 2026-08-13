import { chmod, mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { commandFailure, systemCommandRunner, type CommandRunner } from "./command.js";

export const MCP_SERVER_NAME = "codex-router";
const MCP_OWNER = "@rizkiye/codex-router";

export interface McpExpectedConfiguration {
  readonly command: string;
  readonly args: readonly string[];
  readonly env: Readonly<Record<string, string>>;
}

export interface McpActualConfiguration extends McpExpectedConfiguration {
  readonly type: "stdio";
}

export interface McpInspection {
  readonly state: "absent" | "owned" | "foreign" | "drifted" | "unavailable";
  readonly message: string;
  readonly expected: McpExpectedConfiguration;
  readonly actual: McpActualConfiguration | null;
}

export interface McpInstallationSnapshot {
  readonly actual: McpActualConfiguration | null;
  readonly ownershipManifest: Uint8Array | null;
}

interface McpOwnershipManifest {
  readonly owner: typeof MCP_OWNER;
  readonly version: 1;
  readonly name: typeof MCP_SERVER_NAME;
  readonly expected: McpExpectedConfiguration;
  readonly adoptedForeign: boolean;
  readonly installedAt: string;
}

interface CodexMcpJson {
  readonly name?: unknown;
  readonly transport?: {
    readonly type?: unknown;
    readonly command?: unknown;
    readonly args?: unknown;
    readonly env?: unknown;
  };
}

export class McpInstallationManager {
  constructor(
    private readonly manifestFile: string,
    private readonly runner: CommandRunner = systemCommandRunner,
    private readonly codexCommand = "codex"
  ) {}

  expected(configPath: string): McpExpectedConfiguration {
    return {
      command: "codex-router",
      args: ["mcp"],
      env: { CODEX_ROUTER_CONFIG: path.resolve(configPath) }
    };
  }

  async inspect(configPath: string): Promise<McpInspection> {
    const expected = this.expected(configPath);
    const ownership = await readOwnership(this.manifestFile);
    let actual: McpActualConfiguration | null;
    try {
      actual = await this.readActual();
    } catch (error) {
      return {
        state: "unavailable",
        message: `Codex MCP readback is unavailable: ${error instanceof Error ? error.message : String(error)}`,
        expected,
        actual: null
      };
    }
    if (!actual) {
      return {
        state: ownership ? "drifted" : "absent",
        message: ownership
          ? "The owned Codex MCP entry is missing. Run setup to repair it."
          : "Codex has no codex-router MCP entry.",
        expected,
        actual: null
      };
    }
    if (!ownership) {
      return {
        state: "foreign",
        message: "A codex-router MCP entry already exists but is not owned by this installation.",
        expected,
        actual
      };
    }
    if (!sameConfiguration(actual, ownership.expected) || !sameConfiguration(actual, expected)) {
      return {
        state: "drifted",
        message: "The Codex MCP entry no longer matches the router-owned manifest; it was left unchanged.",
        expected,
        actual
      };
    }
    return { state: "owned", message: "Codex readback matches the router-owned MCP entry.", expected, actual };
  }

  async snapshot(): Promise<McpInstallationSnapshot> {
    return {
      actual: await this.readActual(),
      ownershipManifest: await readOptional(this.manifestFile)
    };
  }

  async restore(snapshot: McpInstallationSnapshot): Promise<void> {
    const current = await this.readActual();
    if (current && (!snapshot.actual || !sameConfiguration(current, snapshot.actual))) {
      await this.removeActual();
    }
    if (snapshot.actual && (!current || !sameConfiguration(current, snapshot.actual))) {
      await this.addActual(snapshot.actual);
    }
    const readback = await this.readActual();
    if (snapshot.actual ? !readback || !sameConfiguration(readback, snapshot.actual) : readback) {
      throw new Error("Codex MCP rollback readback did not match the pre-setup snapshot.");
    }
    if (snapshot.ownershipManifest) await writeOwnershipBytes(this.manifestFile, snapshot.ownershipManifest);
    else await rm(this.manifestFile, { force: true });
  }

  async install(configPath: string, options: { adoptForeign?: boolean } = {}): Promise<McpInspection> {
    const expected = this.expected(configPath);
    const before = await this.inspect(configPath);
    if (before.state === "owned") return before;
    if (before.state === "unavailable") throw new Error(before.message);
    if (before.state === "drifted" && before.actual) throw new Error(before.message);
    if (before.state === "foreign" && !options.adoptForeign) {
      throw new Error(`${before.message} Re-run with --adopt-mcp only if replacing that entry is intentional.`);
    }
    const prior = before.actual;
    if (prior) await this.removeActual();
    let added = false;
    try {
      await this.addActual(expected);
      added = true;
      const readback = await this.readActual();
      if (!readback || !sameConfiguration(readback, expected)) {
        throw new Error("Codex MCP readback did not match the requested codex-router command and environment.");
      }
      await writeOwnership(this.manifestFile, {
        owner: MCP_OWNER,
        version: 1,
        name: MCP_SERVER_NAME,
        expected,
        adoptedForeign: Boolean(prior),
        installedAt: new Date().toISOString()
      });
      return this.inspect(configPath);
    } catch (error) {
      if (added) await this.removeActual().catch(() => undefined);
      if (prior) await this.addActual(prior).catch(() => undefined);
      throw error;
    }
  }

  async uninstall(configPath: string): Promise<{ removed: boolean; message: string }> {
    const inspection = await this.inspect(configPath);
    if (inspection.state === "absent") {
      await rm(this.manifestFile, { force: true });
      return { removed: false, message: "No Codex MCP entry was present." };
    }
    if (inspection.state !== "owned") {
      return { removed: false, message: `${inspection.message} Nothing was removed.` };
    }
    await this.removeActual();
    if (await this.readActual()) throw new Error("Codex still reports the codex-router MCP entry after removal.");
    await rm(this.manifestFile, { force: true });
    return { removed: true, message: "Removed the router-owned Codex MCP entry after exact readback." };
  }

  private async readActual(): Promise<McpActualConfiguration | null> {
    const result = await this.runner.run(this.codexCommand, ["mcp", "get", MCP_SERVER_NAME, "--json"]);
    if (result.code !== 0) {
      if (/No MCP server named/i.test(`${result.stderr}\n${result.stdout}`)) return null;
      throw commandFailure(this.codexCommand, ["mcp", "get", MCP_SERVER_NAME, "--json"], result);
    }
    let parsed: CodexMcpJson;
    try {
      parsed = JSON.parse(result.stdout) as CodexMcpJson;
    } catch {
      throw new Error("Codex returned invalid JSON while reading the codex-router MCP entry.");
    }
    const transport = parsed.transport;
    if (parsed.name !== MCP_SERVER_NAME || transport?.type !== "stdio" || typeof transport.command !== "string") {
      throw new Error("Codex returned an unsupported codex-router MCP transport.");
    }
    const args = Array.isArray(transport.args) && transport.args.every((value) => typeof value === "string")
      ? transport.args
      : [];
    const env = isStringRecord(transport.env) ? transport.env : {};
    return { type: "stdio", command: transport.command, args, env };
  }

  private async addActual(configuration: McpExpectedConfiguration): Promise<void> {
    const envArgs = Object.entries(configuration.env).sort(([left], [right]) => left.localeCompare(right)).flatMap(([key, value]) => ["--env", `${key}=${value}`]);
    const args = ["mcp", "add", MCP_SERVER_NAME, ...envArgs, "--", configuration.command, ...configuration.args];
    const result = await this.runner.run(this.codexCommand, args);
    if (result.code !== 0) throw commandFailure(this.codexCommand, args, result);
  }

  private async removeActual(): Promise<void> {
    const args = ["mcp", "remove", MCP_SERVER_NAME];
    const result = await this.runner.run(this.codexCommand, args);
    if (result.code !== 0 && !/No MCP server named/i.test(`${result.stderr}\n${result.stdout}`)) {
      throw commandFailure(this.codexCommand, args, result);
    }
  }
}

function sameConfiguration(actual: McpExpectedConfiguration, expected: McpExpectedConfiguration): boolean {
  return actual.command === expected.command
    && JSON.stringify(actual.args) === JSON.stringify(expected.args)
    && JSON.stringify(sortedRecord(actual.env)) === JSON.stringify(sortedRecord(expected.env));
}

function sortedRecord(value: Readonly<Record<string, string>>): Record<string, string> {
  return Object.fromEntries(Object.entries(value).sort(([left], [right]) => left.localeCompare(right)));
}

function isStringRecord(value: unknown): value is Record<string, string> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    && Object.values(value).every((entry) => typeof entry === "string");
}

async function readOwnership(file: string): Promise<McpOwnershipManifest | null> {
  try {
    const parsed = JSON.parse(await readFile(file, "utf8")) as Partial<McpOwnershipManifest>;
    return parsed.owner === MCP_OWNER && parsed.version === 1 && parsed.name === MCP_SERVER_NAME && parsed.expected
      ? parsed as McpOwnershipManifest
      : null;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
}

async function writeOwnership(file: string, manifest: McpOwnershipManifest): Promise<void> {
  await writeOwnershipBytes(file, `${JSON.stringify(manifest, null, 2)}\n`);
}

async function writeOwnershipBytes(file: string, contents: string | Uint8Array): Promise<void> {
  await mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
  const temporary = `${file}.${process.pid}.tmp`;
  await writeFile(temporary, contents, { mode: 0o600 });
  await chmod(temporary, 0o600);
  await rename(temporary, file);
}

async function readOptional(file: string): Promise<Uint8Array | null> {
  return readFile(file).catch((error: NodeJS.ErrnoException) => error.code === "ENOENT" ? null : Promise.reject(error));
}
