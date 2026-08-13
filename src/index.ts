#!/usr/bin/env node
import { spawn } from "node:child_process";
import path from "node:path";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { RouterApplicationService } from "./application.js";
import { loadConfig } from "./config.js";
import { startInferenceGateway } from "./inference/server.js";
import { createMcpServer } from "./mcp.js";
import { CodexRouter } from "./router.js";
import { createJsonLogger, SecretRedactor } from "./security.js";
import { startWebGateway } from "./web/server.js";
import { RouterDatabase } from "./store/database.js";
import { Registry } from "./store/registry.js";
import { PlatformService } from "./platform/service.js";
import { runPlatformCli } from "./platform/cli.js";

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const configPath = parseConfigPath(args);
  const redactor = new SecretRedactor();
  const logger = createJsonLogger(redactor);
  const config = await loadConfig(configPath);
  if (args[0] === "platform") {
    const database = new RouterDatabase(config.databasePath);
    const registry = new Registry(database);
    const platform = new PlatformService(database.connection, registry, config.inference);
    const platformRouter = { platform } as unknown as CodexRouter;
    const application = new RouterApplicationService(platformRouter, redactor);
    try {
      await runPlatformCli(args.slice(1).filter((arg) => arg !== "--config" && arg !== configPath), application);
    } finally {
      await platform.close();
      database.close();
    }
    return;
  }
  if (args[0] === "inference") {
    if (!config.inference) {
      throw new Error("Inference gateway configuration is missing");
    }
    const host = option(args, "--host");
    const port = numericOption(args, "--port");
    const database = new RouterDatabase(config.databasePath);
    const registry = new Registry(database);
    const platform = new PlatformService(database.connection, registry, config.inference);
    const gateway = await startInferenceGateway(config.inference, redactor, logger, {
      ...(host ? { host } : {}),
      ...(port === undefined ? {} : { port }),
      platform
    });
    let closing = false;
    const shutdown = async () => {
      if (closing) return;
      closing = true;
      await gateway.close();
      await platform.close();
      database.close();
    };
    process.once("SIGINT", () => void shutdown().finally(() => process.exit(0)));
    process.once("SIGTERM", () => void shutdown().finally(() => process.exit(0)));
    process.stdout.write(`Codex Router Inference: ${gateway.url}/v1\n`);
    logger.info({ config_path: configPath, url: gateway.url }, "Codex Router inference gateway started");
    return;
  }
  const router = await CodexRouter.create(config, { logger, redactor });
  const application = new RouterApplicationService(router, redactor);
  const webMode = args[0] === "web";
  const server = webMode ? null : createMcpServer(application, redactor);
  const gateway = webMode
    ? await startWebGateway(application, redactor, logger, {
        host: option(args, "--host") ?? "127.0.0.1",
        port: numericOption(args, "--port") ?? 4178,
        assetRoot: option(args, "--assets") ?? path.join(import.meta.dirname, "console")
      })
    : null;
  const shutdown = async () => {
    await server?.close().catch(() => undefined);
    await gateway?.close().catch(() => undefined);
    await router.close();
  };
  process.once("SIGINT", () => void shutdown().finally(() => process.exit(0)));
  process.once("SIGTERM", () => void shutdown().finally(() => process.exit(0)));
  process.once("beforeExit", () => void router.close());
  if (gateway) {
    process.stdout.write(`Codex Router Console: ${gateway.bootstrapUrl}\n`);
    if (args.includes("--open")) openExternal(gateway.bootstrapUrl);
    logger.info({ config_path: configPath, url: gateway.url }, "Codex Router Web Console started");
    return;
  }
  await server!.connect(new StdioServerTransport());
  logger.info({ config_path: configPath }, "Codex Router MCP server started");
}

function parseConfigPath(args: string[]): string {
  const explicit = option(args, "--config");
  if (explicit) return explicit;
  return process.env.CODEX_ROUTER_CONFIG ?? "codex-router.config.json";
}

function option(args: string[], name: string): string | undefined {
  const index = args.indexOf(name);
  return index >= 0 ? args[index + 1] : undefined;
}

function numericOption(args: string[], name: string): number | undefined {
  const value = option(args, name);
  if (!value) return undefined;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 0 || parsed > 65_535) {
    throw new Error(`${name} must be an integer between 0 and 65535`);
  }
  return parsed;
}

function openExternal(url: string): void {
  const command = process.platform === "darwin" ? "open" : process.platform === "win32" ? "cmd" : "xdg-open";
  const args = process.platform === "win32" ? ["/c", "start", "", url] : [url];
  const child = spawn(command, args, { detached: true, stdio: "ignore" });
  child.unref();
}

main().catch((error) => {
  process.stderr.write(
    `${JSON.stringify({
      level: "fatal",
      time: new Date().toISOString(),
      message: error instanceof Error ? error.message : String(error)
    })}\n`
  );
  process.exitCode = 1;
});
