import { EventEmitter } from "node:events";
import { execFile } from "node:child_process";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import type { RouterConfig } from "../src/config.js";
import type { AgentRespondRequest, NormalizedRuntimeEvent, RuntimeState } from "../src/domain.js";
import { newId, type Logger, SecretRedactor } from "../src/security.js";
import type {
  BackgroundTerminalInventory,
  ContinueTurnContext,
  ReconciliationResult,
  RuntimeAdapter,
  RuntimeCapabilities,
  RuntimeEventHandler,
  RuntimeTaskContext,
  StartTurnResult
} from "../src/runtime/types.js";

const execFileAsync = promisify(execFile);

export const silentLogger: Logger = {
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined
};

export async function createGitWorktree(): Promise<{ root: string; worktree: string }> {
  const root = await mkdtemp(path.join(tmpdir(), "codex-router-test-"));
  const worktree = path.join(root, "worktree");
  await execFileAsync("mkdir", ["-p", worktree]);
  await execFileAsync("git", ["-C", worktree, "init", "-b", "main"]);
  await execFileAsync("git", ["-C", worktree, "config", "user.email", "router-test@example.invalid"]);
  await execFileAsync("git", ["-C", worktree, "config", "user.name", "Router Test"]);
  await writeFile(path.join(worktree, "README.md"), "fixture\n", "utf8");
  await execFileAsync("git", ["-C", worktree, "add", "README.md"]);
  await execFileAsync("git", ["-C", worktree, "commit", "-m", "fixture"]);
  return { root, worktree };
}

export function testConfig(
  root: string,
  runtimeIds = ["runtime-a"]
): RouterConfig {
  return {
    databasePath: path.join(root, "router.sqlite"),
    allowedWorktreeRoots: [root],
    maxWaitMs: 2_000,
    leaseTtlMs: 60_000,
    idempotencyTtlMs: 60_000,
    runtimes: runtimeIds.map((id) => ({
      id,
      adapter: "codex_app_server" as const,
      provider: "openai",
      capabilityTiers: ["architect", "principal", "senior", "worker"],
      allowedModels: ["gpt-test"],
      maxConcurrency: 10,
      codexHomeRef: "env:CODEX_ROUTER_TEST_HOME",
      policyTags: ["authorized"],
      enabled: true,
      command: "unused",
      args: [],
      protocolVersion: "test",
      defaultModel: "gpt-test",
      approvalPolicy: "on-request" as const,
      networkAccess: false
    }))
  };
}

interface Binding {
  agentId: string;
  incarnationId: string;
  threadId: string;
  turnId: string;
}

export class MockRuntimeAdapter implements RuntimeAdapter {
  readonly capabilities: RuntimeCapabilities = {
    steer: true,
    interrupt: true,
    resume: true,
    approvals: true,
    readOnlySandbox: true,
    writeSandbox: true
  };
  state: RuntimeState = "offline";
  readonly starts: RuntimeTaskContext[] = [];
  readonly continuations: ContinueTurnContext[] = [];
  readonly steers: Array<{ threadId: string; turnId: string; input: string }> = [];
  readonly responses: AgentRespondRequest["response"][] = [];
  readonly bindings = new Map<string, Binding>();
  reconcileResult: ReconciliationResult | null = null;
  correlatedThreadId: string | null = null;
  terminalInventory: BackgroundTerminalInventory = {
    clean: true,
    terminals: [],
    inspectedAt: new Date().toISOString()
  };
  #counter = 0;
  #events = new EventEmitter();

  constructor(readonly id: string) {}

  async connect(): Promise<void> {
    this.state = "ready";
  }

  async close(): Promise<void> {
    this.state = "offline";
  }

  onEvent(handler: RuntimeEventHandler): () => void {
    this.#events.on("event", handler);
    return () => this.#events.off("event", handler);
  }

  async startTask(context: RuntimeTaskContext): Promise<StartTurnResult> {
    this.starts.push(context);
    return this.#start(context.agentId, context.incarnationId);
  }

  async continueTurn(context: ContinueTurnContext): Promise<StartTurnResult> {
    this.continuations.push(context);
    const turnId = `turn-${++this.#counter}`;
    const binding = { agentId: context.agentId, incarnationId: context.incarnationId, threadId: context.threadId, turnId };
    this.bindings.set(context.threadId, binding);
    const started = { threadId: context.threadId, turnId, acceptedAt: new Date().toISOString() };
    await this.emitFor(binding, "turn_started", { turnId });
    return started;
  }

