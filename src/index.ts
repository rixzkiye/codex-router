#!/usr/bin/env node
import { createWriteStream } from "node:fs";
import { mkdir, readFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { RouterApplicationService } from "./application.js";
import { runRouterCli } from "./cli.js";
import { loadConfig } from "./config.js";
import { startInferenceGateway } from "./inference/server.js";
import { createMcpServer } from "./mcp.js";
import { runPlatformCli } from "./platform/cli.js";
import { ManagedSetup } from "./platform/setup.js";
import { ProtectedCredentialStore } from "./platform/credentials.js";
import { CodexRouter } from "./router.js";
import { createJsonLogger, SecretRedactor, type Logger } from "./security.js";
import { RouterDatabase } from "./store/database.js";
import { Registry } from "./store/registry.js";
import { PlatformService } from "./platform/service.js";
import { startWebGateway } from "./web/server.js";

const packageMetadata = JSON.parse(await readFile(path.join(import.meta.dirname, "..", "package.json"), "utf8")) as { version: string };
const entryScript = path.resolve(process.argv[1] ?? path.join(import.meta.dirname, "index.js"));

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const setup = new ManagedSetup({ entryScript, packageVersion: packageMetadata.version });
  await runRouterCli(args, {
    setup,
    cwd: process.cwd(),
    home: os.homedir(),
    stdin: process.stdin,
    stdout: process.stdout,
    stderr: process.stderr,
    runMcp: (commandArgs) => runMcp(commandArgs, setup),
    runWeb: (commandArgs, open) => runWeb(commandArgs, setup, open),
    runInference: (commandArgs) => runInference(commandArgs, setup),
    runPlatform: (commandArgs) => runPlatform(commandArgs, setup)
  });
}

async function runMcp(args: string[], setup: ManagedSetup): Promise<void> {
  await new ProtectedCredentialStore(setup.paths.credentialsFile).hydrate();
  const configPath = await configPathFor(args, setup);
  const { router, application, logger } = await createApplication(configPath);
  const server = createMcpServer(application, logger.redactor);
  const shutdown = async () => {
    await server.close().catch(() => undefined);
    await router.close();
  };
  installSignals(shutdown);
  await server.connect(new StdioServerTransport());
  logger.value.info({ config_path: configPath }, "Codex Router MCP server started");
}

async function runWeb(args: string[], setup: ManagedSetup, open: boolean): Promise<void> {
  const configPath = await configPathFor(args, setup);
  const logFile = option(args, "--log-file");
  const credentials = new ProtectedCredentialStore(setup.paths.credentialsFile);
  await credentials.ensureGenerated("env:CODEX_ROUTER_INFERENCE_TOKEN");
  await credentials.hydrate();
  const { router, application, logger } = await createApplication(configPath, logFile, credentials);
  const controlTokenFile = option(args, "--control-token-file");
  const controlToken = controlTokenFile ? (await readFile(controlTokenFile, "utf8")).trim() : undefined;
  const gateway = await startWebGateway(application, logger.redactor, logger.value, {
    host: option(args, "--host") ?? "127.0.0.1",
    port: numericOption(args, "--port") ?? 4178,
    assetRoot: option(args, "--assets") ?? path.join(import.meta.dirname, "console"),
    ...(controlToken ? { controlToken, management: setup } : {})
  });
  const shutdown = async () => {
    await gateway.close().catch(() => undefined);
    await router.close();
    logger.close();
  };
  installSignals(shutdown);
  if (!controlToken) process.stdout.write(`Codex Router Console: ${gateway.bootstrapUrl}\n`);
  if (open || args.includes("--open")) openUrl(gateway.bootstrapUrl);
  logger.value.info({ config_path: configPath, url: gateway.url }, "Codex Router Web Console started");
}

async function runInference(args: string[], setup: ManagedSetup): Promise<void> {
  await new ProtectedCredentialStore(setup.paths.credentialsFile).hydrate();
  const configPath = await configPathFor(args, setup);
  const redactor = new SecretRedactor();
  const logger = createJsonLogger(redactor);
  const config = await loadConfig(configPath);
  const database = new RouterDatabase(config.databasePath);
  const registry = new Registry(database);
  const platform = new PlatformService(database.connection, registry, config.inference);
  const inference = platform.inferenceConfig();
  if (!inference) throw new Error("Inference gateway configuration is missing. Configure a provider and initial model in the Console first.");
  const gateway = await startInferenceGateway(inference, redactor, logger, {
    ...(option(args, "--host") ? { host: option(args, "--host")! } : {}),
    ...(numericOption(args, "--port") === undefined ? {} : { port: numericOption(args, "--port")! }),
    platform
  });
  const shutdown = async () => {
    await gateway.close();
    await platform.close();
    database.close();
  };
  installSignals(shutdown);
  process.stdout.write(`Codex Router Inference: ${gateway.url}/v1\n`);
  logger.info({ config_path: configPath, url: gateway.url }, "Codex Router inference gateway started");
}

