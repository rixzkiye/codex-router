import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { EventEmitter } from "node:events";
import readline from "node:readline";
import type { ExternalRuntimeConfig } from "../config.js";
import { resolveSecretReference } from "../config.js";
import type { AgentRespondRequest, NormalizedRuntimeEvent, RuntimeState } from "../domain.js";
import { RouterError } from "../errors.js";
import { newId, type Logger, SecretRedactor } from "../security.js";
import type {
  BackgroundTerminalInventory,
  ContinueTurnContext,
  ReconciliationResult,
  RuntimeAdapter,
  RuntimeCapabilities,
  RuntimeEventHandler,
  RuntimeTaskContext,
  StartTurnResult
} from "./types.js";

interface RpcMessage {
  id?: string | number;
  method?: string;
  params?: Record<string, unknown>;
  result?: unknown;
  error?: { code?: number; message?: string; data?: unknown };
}

interface Pending {
  resolve(value: unknown): void;
  reject(error: Error): void;
  timer: NodeJS.Timeout;
}

/**
 * Adapter for API-backed provider bridges. The bridge owns provider-specific
 * model/tool semantics and exposes bounded JSONL RPC. This keeps credentials
 * outside prompts while preserving the router's lifecycle and evidence model.
 */
export class ExternalProcessAdapter implements RuntimeAdapter {
  readonly id: string;
  readonly capabilities: RuntimeCapabilities;
  #state: RuntimeState = "offline";
  #process: ChildProcessWithoutNullStreams | null = null;
  #connectPromise: Promise<void> | null = null;
  #pending = new Map<string | number, Pending>();
  #nextId = 1;
  #events = new EventEmitter();
  #bindings = new Map<string, { agentId: string; incarnationId: string; threadId: string }>();

  constructor(
    private readonly config: ExternalRuntimeConfig,
    private readonly logger: Logger,
    private readonly redactor: SecretRedactor
  ) {
    this.id = config.id;
    this.capabilities = {
      ...config.capabilities,
      readOnlySandbox: true,
      writeSandbox: true
    };
  }

  get state(): RuntimeState {
    return this.#state;
  }