  async steer(threadId: string, turnId: string, input: string): Promise<void> {
    this.steers.push({ threadId, turnId, input });
  }

  async interrupt(threadId: string, turnId: string): Promise<void> {
    const binding = this.bindings.get(threadId);
    if (binding) await this.emitFor(binding, "turn_completed", { status: "interrupted", terminalReason: "cancelled" });
  }

  async respond(
    _backendRequestId: string | number,
    _method: string,
    response: AgentRespondRequest["response"]
  ): Promise<void> {
    this.responses.push(response);
  }

  async reconcile(threadId: string, knownTurnId: string | null): Promise<ReconciliationResult> {
    return (
      this.reconcileResult ?? {
        state: "active",
        threadId,
        turnId: knownTurnId,
        evidence: { mock: true }
      }
    );
  }

  async findThreadByCorrelation(): Promise<string | null> {
    return this.correlatedThreadId;
  }

  bindContext(agentId: string, incarnationId: string, threadId: string, turnId: string | null): void {
    if (!turnId) return;
    this.bindings.set(threadId, { agentId, incarnationId, threadId, turnId });
  }

  async inspectBackgroundTerminals(): Promise<BackgroundTerminalInventory> {
    return this.terminalInventory;
  }

  async finish(threadId: string, status: "completed" | "failed" = "completed", summary = "done"): Promise<void> {
    const binding = this.bindings.get(threadId);
    if (!binding) throw new Error(`Unknown thread ${threadId}`);
    await this.emitFor(binding, "turn_completed", {
      status,
      terminalReason: status,
      reported: { summary }
    });
  }

  async command(threadId: string, command: string, exitCode: number): Promise<void> {
    const binding = this.bindings.get(threadId);
    if (!binding) throw new Error(`Unknown thread ${threadId}`);
    await this.emitFor(binding, "command_started", { command });
    await this.emitFor(binding, "command_completed", {
      command,
      exitCode,
      status: exitCode === 0 ? "completed" : "failed",
      output: "fixture output"
    });
  }

  async requestApproval(threadId: string, command: string): Promise<string> {
    const binding = this.bindings.get(threadId);
    if (!binding) throw new Error(`Unknown thread ${threadId}`);
    const interactionId = newId("interaction");
    await this.emitFor(binding, "pending_interaction", {
      interactionId,
      backendRequestId: `request-${interactionId}`,
      method: "item/commandExecution/requestApproval",
      kind: "approval",
      params: { command }
    });
    return interactionId;
  }

  async emitFor(binding: Binding, type: NormalizedRuntimeEvent["type"], payload: Record<string, unknown>): Promise<void> {
    await this.#emit({
      eventId: newId("event"),
      backendEventKey: `${this.id}:${type}:${binding.turnId}:${JSON.stringify(payload)}`,
      runtimeId: this.id,
      agentId: binding.agentId,
      incarnationId: binding.incarnationId,
      threadId: binding.threadId,
      turnId: binding.turnId,
      type,
      payload,
      occurredAt: new Date().toISOString()
    });
  }

  async #start(agentId: string, incarnationId: string): Promise<StartTurnResult> {
    const number = ++this.#counter;
    const threadId = `thread-${this.id}-${number}`;
    const turnId = `turn-${number}`;
    const binding = { agentId, incarnationId, threadId, turnId };
    this.bindings.set(threadId, binding);
    const acceptedAt = new Date().toISOString();
    await this.emitFor(binding, "thread_started", { threadId });
    await this.emitFor(binding, "turn_started", { turnId });
    return { threadId, turnId, acceptedAt };
  }

  async #emit(event: NormalizedRuntimeEvent): Promise<void> {
    const handlers = this.#events.listeners("event") as RuntimeEventHandler[];
    await Promise.all(handlers.map((handler) => handler(event)));
  }
}

export function dependencies(adapters: MockRuntimeAdapter[]) {
  return {
    adapters: new Map<string, RuntimeAdapter>(adapters.map((adapter) => [adapter.id, adapter])),
    logger: silentLogger,
    redactor: new SecretRedactor()
  };
}
