import { EventEmitter } from "node:events";
import { execFile } from "node:child_process";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { RouterApplicationService } from "../../src/application.js";
import type { RouterConfig } from "../../src/config.js";
import type { AgentRespondRequest, NormalizedRuntimeEvent, RuntimeState } from "../../src/domain.js";
import { CodexRouter } from "../../src/router.js";
import type {
  BackgroundTerminalInventory,
  ContinueTurnContext,
  ReconciliationResult,
  RuntimeAdapter,
  RuntimeCapabilities,
  RuntimeEventHandler,
  RuntimeTaskContext,
  StartTurnResult
} from "../../src/runtime/types.js";
import { createJsonLogger, SecretRedactor } from "../../src/security.js";
import { startWebGateway } from "../../src/web/server.js";
import type { ManagedSetup } from "../../src/platform/setup.js";

const execFileAsync = promisify(execFile);
let worktree = "";

async function main() {
const root = await mkdtemp(path.join(tmpdir(), "codex-router-console-fixture-"));
worktree = path.join(root, "codex-router");
await execFileAsync("mkdir", ["-p", worktree]);
await execFileAsync("git", ["-C", worktree, "init", "-b", "main"]);
await execFileAsync("git", ["-C", worktree, "config", "user.email", "fixture@example.invalid"]);
await execFileAsync("git", ["-C", worktree, "config", "user.name", "Console Fixture"]);
await writeFile(path.join(worktree, "README.md"), "console fixture\n", "utf8");
await execFileAsync("git", ["-C", worktree, "add", "README.md"]);
await execFileAsync("git", ["-C", worktree, "commit", "-m", "fixture"]);

const redactor = new SecretRedactor();
const logger = createJsonLogger(redactor);
const primary = new FixtureRuntime("sol-main");
const review = new FixtureRuntime("terra-review");
const config: RouterConfig = {
  databasePath: path.join(root, "router.sqlite"),
  allowedWorktreeRoots: [root],
  maxWaitMs: 30_000,
  leaseTtlMs: 120_000,
  idempotencyTtlMs: 86_400_000,
  runtimes: [runtimeConfig("sol-main", "gpt-5.6-sol", 3), runtimeConfig("terra-review", "gpt-5.6-terra", 2)]
};
const router = await CodexRouter.create(config, { logger, redactor, adapters: new Map([[primary.id, primary], [review.id, review]]) });
const app = new RouterApplicationService(router, redactor);
const managementStatus = {
  configured: true,
  background: true,
  startAtLogin: true,
  service: { state: "running", installed: true, running: true, startAtLogin: true, message: "The current-user Codex Router service is running." },
  mcp: { state: "owned", message: "Codex readback matches the router-owned MCP entry." },
  url: "http://127.0.0.1:4178",
  paths: {
    configRoot: path.join(root, "config"), configFile: path.join(root, "config", "config.json"),
    stateRoot: root, databaseFile: config.databasePath, manifestFile: path.join(root, "setup-manifest.json"),
    mcpManifestFile: path.join(root, "mcp-manifest.json"), controlTokenFile: path.join(root, "control-token"),
    serviceFile: path.join(root, "codex-router.service"), logFile: path.join(root, "logs", "router.log")
  }
} as const;
const management = {
  status: async () => managementStatus,
  setBackground: async () => managementStatus,
  restart: async () => undefined,
  stop: async () => undefined
} as unknown as ManagedSetup;

const running = await app.start("fixture", startRequest("running", "Implement the resilient web transport", "write", "sol-main"));
const attention = await app.start("fixture", startRequest("attention", "Review the protected branch delivery policy", "read_only", "terra-review"));
await review.requestApproval(attention.agentId, "gh pr merge --match-head-commit 8e31f9a");
const completed = await app.start("fixture", startRequest("completed", "Verify result evidence remains independently observed", "read_only", "sol-main"));
await primary.emitFor(completed.agentId, "semantic_output", { text: "Implementation complete with observed checks." });
await primary.emitFor(completed.agentId, "command_started", { command: "pnpm verify" });
await primary.emitFor(completed.agentId, "command_completed", { command: "pnpm verify", exitCode: 0, output: "All checks passed" });
await primary.emitFor(completed.agentId, "file_change", { path: "src/web/server.ts" });
await primary.emitFor(completed.agentId, "turn_completed", {
  status: "completed",
  terminalReason: "completed",
  reported: {
    summary: "Implemented the gateway and verified the complete local gate.",
    decisions: ["Kept MCP and Web over one application service"],
    invariants: ["Cancellation remains event-confirmed"],
    risks: [],
    pending: []
  }
});
await app.start("fixture", startRequest("queued", "Prepare an isolated documentation audit", "read_only", "terra-review"));
router.registry.updateRuntimeHealth("terra-review", {
  state: "limited",
  quota: {
    primary: { usedPercent: 100, windowDurationMinutes: 300, resetsAt: Math.floor(Date.now() / 1000) + 1_500 },
    secondary: { usedPercent: 76, windowDurationMinutes: 10_080 },
    snapshotVersion: 4,
    updatedAt: new Date().toISOString()
  }
});

const gateway = await startWebGateway(app, redactor, logger, {
  host: "127.0.0.1",
  port: Number(process.env.CODEX_ROUTER_FIXTURE_PORT ?? 4178),
  assetRoot: path.resolve("dist/console"),
  bootstrapToken: "fixture-console",
  management
});
process.stdout.write(`${gateway.bootstrapUrl}\n`);

const shutdown = async () => {
  await gateway.close();
  await router.close();
};
process.once("SIGINT", () => void shutdown().finally(() => process.exit(0)));
process.once("SIGTERM", () => void shutdown().finally(() => process.exit(0)));
}