  async connect(): Promise<void> {
    if (this.#state === "ready" || this.#state === "busy") return;
    if (this.#connectPromise) return this.#connectPromise;
    this.#connectPromise = this.#connect();
    try {
      await this.#connectPromise;
    } finally {
      this.#connectPromise = null;
    }
  }

  async #connect(): Promise<void> {
    const credential = this.config.credentialRef
      ? resolveSecretReference(this.config.credentialRef)
      : undefined;
    this.redactor.addSecret(credential);
    const child = spawn(this.config.command, this.config.args, {
      env: {
        ...process.env,
        ...(credential ? { CODEX_ROUTER_PROVIDER_CREDENTIAL: credential } : {})
      },
      stdio: ["pipe", "pipe", "pipe"]
    });
    this.#process = child;
    this.#state = "degraded";
    readline.createInterface({ input: child.stdout }).on("line", (line) => this.#handleLine(line));
    readline.createInterface({ input: child.stderr }).on("line", (line) => {
      this.logger.warn({ runtime_id: this.id, provider_bridge: line }, "External provider bridge stderr");
    });
    child.once("error", (error) => this.#disconnect(error));
    child.once("exit", (code, signal) =>
      this.#disconnect(new Error(`Provider bridge exited code=${String(code)} signal=${String(signal)}`))
    );
    try {
      const result = asRecord(
        await this.#request("initialize", {
          clientInfo: { name: "codex_router", version: "0.1.0" },
          provider: this.config.provider,
          allowedModels: this.config.allowedModels,
          requestedCapabilities: this.config.capabilities
        })
      );
      const advertised = asRecord(result.capabilities);
      for (const capability of ["steer", "interrupt", "resume", "approvals"] as const) {
        if (this.config.capabilities[capability] && advertised[capability] !== true) {
          throw new RouterError(
            "protocol_incompatible",
            `External bridge ${this.id} did not advertise required ${capability} capability`
          );
        }
      }
      this.#notify("initialized", {});
      this.#state = "ready";
    } catch (error) {
      await this.close();
      if (error instanceof RouterError) throw error;
      throw new RouterError("protocol_incompatible", `Failed to initialize external bridge ${this.id}`, {
        cause: error instanceof Error ? error.message : String(error)
      });
    }
  }

  async close(): Promise<void> {
    const child = this.#process;
    this.#process = null;
    this.#state = "offline";
    if (!child || child.killed) return;
    child.kill("SIGTERM");
    await Promise.race([
      new Promise<void>((resolve) => child.once("exit", () => resolve())),
      new Promise<void>((resolve) => setTimeout(resolve, 2_000))
    ]);
    if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
  }

  onEvent(handler: RuntimeEventHandler): () => void {
    this.#events.on("event", handler);
    return () => this.#events.off("event", handler);
  }

  async startTask(context: RuntimeTaskContext): Promise<StartTurnResult> {
    await this.connect();
    const result = asRecord(
      await this.#request("agent/start", {
        task: context.task,
        worktree: { path: context.worktreePath, mode: context.worktreeMode },
        authority: context.authority,
        model: context.model,
        clientOperationId: context.idempotencyKey,
        fencingToken: context.fencingToken,
        hydration: context.hydration
      })
    );
    const started = parseStarted(result);
    this.#bindings.set(started.threadId, {
      agentId: context.agentId,
      incarnationId: context.incarnationId,
      threadId: started.threadId
    });
    await this.#emitBound("turn_started", context.agentId, context.incarnationId, started, {
      turnId: started.turnId
    });
    return started;
  }

  async continueTurn(context: ContinueTurnContext): Promise<StartTurnResult> {
    await this.connect();
    if (!this.capabilities.resume) throw new RouterError("unsupported", "External bridge does not support continuation");
    const result = asRecord(
      await this.#request("agent/continue", {
        threadId: context.threadId,
        input: context.input,
        worktree: { path: context.worktreePath, mode: context.worktreeMode },
        model: context.model,
        fencingToken: context.fencingToken,
        clientOperationId: context.idempotencyKey
      })
    );
    const started = parseStarted(result, context.threadId);
    this.#bindings.set(started.threadId, {
      agentId: context.agentId,
      incarnationId: context.incarnationId,
      threadId: started.threadId
    });
    await this.#emitBound("turn_started", context.agentId, context.incarnationId, started, {
      turnId: started.turnId
    });
    return started;
  }

  async steer(threadId: string, turnId: string, input: string, idempotencyKey: string): Promise<void> {
    if (!this.capabilities.steer) throw new RouterError("unsupported", "External bridge does not support steering");
    await this.#request("agent/steer", { threadId, turnId, input, clientOperationId: idempotencyKey });
  }

  async interrupt(threadId: string, turnId: string): Promise<void> {
    if (!this.capabilities.interrupt) throw new RouterError("unsupported", "External bridge does not support interruption");
    await this.#request("agent/interrupt", { threadId, turnId });
  }

  async respond(
    backendRequestId: string | number,
    method: string,
    response: AgentRespondRequest["response"],
    params: Record<string, unknown>
  ): Promise<void> {
    if (!this.capabilities.approvals) throw new RouterError("unsupported", "External bridge does not support interactions");
    await this.#request("agent/respond", { backendRequestId, method, response, params });
  }

  async reconcile(threadId: string, knownTurnId: string | null): Promise<ReconciliationResult> {
    const result = asRecord(await this.#request("agent/reconcile", { threadId, knownTurnId }));
    const state = String(result.state ?? "unknown");
    if (!["active", "terminal", "not_loaded", "not_found", "unknown"].includes(state)) {
      throw new RouterError("protocol_incompatible", `External bridge returned invalid reconciliation state ${state}`);
    }
    return {
      state: state as ReconciliationResult["state"],
      threadId,
      turnId: typeof result.turnId === "string" ? result.turnId : knownTurnId,
      ...(result.turnStatus === "completed" || result.turnStatus === "failed" || result.turnStatus === "interrupted"
        ? { turnStatus: result.turnStatus }
        : {}),
      evidence: asRecord(result.evidence)
    };
  }

  async findThreadByCorrelation(
    agentId: string,
    incarnationId: string,
    worktreePath: string
  ): Promise<string | null> {
    const result = asRecord(
      await this.#request("agent/find", { agentId, incarnationId, worktreePath })
    );
    return typeof result.threadId === "string" ? result.threadId : null;
  }

  bindContext(
    agentId: string,
    incarnationId: string,
    threadId: string,
    _turnId: string | null
  ): void {
    this.#bindings.set(threadId, { agentId, incarnationId, threadId });
  }

  async inspectBackgroundTerminals(threadId: string): Promise<BackgroundTerminalInventory> {
    const result = asRecord(await this.#request("agent/terminals", { threadId }));
    const terminals = Array.isArray(result.terminals)
      ? result.terminals.filter(isTerminalEntry)
      : [];
    return {
      clean: result.clean === true && terminals.length === 0,
      terminals,
      inspectedAt: new Date().toISOString()
    };
  }

  #handleLine(line: string): void {
    let message: RpcMessage;
    try {
      message = JSON.parse(line) as RpcMessage;
    } catch {
      this.logger.warn({ runtime_id: this.id }, "Ignored non-JSON provider bridge output");
      return;
    }
    if (message.id !== undefined && !message.method) {
      const pending = this.#pending.get(message.id);
      if (!pending) return;
      clearTimeout(pending.timer);
      this.#pending.delete(message.id);
      if (message.error) pending.reject(new Error(message.error.message ?? "Provider bridge error"));
      else pending.resolve(message.result);
      return;
    }
    if (message.method === "event" && message.params) {
      void this.#handleEvent(message.params).catch((error) => {
        this.logger.error(
          { runtime_id: this.id, error: error instanceof Error ? error.message : String(error) },
          "Failed to persist external provider event"
        );
      });
    }
  }

  async #handleEvent(params: Record<string, unknown>): Promise<void> {
    const threadId = typeof params.threadId === "string" ? params.threadId : undefined;
    const binding = threadId ? this.#bindings.get(threadId) : undefined;
    const type = String(params.type ?? "");
    if (!isNormalizedType(type)) return;
    await this.#emit({
      eventId: typeof params.eventId === "string" ? params.eventId : newId("event"),
      ...(typeof params.backendEventKey === "string" ? { backendEventKey: `${this.id}:${params.backendEventKey}` } : {}),
      runtimeId: this.id,
      ...(binding ? { agentId: binding.agentId, incarnationId: binding.incarnationId } : {}),
      ...(threadId ? { threadId } : {}),
      ...(typeof params.turnId === "string" ? { turnId: params.turnId } : {}),
      type,
      payload: asRecord(params.payload),
      occurredAt: typeof params.occurredAt === "string" ? params.occurredAt : new Date().toISOString()
    });
  }

  async #emitBound(
    type: NormalizedRuntimeEvent["type"],
    agentId: string,
    incarnationId: string,
    started: StartTurnResult,
    payload: Record<string, unknown>
  ): Promise<void> {
    await this.#emit({
      eventId: newId("event"),
      backendEventKey: `${this.id}:${type}:${started.turnId}`,
      runtimeId: this.id,
      agentId,
      incarnationId,
      threadId: started.threadId,
      turnId: started.turnId,
      type,
      payload,
      occurredAt: started.acceptedAt
    });
  }

  async #request(method: string, params: Record<string, unknown>, timeoutMs = 30_000): Promise<unknown> {
    if (!this.#process) throw new RouterError("runtime_unavailable", `External runtime ${this.id} is not connected`);
    const id = this.#nextId++;
    const response = new Promise<unknown>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.#pending.delete(id);
        reject(new RouterError("runtime_unavailable", `${method} timed out`));
      }, timeoutMs);
      this.#pending.set(id, { resolve, reject, timer });
    });
    try {
      this.#send({ id, method, params });
    } catch (error) {
      const pending = this.#pending.get(id);
      if (pending) clearTimeout(pending.timer);
      this.#pending.delete(id);
      throw error;
    }
    return response;
  }

  #notify(method: string, params: Record<string, unknown>): void {
    this.#send({ method, params });
  }

  #send(message: RpcMessage): void {
    if (!this.#process?.stdin.writable) throw new RouterError("runtime_unavailable", "Provider bridge transport is closed");
    this.#process.stdin.write(`${JSON.stringify(message)}\n`);
  }

  #disconnect(error: Error): void {
    if (!this.#process && this.#state === "offline") return;
    this.#process = null;
    this.#state = "degraded";
    for (const pending of this.#pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(error);
    }
    this.#pending.clear();
    void this.#emit({
      eventId: newId("event"),
      runtimeId: this.id,
      type: "runtime_disconnected",
      payload: { message: error.message },
      occurredAt: new Date().toISOString()
    }).catch((eventError) => {
      this.logger.error(
        { runtime_id: this.id, error: eventError instanceof Error ? eventError.message : String(eventError) },
        "Failed to persist external provider disconnect"
      );
    });
  }

  async #emit(event: NormalizedRuntimeEvent): Promise<void> {
    const listeners = this.#events.listeners("event") as RuntimeEventHandler[];
    await Promise.all(listeners.map((listener) => listener(event)));
  }
}