async function runPlatform(args: string[], setup: ManagedSetup): Promise<void> {
  await new ProtectedCredentialStore(setup.paths.credentialsFile).hydrate();
  const targetUsesConfigFlag = ["install", "installation"].includes(args[0] ?? "")
    && ["plan", "apply"].includes(args[1] ?? "status");
  const routerConfigFlag = args.includes("--router-config")
    ? "--router-config"
    : targetUsesConfigFlag ? null : "--config";
  const configPath = await configPathFor(args, setup, routerConfigFlag);
  const redactor = new SecretRedactor();
  const config = await loadConfig(configPath);
  const database = new RouterDatabase(config.databasePath);
  const registry = new Registry(database);
  const platform = new PlatformService(database.connection, registry, config.inference);
  const platformRouter = { platform } as unknown as CodexRouter;
  const application = new RouterApplicationService(platformRouter, redactor);
  try {
    await runPlatformCli(routerConfigFlag ? stripOption(args, routerConfigFlag) : args, application);
  } finally {
    await platform.close();
    database.close();
  }
}

async function createApplication(configPath: string, logFile?: string, credentialStore?: ProtectedCredentialStore): Promise<{
  router: CodexRouter;
  application: RouterApplicationService;
  logger: { value: Logger; redactor: SecretRedactor; close(): void };
}> {
  const redactor = new SecretRedactor();
  let stream: ReturnType<typeof createWriteStream> | undefined;
  if (logFile) {
    await mkdir(path.dirname(path.resolve(logFile)), { recursive: true, mode: 0o700 });
    stream = createWriteStream(path.resolve(logFile), { flags: "a", mode: 0o600 });
  }
  const logger = createJsonLogger(redactor, stream ? (line) => stream!.write(line) : undefined);
  const config = await loadConfig(configPath);
  const router = await CodexRouter.create(config, { logger, redactor, ...(credentialStore ? { credentialStore } : {}) });
  return {
    router,
    application: new RouterApplicationService(router, redactor),
    logger: { value: logger, redactor, close: () => stream?.end() }
  };
}

async function configPathFor(args: string[], setup: ManagedSetup, explicitFlag: "--config" | "--router-config" | null = "--config"): Promise<string> {
  const explicit = explicitFlag ? option(args, explicitFlag) : undefined;
  if (explicit) return path.resolve(explicit);
  if (process.env.CODEX_ROUTER_CONFIG) return path.resolve(process.env.CODEX_ROUTER_CONFIG);
  const manifest = await setup.manifest();
  return manifest?.configPath ?? path.resolve("codex-router.config.json");
}

function option(args: string[], name: string): string | undefined {
  const index = args.indexOf(name);
  if (index < 0) return undefined;
  const value = args[index + 1];
  if (!value || value.startsWith("--")) throw new Error(`${name} requires a value.`);
  return value;
}

function stripOption(args: string[], name: string): string[] {
  const index = args.indexOf(name);
  return index < 0 ? args : [...args.slice(0, index), ...args.slice(index + 2)];
}

function numericOption(args: string[], name: string): number | undefined {
  const value = option(args, name);
  if (!value) return undefined;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 0 || parsed > 65_535) throw new Error(`${name} must be an integer between 0 and 65535`);
  return parsed;
}

function installSignals(shutdown: () => Promise<void>): void {
  let closing = false;
  const close = () => {
    if (closing) return;
    closing = true;
    void shutdown().finally(() => process.exit(0));
  };
  process.once("SIGINT", close);
  process.once("SIGTERM", close);
}

function openUrl(url: string): void {
  const command = process.platform === "darwin" ? "open" : process.platform === "win32" ? "cmd" : "xdg-open";
  const args = process.platform === "win32" ? ["/c", "start", "", url] : [url];
  import("node:child_process").then(({ spawn }) => {
    const child = spawn(command, args, { detached: true, stdio: "ignore" });
    child.once("error", () => undefined);
    child.unref();
  });
}

main().catch((error) => {
  process.stderr.write(`${JSON.stringify({ level: "fatal", time: new Date().toISOString(), message: error instanceof Error ? error.message : String(error) })}\n`);
  process.exitCode = 1;
});
