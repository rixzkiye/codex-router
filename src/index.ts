#!/usr/bin/env node
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { loadConfig } from "./config.js";
import { createMcpServer } from "./mcp.js";
import { CodexRouter } from "./router.js";
import { createJsonLogger, SecretRedactor } from "./security.js";

async function main(): Promise<void> {
  const configPath = parseConfigPath(process.argv.slice(2));
  const redactor = new SecretRedactor();
  const logger = createJsonLogger(redactor);
  const config = await loadConfig(configPath);
  const router = await CodexRouter.create(config, { logger, redactor });
  const server = createMcpServer(router, redactor);
  const shutdown = async () => {
    await server.close().catch(() => undefined);
    await router.close();
  };
  process.once("SIGINT", () => void shutdown().finally(() => process.exit(0)));
  process.once("SIGTERM", () => void shutdown().finally(() => process.exit(0)));
  process.once("beforeExit", () => void router.close());
  await server.connect(new StdioServerTransport());
  logger.info({ config_path: configPath }, "Codex Router MCP server started");
}

function parseConfigPath(args: string[]): string {
  const index = args.indexOf("--config");
  const explicit = index >= 0 ? args[index + 1] : undefined;
  if (explicit) return explicit;
  return process.env.CODEX_ROUTER_CONFIG ?? "codex-router.config.json";
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