function parseStarted(result: Record<string, unknown>, expectedThreadId?: string): StartTurnResult {
  const threadId = typeof result.threadId === "string" ? result.threadId : expectedThreadId;
  const turnId = typeof result.turnId === "string" ? result.turnId : undefined;
  if (!threadId || !turnId) {
    throw new RouterError("protocol_incompatible", "Provider bridge start response requires threadId and turnId");
  }
  return {
    threadId,
    turnId,
    acceptedAt: typeof result.acceptedAt === "string" ? result.acceptedAt : new Date().toISOString()
  };
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function isTerminalEntry(value: unknown): value is { id: string; status: string; command?: string } {
  return Boolean(
    value &&
      typeof value === "object" &&
      !Array.isArray(value) &&
      typeof (value as Record<string, unknown>).id === "string" &&
      typeof (value as Record<string, unknown>).status === "string"
  );
}

function isNormalizedType(value: string): value is NormalizedRuntimeEvent["type"] {
  return new Set([
    "thread_started",
    "thread_status_changed",
    "turn_started",
    "semantic_output",
    "command_started",
    "command_completed",
    "file_change",
    "turn_diff_updated",
    "pending_interaction",
    "interaction_resolved",
    "turn_completed",
    "runtime_error",
    "runtime_disconnected",
    "account_updated",
    "rate_limits_updated"
  ]).has(value);
}