function runtimeConfig(id: string, model: string, maxConcurrency: number): RouterConfig["runtimes"][number] {
  return {
    id,
    adapter: "codex_app_server",
    provider: "openai",
    capabilityTiers: ["architect", "principal", "senior", "worker"],
    allowedModels: [model],
    maxConcurrency,
    policyTags: ["project:codex-router", "local"],
    enabled: true,
    codexHomeRef: `env:CODEX_ROUTER_${id.toUpperCase().replaceAll("-", "_")}_HOME`,
    command: "fixture",
    args: [],
    protocolVersion: "fixture",
    defaultModel: model,
    approvalPolicy: "on-request",
    networkAccess: false
  };
}

function startRequest(key: string, task: string, mode: "write" | "read_only", runtimeId: string) {
  return {
    idempotencyKey: `fixture-${key}`,
    task,
    projectKey: "codex-router",
    worktree: { path: worktree, mode },
    routing: { capabilityTier: "senior" as const, preferredRuntimeId: runtimeId },
    authority: { allowPush: false, allowMerge: false, allowDeploy: false, allowExternalWrites: false },
    recoveryPolicy: "manual" as const,
    labels: { surface: "console" }
  };
}

interface Binding {
  agentId: string;
  incarnationId: string;
  threadId: string;
  turnId: string;
}

class FixtureRuntime implements RuntimeAdapter {
  readonly capabilities: RuntimeCapabilities = { steer: true, interrupt: true, resume: true, approvals: true, readOnlySandbox: true, writeSandbox: true };
  state: RuntimeState = "offline";
  #events = new EventEmitter();
  #bindings = new Map<string, Binding>();
  #counter = 0;

  constructor(readonly id: string) {}
  async connect() { this.state = "ready" as const; }
  async close() { this.state = "offline" as const; }
  onEvent(handler: RuntimeEventHandler) { this.#events.on("event", handler); return () => this.#events.off("event", handler); }
  async startTask(context: RuntimeTaskContext) { return this.#start(context.agentId, context.incarnationId); }
  async continueTurn(context: ContinueTurnContext) { return this.#start(context.agentId, context.incarnationId, context.threadId); }
  async steer() {}
  async interrupt(threadId: string) {
    const binding = this.#bindings.get(threadId);
    if (binding) await this.emitFor(binding.agentId, "turn_completed", { status: "interrupted", terminalReason: "cancelled" });
  }
  async respond(_backendRequestId: string | number, _method: string, _response: AgentRespondRequest["response"]) {}
  bindContext(agentId: string, incarnationId: string, threadId: string, turnId: string | null) { if (turnId) this.#bindings.set(threadId, { agentId, incarnationId, threadId, turnId }); }
  async findThreadByCorrelation() { return null; }
  async reconcile(threadId: string, knownTurnId: string | null): Promise<ReconciliationResult> { return { state: "active", threadId, turnId: knownTurnId, evidence: { fixture: true } }; }
  async inspectBackgroundTerminals(): Promise<BackgroundTerminalInventory> { return { clean: true, terminals: [], inspectedAt: new Date().toISOString() }; }

  async requestApproval(agentId: string, command: string) {
    await this.emitFor(agentId, "pending_interaction", {
      backendRequestId: `approval-${Date.now()}`,
      method: "item/commandExecution/requestApproval",
      kind: "approval",
      params: { command, reason: "Protected operation requires one explicit decision." }
    });
  }

  async emitFor(agentId: string, type: NormalizedRuntimeEvent["type"], payload: Record<string, unknown>) {
    const binding = [...this.#bindings.values()].find((entry) => entry.agentId === agentId);
    if (!binding) throw new Error(`No binding for ${agentId}`);
    await Promise.all(this.#events.listeners("event").map((listener) => Promise.resolve((listener as RuntimeEventHandler)({
      eventId: `fixture-event-${++this.#counter}`,
      runtimeId: this.id,
      agentId,
      incarnationId: binding.incarnationId,
      threadId: binding.threadId,
      turnId: binding.turnId,
      type,
      payload,
      occurredAt: new Date().toISOString()
    }))));
  }

  async #start(agentId: string, incarnationId: string, existingThread?: string): Promise<StartTurnResult> {
    const threadId = existingThread ?? `thread-${this.id}-${++this.#counter}`;
    const turnId = `turn-${this.id}-${++this.#counter}`;
    this.#bindings.set(threadId, { agentId, incarnationId, threadId, turnId });
    return { threadId, turnId, acceptedAt: new Date().toISOString() };
  }
}

await main();
