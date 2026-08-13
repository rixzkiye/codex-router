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
    if (!providerId || !["validate", "discover", "login", "logout", "enable", "disable"].includes(action ?? "")) usage();
    const provider = application.provider(providerId!);
    const input = { idempotencyKey: newId("cli"), expectedVersion: provider.version };
    const codexHome = option(args, "--codex-home");
    const started = action === "validate"
      ? application.validateProvider("cli:platform", providerId!, input)
      : action === "discover"
        ? application.refreshProviderCatalog("cli:platform", providerId!, input)
        : action === "login"
          ? application.loginProvider("cli:platform", providerId!, input, { inheritTerminal: true, ...(codexHome ? { codexHome } : {}) })
          : action === "logout"
            ? application.logoutProvider("cli:platform", providerId!, input, { inheritTerminal: true, ...(codexHome ? { codexHome } : {}) })
            : application.setProviderEnabled("cli:platform", providerId!, action === "enable", input);
    const operation = await settle(application, started);
    print(json ? operation : `${operation.state.toUpperCase()} ${operation.kind}: ${operation.message}`);
    if (operation.state === "failed" || operation.state === "cancelled") process.exitCode = 1;
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
  if (command === "local") {
    const action = args[1] ?? "list";
    if (action === "list") {
      const models = application.localModels();
      print(json ? { runtime: application.localRuntime(), models } : models.map((model) => `${model.selected ? "USE " : "    "}${model.state.padEnd(11)} ${model.id}`).join("\n") || "No local models discovered.");
      return;
    }
    if (action === "discover") {
      const runtime = application.localRuntime();
      const started = application.discoverLocalModels("cli:platform", { idempotencyKey: newId("cli"), expectedVersion: Number(runtime.version) });
      const operation = await settle(application, started);
      print(json ? operation : `${operation.state.toUpperCase()} ${operation.kind}: ${operation.message}`);
      if (operation.state !== "completed") process.exitCode = 1;
      return;
    }
    const modelId = args[2];
    if (!modelId || !["download", "benchmark", "select", "unselect", "remove"].includes(action)) usage();
    const model = application.localModels().find((entry) => entry.id === modelId);
    const expectedVersion = model?.version ?? 1;
    const input = { idempotencyKey: newId("cli"), expectedVersion };
    const started = action === "download"
      ? application.downloadLocalModel("cli:platform", modelId, { ...input, consent: args.includes("--yes") })
      : action === "benchmark"
        ? application.benchmarkLocalModel("cli:platform", modelId, input)
        : action === "select" || action === "unselect"
          ? application.setLocalModelSelected("cli:platform", modelId, action === "select", input)
          : application.removeLocalModel("cli:platform", modelId, { ...input, consent: args.includes("--yes") });
    const operation = await settle(application, started);
    print(json ? operation : `${operation.state.toUpperCase()} ${operation.kind}: ${operation.message}`);
    if (operation.state !== "completed") process.exitCode = 1;
    return;
  }
  if (command === "install" || command === "installation") {
    const action = args[1] ?? "status";
    if (action === "status") {
      const installation = application.installState();
      print(json ? { installation } : installation
        ? `Managed release ${String(installation.manifest.releaseVersion ?? "unknown")} is ${String(installation.manifest.state ?? "unknown")} (projection v${installation.version}).`
        : "No managed installation state has been recorded.");
      return;
    }
    const expectedVersion = application.installState()?.version ?? 1;
    const input = { idempotencyKey: newId("cli"), expectedVersion };
    let started;
    if (action === "plan" || action === "apply") {
      const host = option(args, "--host");
      if (host && !["linux", "darwin", "win32"].includes(host)) throw new Error("--host must be linux, darwin, or win32");
      const target = {
        root: requiredOption(args, "--root"),
        version: requiredValue(args, "--version"),
        releaseSource: requiredOption(args, "--release-source"),
        entrypoint: requiredValue(args, "--entrypoint"),
        configPath: requiredOption(args, "--config"),
        ...(host ? { host: host as NodeJS.Platform } : {})
      };
      started = action === "plan"
        ? application.planInstallation("cli:platform", target, input)
        : application.applyInstallation("cli:platform", target, { ...input, consent: args.includes("--yes") });
    } else {
      if (!["rollback", "disable", "uninstall"].includes(action)) usage();
      const manifestFile = requiredOption(args, "--manifest");
      const consent = args.includes("--yes");
      started = action === "rollback"
        ? application.rollbackInstallation("cli:platform", manifestFile, { ...input, consent })
        : action === "disable"
          ? application.disableInstallation("cli:platform", manifestFile, { ...input, consent })
          : application.uninstallInstallation("cli:platform", manifestFile, {
            ...input,
            consent,
            removeRetainedReleases: args.includes("--remove-retained-releases")
          });
    }
    const operation = await settle(application, started);
    print(json ? operation : `${operation.state.toUpperCase()} ${operation.kind}: ${operation.message}`);
    if (operation.state !== "completed") process.exitCode = 1;
    return;
  }
  if (command === "operations") {
    const operations = application.operations();
    print(json ? { operations } : operations.map((operation) => `${operation.state.toUpperCase().padEnd(10)} ${operation.kind.padEnd(26)} ${operation.targetId}`).join("\n") || "No platform operations.");
    return;
  }
  usage();
}

async function settle(application: RouterApplicationService, operation: ReturnType<RouterApplicationService["operation"]>) {
  return ["pending", "running"].includes(operation.state)
    ? application.waitForPlatformOperation(operation.id)
    : operation;
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

function option(args: string[], name: string): string | undefined {
  const index = args.indexOf(name);
  if (index < 0) return undefined;
  const value = args[index + 1];
  if (!value || value.startsWith("--")) throw new Error(`${name} requires a value`);
  return value;
}

function requiredValue(args: string[], name: string): string {
  const value = option(args, name);
  if (!value) throw new Error(`${name} requires a value`);
  return value;
}

function print(value: unknown): void {
  process.stdout.write(`${typeof value === "string" ? value : JSON.stringify(value, null, 2)}\n`);
}

function usage(): never {
  throw new Error("Usage: codex-router platform <status|providers|models|doctor|artifacts|support-bundle|provider|model|local|install|operations> [options]. Use --router-config <path> to select router state during install commands; --config is the managed target config.");
}
