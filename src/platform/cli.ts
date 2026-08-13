import path from "node:path";
import type { RouterApplicationService } from "../application.js";
import { newId } from "../security.js";
import { installGeneratedArtifacts, writeSupportBundle } from "./files.js";

export async function runPlatformCli(args: string[], application: RouterApplicationService): Promise<void> {
  const command = args[0] ?? "status";
  const json = args.includes("--json");
  if (command === "status") {
    print(json ? application.router.platform.snapshot() : statusText(application));
    return;
  }
  if (command === "providers") {
    const providers = application.providers();
    print(json ? { providers } : providers.map((provider) => `${provider.enabled ? "ON " : "OFF"} ${provider.id.padEnd(24)} auth=${provider.authentication.state.padEnd(9)} health=${provider.health.state}`).join("\n"));
    return;
  }
  if (command === "models") {
    const models = application.modelsPlatform();
    print(json ? { models } : models.map((model) => `${model.enabled ? "SHOW" : "HIDE"} ${model.gatewayId.padEnd(32)} ${model.providerVariant}`).join("\n") || "No configured inference models.");
    return;
  }
  if (command === "doctor") {
    const checks = application.platformDiagnostics();
    print(json ? { checks } : checks.map((check) => `${check.state.toUpperCase().padEnd(7)} ${check.label}: ${check.message}`).join("\n"));
    if (checks.some((check) => check.state === "fail")) process.exitCode = 1;
    return;
  }
  if (command === "artifacts") {
    const output = requiredOption(args, "--output");
    const result = await installGeneratedArtifacts(output, application.router.platform.artifacts());
    print(json ? result : `Generated platform artifacts at ${result.root}; manifest readback passed.`);
    return;
  }
  if (command === "support-bundle") {
    const output = requiredOption(args, "--output");
    const result = await writeSupportBundle(output, {
      router: { version: "0.2.0", registryVersion: application.router.registry?.registryVersion ?? 0 },
      platform: application.router.platform.snapshot()
    });
    print(json ? result : `Sanitized support bundle created at ${result.path}. It was not uploaded.`);
    return;
  }
  if (command === "provider") {
    const providerId = args[1];
    const action = args[2];
    if (!providerId || !["validate", "enable", "disable"].includes(action ?? "")) usage();
    const provider = application.provider(providerId!);
    const input = { idempotencyKey: newId("cli"), expectedVersion: provider.version };
    const operation = action === "validate"
      ? application.validateProvider("cli:platform", providerId!, input)
      : application.setProviderEnabled("cli:platform", providerId!, action === "enable", input);
    print(json ? operation : `${operation.state.toUpperCase()} ${operation.kind}: ${operation.message}`);
    return;
  }
  if (command === "model") {
    const modelId = args[1];
    const action = args[2];
    if (!modelId || !["enable", "disable"].includes(action ?? "")) usage();
    const model = application.modelPlatform(modelId!);
    const operation = application.setModelEnabled("cli:platform", modelId!, action === "enable", {
      idempotencyKey: newId("cli"), expectedVersion: model.version
    });
    print(json ? operation : `${operation.state.toUpperCase()} ${operation.kind}: ${operation.message}`);
    return;
  }
  usage();
}

function statusText(application: RouterApplicationService): string {
  const snapshot = application.router.platform.snapshot();
  return [
    `Registry ${snapshot.registry.hash.slice(0, 12)}: ${snapshot.registry.providerCount} providers, ${snapshot.registry.modelCount} models`,
    `Enabled providers: ${snapshot.summary.enabledProviders}; listed models: ${snapshot.summary.listedModels}`,
    `Requests (24h): ${snapshot.summary.requests24h}; operations in flight: ${snapshot.summary.operationsInFlight}`,
    `Diagnostics attention: ${snapshot.summary.diagnosticsAttention}`
  ].join("\n");
}

function requiredOption(args: string[], name: string): string {
  const index = args.indexOf(name);
  const value = index >= 0 ? args[index + 1] : undefined;
  if (!value || path.resolve(value) === path.parse(path.resolve(value)).root) {
    throw new Error(`${name} requires a non-root path`);
  }
  return value;
}

function print(value: unknown): void {
  process.stdout.write(`${typeof value === "string" ? value : JSON.stringify(value, null, 2)}\n`);
}

function usage(): never {
  throw new Error("Usage: codex-router platform <status|providers|models|doctor|artifacts|support-bundle|provider|model> [options]");
}
