import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { EventEmitter } from "node:events";
import readline from "node:readline";
import type { CodexRuntimeConfig } from "../config.js";
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
import type {
  CodexClientMessage,
  CodexRpcError,
  CodexServerMessage,
  JsonRpcId,
  SandboxPolicy,
  ThreadResumeParams,
  ThreadStartParams,
  TurnStartParams
} from "./codex-protocol.js";
import { nestedString, objectResult } from "./codex-protocol.js";

interface PendingRequest {
  resolve(value: unknown): void;
  reject(error: Error): void;
  timer: NodeJS.Timeout;
  method: string;
}

interface BoundContext {
  agentId: string;
  incarnationId: string;
  threadId: string;
  turnId: string | null;
}

export class CodexAppServerAdapter implements RuntimeAdapter {
  readonly id: string;
  readonly capabilities: RuntimeCapabilities = {
    steer: true,
    interrupt: true,
    resume: true,
    approvals: true,
    readOnlySandbox: true,
    writeSandbox: true
  };

  #state: RuntimeState = "offline";
  #process: ChildProcessWithoutNullStreams | null = null;
  #connectPromise: Promise<void> | null = null;
  #nextRequestId = 1;
  #pending = new Map<JsonRpcId, PendingRequest>();
  #events = new EventEmitter();
  #threads = new Map<string, BoundContext>();
  #turns = new Map<string, BoundContext>();
  #interactions = new Map<string, string>();
  #stderrLines: readline.Interface | null = null;

  constructor(
    private readonly config: CodexRuntimeConfig,
    private readonly logger: Logger,
    private readonly redactor: SecretRedactor
  ) {
    this.id = config.id;
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
    const codexHome = resolveSecretReference(this.config.codexHomeRef);
    this.redactor.addSecret(codexHome);
    const child = spawn(this.config.command, this.config.args, {
      env: { ...process.env, CODEX_HOME: codexHome },
      stdio: ["pipe", "pipe", "pipe"]
    });
    this.#process = child;
    this.#state = "degraded";

    const lines = readline.createInterface({ input: child.stdout });
    lines.on("line", (line) => this.#handleLine(line));
    this.#stderrLines = readline.createInterface({ input: child.stderr });
    this.#stderrLines.on("line", (line) => {
      this.logger.warn({ runtime_id: this.id, app_server: line }, "Codex App Server stderr");
    });
    child.once("error", (error) => this.#handleDisconnect(error));
    child.once("exit", (code, signal) => {
      this.#handleDisconnect(new Error(`Codex App Server exited code=${String(code)} signal=${String(signal)}`));
    });

    try {
      await this.#request(
        "initialize",
        {
          clientInfo: { name: "codex_router", title: "Codex Router", version: "0.1.0" },
          capabilities: { experimentalApi: true }
        },
        10_000
      );
      this.#notify("initialized", {});
      this.#state = "ready";
      this.logger.info({ runtime_id: this.id }, "Codex App Server initialized");
      void this.#refreshAccountState();
    } catch (error) {
      await this.close();
      throw new RouterError("protocol_incompatible", `Failed to initialize runtime ${this.id}`, {
        cause: error instanceof Error ? error.message : String(error),
        expectedProtocolVersion: this.config.protocolVersion
      });
    }
  }

  async close(): Promise<void> {
    const child = this.#process;
    this.#process = null;
    this.#state = "offline";
    this.#stderrLines?.close();
    this.#stderrLines = null;
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
    const model = context.model ?? this.config.defaultModel;
    const threadParams: ThreadStartParams = {
      ...(model ? { model } : {}),
      cwd: context.worktreePath,
      approvalPolicy: this.config.approvalPolicy,
      sandbox: context.worktreeMode === "read_only" ? "read-only" : "workspace-write",
      serviceName: "codex_router",
      developerInstructions: buildDeveloperInstructions(context),
      threadSource: correlationSource(context.agentId, context.incarnationId)
    };
    const threadResponse = objectResult(await this.#request("thread/start", threadParams));
    const threadId = nestedString(threadResponse, "thread", "id");
    if (!threadId) throw new RouterError("protocol_incompatible", "thread/start response did not include thread.id");
    const bound: BoundContext = {
      agentId: context.agentId,
      incarnationId: context.incarnationId,
      threadId,
      turnId: null
    };
    this.#threads.set(threadId, bound);
    await this.#emit({
      eventId: newId("event"),
      backendEventKey: `${this.id}:thread_started:${threadId}`,
      runtimeId: this.id,
      agentId: context.agentId,
      incarnationId: context.incarnationId,
      threadId,
      type: "thread_started",
      payload: { threadId },
      occurredAt: new Date().toISOString()
    });

    const prompt = buildInitialPrompt(context);
    const turn = await this.#startTurn({
      agentId: context.agentId,
      incarnationId: context.incarnationId,
      idempotencyKey: context.idempotencyKey,
      threadId,
      input: prompt,
      worktreePath: context.worktreePath,
      worktreeMode: context.worktreeMode,
      ...(context.model ? { model: context.model } : {})
    });
    return turn;
  }

  async continueTurn(context: ContinueTurnContext): Promise<StartTurnResult> {
    await this.connect();
    const read = objectResult(
      await this.#request("thread/read", { threadId: context.threadId, includeTurns: false })
    );
    if (nestedString(read, "thread", "status", "type") === "notLoaded") {
      const resumeParams: ThreadResumeParams = {
        threadId: context.threadId,
        cwd: context.worktreePath,
        ...(context.model ? { model: context.model } : {}),
        approvalPolicy: this.config.approvalPolicy,
        sandbox: context.worktreeMode === "read_only" ? "read-only" : "workspace-write"
      };
      await this.#request("thread/resume", resumeParams);
    }
    this.#threads.set(context.threadId, {
      agentId: context.agentId,
      incarnationId: context.incarnationId,
      threadId: context.threadId,
      turnId: null
    });
    return this.#startTurn({
      ...context,
      input:
        context.fencingToken === undefined
          ? context.input
          : `Writer fencing token: ${context.fencingToken}\n\n${context.input}`
    });
  }

  bindContext(
    agentId: string,
    incarnationId: string,
    threadId: string,
    turnId: string | null
  ): void {
    const bound = { agentId, incarnationId, threadId, turnId };
    this.#threads.set(threadId, bound);
    if (turnId) this.#turns.set(turnId, bound);
  }

  async #startTurn(context: ContinueTurnContext): Promise<StartTurnResult> {
    const params: TurnStartParams = {
      threadId: context.threadId,
      clientUserMessageId: context.idempotencyKey,
      input: [{ type: "text", text: context.input }],
      cwd: context.worktreePath,
      ...(context.model ? { model: context.model } : {}),
      sandboxPolicy: sandboxPolicy(context.worktreeMode, context.worktreePath, this.config.networkAccess)
    };
    const response = objectResult(await this.#request("turn/start", params));
    const turnId = nestedString(response, "turn", "id");
    if (!turnId) throw new RouterError("protocol_incompatible", "turn/start response did not include turn.id");
    const bound: BoundContext = {
      agentId: context.agentId,
      incarnationId: context.incarnationId,
      threadId: context.threadId,
      turnId
    };
    this.#threads.set(context.threadId, bound);
    this.#turns.set(turnId, bound);
    const acceptedAt = new Date().toISOString();
    await this.#emit({
      eventId: newId("event"),
      backendEventKey: `${this.id}:turn_started:${turnId}`,
      runtimeId: this.id,
      agentId: context.agentId,
      incarnationId: context.incarnationId,
      threadId: context.threadId,
      turnId,
      type: "turn_started",
      payload: { turnId },
      occurredAt: acceptedAt
    });
    return { threadId: context.threadId, turnId, acceptedAt };
  }

  async steer(threadId: string, turnId: string, input: string, idempotencyKey: string): Promise<void> {
    await this.connect();
    try {
      await this.#request("turn/steer", {
        threadId,
        clientUserMessageId: idempotencyKey,
        input: [{ type: "text", text: input }],
        expectedTurnId: turnId
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (/not steerable|review|compact/i.test(message)) {
        throw new RouterError("not_steerable", message);
      }
      if (/turn.*mismatch|active turn/i.test(message)) throw new RouterError("stale_turn", message);
      throw error;
    }
  }

  async interrupt(threadId: string, turnId: string): Promise<void> {
    await this.connect();
    await this.#request("turn/interrupt", { threadId, turnId });
  }

  async respond(
    backendRequestId: string | number,
    method: string,
    response: AgentRespondRequest["response"],
    params: Record<string, unknown>
  ): Promise<void> {
    await this.connect();
    let result: unknown;
    if (response.type === "approval") {
      result = { decision: response.decision === "approve_once" ? "accept" : "decline" };
    } else {
      const questions = Array.isArray(params.questions) ? params.questions : [];
      const answers: Record<string, { answers: string[] }> = {};
      const structured = parseInputAnswers(response.input);
      for (const question of questions) {
        if (!question || typeof question !== "object") continue;
        const id = String((question as Record<string, unknown>).id ?? "");
        if (!id) continue;
        const answer = structured?.[id] ?? response.input;
        answers[id] = { answers: Array.isArray(answer) ? answer.map(String) : [String(answer)] };
      }
      result = { answers };
    }
    this.#send({ id: backendRequestId, result });
    this.#interactions.delete(String(backendRequestId));
    this.logger.info({ runtime_id: this.id, method }, "Responded to App Server interaction");
  }

  async reconcile(threadId: string, knownTurnId: string | null): Promise<ReconciliationResult> {
    await this.connect();
    try {
      const response = objectResult(
        await this.#request("thread/read", { threadId, includeTurns: true })
      );
      const status = nestedString(response, "thread", "status", "type");
      const turns = nestedArray(response, "thread", "turns");
      const known = turns.find((turn) => nestedString(turn, "id") === knownTurnId);
      const latest = known ?? turns.at(-1);
      const turnId = nestedString(latest, "id") ?? knownTurnId;
      const turnStatus = nestedString(latest, "status");
      if (turnStatus && ["completed", "failed", "interrupted"].includes(turnStatus)) {
        return {
          state: "terminal",
          threadId,
          turnId,
          turnStatus: turnStatus as "completed" | "failed" | "interrupted",
          evidence: { source: "thread/read", threadStatus: status }
        };
      }
      if (status === "notLoaded") return { state: "not_loaded", threadId, turnId, evidence: { source: "thread/read" } };
      if (status === "active") return { state: "active", threadId, turnId, evidence: { source: "thread/read" } };
      return { state: "unknown", threadId, turnId, evidence: { source: "thread/read", threadStatus: status } };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (/not found/i.test(message)) return { state: "not_found", threadId, turnId: knownTurnId, evidence: { message } };
      return { state: "unknown", threadId, turnId: knownTurnId, evidence: { message } };
    }
  }

  async findThreadByCorrelation(
    agentId: string,
    incarnationId: string,
    worktreePath: string
  ): Promise<string | null> {
    await this.connect();
    const expectedSource = correlationSource(agentId, incarnationId);
    let cursor: string | null = null;
    for (let page = 0; page < 10; page += 1) {
      const response = objectResult(
        await this.#request("thread/list", {
          cursor,
          limit: 100,
          sortKey: "updated_at",
          sortDirection: "desc",
          cwd: worktreePath,
          sourceKinds: []
        })
      );
      const threads = Array.isArray(response.data) ? response.data : [];
      for (const thread of threads) {
        if (!thread || typeof thread !== "object" || Array.isArray(thread)) continue;
        const record = thread as Record<string, unknown>;
        if (record.threadSource === expectedSource && typeof record.id === "string") {
          this.bindContext(agentId, incarnationId, record.id, null);
          return record.id;
        }
      }
      cursor = typeof response.nextCursor === "string" ? response.nextCursor : null;
      if (!cursor) break;
    }
    return null;
  }

  async inspectBackgroundTerminals(threadId: string): Promise<BackgroundTerminalInventory> {
    await this.connect();
    try {
      const response = objectResult(await this.#request("thread/read", { threadId, includeTurns: true }));
      const turns = nestedArray(response, "thread", "turns");
      const terminals: BackgroundTerminalInventory["terminals"] = [];
      for (const turn of turns) {
        const items = nestedArray(turn, "items");
        for (const item of items) {
          if (nestedString(item, "type") !== "commandExecution") continue;
          const processId = nestedString(item, "processId");
          const status = nestedString(item, "status");
          if (processId && status === "inProgress") {
            const command = nestedString(item, "command");
            terminals.push({
              id: processId,
              status,
              ...(command ? { command } : {})
            });
          }
        }
      }
      return { clean: terminals.length === 0, terminals, inspectedAt: new Date().toISOString() };
    } catch (error) {
      return {
        clean: false,
        terminals: [{ id: "unknown", status: error instanceof Error ? error.message : String(error) }],
        inspectedAt: new Date().toISOString()
      };
    }
  }

  async #refreshAccountState(): Promise<void> {
    try {
      const rateLimits = objectResult(await this.#request("account/rateLimits/read", undefined));
      await this.#emit({
        eventId: newId("event"),
        runtimeId: this.id,
        type: "rate_limits_updated",
        payload: normalizeRateLimits(rateLimits),
        occurredAt: new Date().toISOString()
      });
    } catch (error) {
      this.logger.warn(
        { runtime_id: this.id, error: error instanceof Error ? error.message : String(error) },
        "Unable to read initial App Server quota state"
      );
    }
  }

  #handleLine(line: string): void {
    let message: CodexServerMessage;
    try {
      message = JSON.parse(line) as CodexServerMessage;
    } catch {
      this.logger.warn({ runtime_id: this.id }, "Ignored non-JSON App Server output");
      return;
    }
    if (message.id !== undefined && !message.method) {
      const pending = this.#pending.get(message.id);
      if (!pending) return;
      clearTimeout(pending.timer);
      this.#pending.delete(message.id);
      if (message.error) pending.reject(rpcError(pending.method, message.error));
      else pending.resolve(message.result);
      return;
    }
    if (message.id !== undefined && message.method) {
      void this.#handleServerRequest(message.id, message.method, message.params ?? {}).catch((error) => {
        this.logger.error(
          { runtime_id: this.id, error: error instanceof Error ? error.message : String(error) },
          "Failed to persist App Server interaction"
        );
        try {
          this.#send({ id: message.id!, error: { code: -32_000, message: "Router could not persist interaction" } });
        } catch {
          // Transport failure is already reported by the process lifecycle handler.
        }
      });
      return;
    }
    if (message.method) {
      void this.#handleNotification(message.method, message.params ?? {}).catch((error) => {
        this.logger.error(
          { runtime_id: this.id, error: error instanceof Error ? error.message : String(error) },
          "Failed to persist App Server notification"
        );
      });
    }
  }

  async #handleServerRequest(id: JsonRpcId, method: string, params: Record<string, unknown>): Promise<void> {
    const threadId = nestedString(params, "threadId");
    const turnId = nestedString(params, "turnId");
    const bound = (turnId ? this.#turns.get(turnId) : undefined) ?? (threadId ? this.#threads.get(threadId) : undefined);
    if (!bound) {
      this.#send({ id, error: { code: -32_001, message: "Router has no owner for this interaction" } });
      return;
    }
    const interactionId = newId("interaction");
    this.#interactions.set(String(id), interactionId);
    const kind = /requestUserInput|elicitation/i.test(method) ? "user_input" : "approval";
    await this.#emit({
      eventId: newId("event"),
      backendEventKey: `${this.id}:server_request:${String(id)}`,
      runtimeId: this.id,
      agentId: bound.agentId,
      incarnationId: bound.incarnationId,
      threadId: bound.threadId,
      ...(turnId ? { turnId } : {}),
      type: "pending_interaction",
      payload: { interactionId, backendRequestId: id, method, kind, params },
      occurredAt: new Date().toISOString()
    });
  }

  async #handleNotification(method: string, params: Record<string, unknown>): Promise<void> {
    const threadId = nestedString(params, "threadId") ?? nestedString(params, "thread", "id");
    const turnId = nestedString(params, "turnId") ?? nestedString(params, "turn", "id");
    const bound = (turnId ? this.#turns.get(turnId) : undefined) ?? (threadId ? this.#threads.get(threadId) : undefined);
    const base = bound
      ? {
          agentId: bound.agentId,
          incarnationId: bound.incarnationId,
          threadId: threadId ?? bound.threadId,
          ...(turnId ? { turnId } : {})
        }
      : {};
    const occurredAt = new Date().toISOString();

    if (method === "turn/started" && bound && turnId) {
      bound.turnId = turnId;
      this.#turns.set(turnId, bound);
      await this.#emit({
        eventId: newId("event"),
        backendEventKey: `${this.id}:turn_started:${turnId}`,
        runtimeId: this.id,
        ...base,
        type: "turn_started",
        payload: { turnId },
        occurredAt
      });
      return;
    }
    if (method === "turn/completed" && bound && turnId) {
      const status = nestedString(params, "turn", "status") ?? "failed";
      const errorClass = nestedString(params, "turn", "error", "codexErrorInfo", "type");
      await this.#emit({
        eventId: newId("event"),
        backendEventKey: `${this.id}:turn_completed:${turnId}:${status}`,
        runtimeId: this.id,
        ...base,
        type: "turn_completed",
        payload: {
          status,
          terminalReason: errorClass ?? status,
          error: nestedObject(params, "turn", "error"),
          reported: extractReported(params)
        },
        occurredAt
      });
      return;
    }
    if ((method === "item/agentMessage/delta" || method === "item/reasoning/textDelta") && bound) {
      await this.#emit({
        eventId: newId("event"),
        backendEventKey: `${this.id}:semantic_output:${turnId ?? bound.turnId ?? bound.threadId}`,
        runtimeId: this.id,
        ...base,
        type: "semantic_output",
        payload: { method },
        occurredAt
      });
      return;
    }
    if (method === "item/started" && bound) {
      const item = nestedObject(params, "item");
      const itemType = nestedString(item, "type");
      if (itemType === "commandExecution") {
        await this.#emitItemEvent("command_started", item, base, occurredAt);
      } else if (itemType === "fileChange") {
        await this.#emitItemEvent("file_change", item, base, occurredAt);
      }
      return;
    }
    if (method === "item/completed" && bound) {
      const item = nestedObject(params, "item");
      if (nestedString(item, "type") === "commandExecution") {
        await this.#emitItemEvent("command_completed", item, base, occurredAt);
      } else if (nestedString(item, "type") === "agentMessage") {
        await this.#emit({
          eventId: newId("event"),
          backendEventKey: `${this.id}:semantic_output:${turnId ?? bound.turnId ?? bound.threadId}`,
          runtimeId: this.id,
          ...base,
          type: "semantic_output",
          payload: { method },
          occurredAt
        });
      }
      return;
    }
    if (method === "turn/diff/updated" && bound) {
      await this.#emit({
        eventId: newId("event"),
        runtimeId: this.id,
        ...base,
        type: "turn_diff_updated",
        payload: { diff: params.diff },
        occurredAt
      });
      return;
    }
    if (method === "serverRequest/resolved" && bound) {
      const requestId = String(params.requestId ?? "");
      const interactionId = this.#interactions.get(requestId);
      if (interactionId) {
        await this.#emit({
          eventId: newId("event"),
          backendEventKey: `${this.id}:server_request_resolved:${requestId}`,
          runtimeId: this.id,
          ...base,
          type: "interaction_resolved",
          payload: { interactionId },
          occurredAt
        });
      }
      return;
    }
    if (method === "account/rateLimits/updated") {
      await this.#emit({
        eventId: newId("event"),
        runtimeId: this.id,
        type: "rate_limits_updated",
        payload: normalizeRateLimits(params),
        occurredAt
      });
      return;
    }
    if (method === "thread/status/changed" && bound) {
      await this.#emit({
        eventId: newId("event"),
        runtimeId: this.id,
        ...base,
        type: "thread_status_changed",
        payload: params,
        occurredAt
      });
      return;
    }
    if (method === "error" && bound) {
      await this.#emit({
        eventId: newId("event"),
        runtimeId: this.id,
        ...base,
        type: "runtime_error",
        payload: normalizeError(params),
        occurredAt
      });
    }
  }

  async #emitItemEvent(
    type: "command_started" | "command_completed" | "file_change",
    item: Record<string, unknown>,
    base: Partial<NormalizedRuntimeEvent>,
    occurredAt: string
  ): Promise<void> {
    const itemId = nestedString(item, "id") ?? newId("item");
    await this.#emit({
      eventId: newId("event"),
      backendEventKey: `${this.id}:${type}:${itemId}`,
      runtimeId: this.id,
      ...base,
      type,
      payload: {
        itemId,
        command: item.command,
        status: item.status,
        exitCode: item.exitCode,
        output: truncate(String(item.aggregatedOutput ?? ""), 4_000)
      },
      occurredAt
    } as NormalizedRuntimeEvent);
  }

  #handleDisconnect(error: Error): void {
    if (this.#state === "offline" && !this.#process) return;
    this.#state = "degraded";
    this.#process = null;
    for (const pending of this.#pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(error);
    }
    this.#pending.clear();
    this.logger.error({ runtime_id: this.id, error: error.message }, "Codex App Server disconnected");
    void this.#emit({
      eventId: newId("event"),
      runtimeId: this.id,
      type: "runtime_disconnected",
      payload: { message: error.message },
      occurredAt: new Date().toISOString()
    }).catch((eventError) => {
      this.logger.error(
        { runtime_id: this.id, error: eventError instanceof Error ? eventError.message : String(eventError) },
        "Failed to persist App Server disconnect"
      );
    });
  }

  async #request(method: string, params?: unknown, timeoutMs = 30_000): Promise<unknown> {
    if (!this.#process) throw new RouterError("runtime_unavailable", `Runtime ${this.id} is not connected`);
    const id = this.#nextRequestId++;
    const promise = new Promise<unknown>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.#pending.delete(id);
        reject(new RouterError("runtime_unavailable", `${method} timed out`));
      }, timeoutMs);
      this.#pending.set(id, { resolve, reject, timer, method });
    });
    try {
      this.#send({ id, method, ...(params === undefined ? {} : { params }) });
    } catch (error) {
      const pending = this.#pending.get(id);
      if (pending) clearTimeout(pending.timer);
      this.#pending.delete(id);
      throw error;
    }
    return promise;
  }

  #notify(method: string, params: unknown): void {
    this.#send({ method, params });
  }

  #send(message: CodexClientMessage): void {
    const child = this.#process;
    if (!child?.stdin.writable) throw new RouterError("runtime_unavailable", `Runtime ${this.id} transport is closed`);
    child.stdin.write(`${JSON.stringify(message)}\n`);
  }

  async #emit(event: NormalizedRuntimeEvent): Promise<void> {
    const listeners = this.#events.listeners("event") as RuntimeEventHandler[];
    await Promise.all(listeners.map((listener) => listener(event)));
  }
}

function sandboxPolicy(mode: "write" | "read_only", worktreePath: string, networkAccess: boolean): SandboxPolicy {
  if (mode === "read_only") return { type: "readOnly", networkAccess: false };
  return {
    type: "workspaceWrite",
    writableRoots: [worktreePath],
    networkAccess,
    excludeTmpdirEnvVar: false,
    excludeSlashTmp: false
  };
}

function buildDeveloperInstructions(context: RuntimeTaskContext): string {
  const authority = context.authority;
  return [
    "You are a bounded worker controlled by Codex Router.",
    `Logical agent: ${context.agentId}`,
    `Incarnation: ${context.incarnationId}`,
    `Worktree mode: ${context.worktreeMode}`,
    context.fencingToken === undefined ? "No writer lease is granted." : `Writer fencing token: ${context.fencingToken}`,
    "Inspect the actual worktree before editing. Preserve pre-existing changes.",
    `Remote authority: push=${authority.allowPush}, merge=${authority.allowMerge}, deploy=${authority.allowDeploy}, externalWrites=${authority.allowExternalWrites}.`,
    "Do not broaden authority. Report decisions, invariants, risks, pending work, changed files, and exact tests concisely."
  ].join("\n");
}

function correlationSource(agentId: string, incarnationId: string): string {
  return `codex-router:${agentId}:${incarnationId}`;
}

function buildInitialPrompt(context: RuntimeTaskContext): string {
  const sections = ["Objective:", context.task];
  if (context.hydration) {
    sections.push(
      "",
      "Recovery checkpoint (verify every claim against actual state before editing):",
      JSON.stringify(context.hydration)
    );
  }
  return sections.join("\n");
}

function rpcError(method: string, error: CodexRpcError): Error {
  return new RouterError("runtime_unavailable", `${method} failed: ${error.message}`, {
    rpcCode: error.code,
    data: error.data
  });
}

function nestedObject(value: unknown, ...path: string[]): Record<string, unknown> {
  let current: unknown = value;
  for (const segment of path) {
    if (!current || typeof current !== "object" || Array.isArray(current)) return {};
    current = (current as Record<string, unknown>)[segment];
  }
  return current && typeof current === "object" && !Array.isArray(current)
    ? (current as Record<string, unknown>)
    : {};
}

function nestedArray(value: unknown, ...path: string[]): Record<string, unknown>[] {
  let current: unknown = value;
  for (const segment of path) {
    if (!current || typeof current !== "object" || Array.isArray(current)) return [];
    current = (current as Record<string, unknown>)[segment];
  }
  return Array.isArray(current)
    ? current.filter((entry): entry is Record<string, unknown> => Boolean(entry && typeof entry === "object" && !Array.isArray(entry)))
    : [];
}

function normalizeRateLimits(value: Record<string, unknown>): Record<string, unknown> {
  const source = nestedObject(value, "rateLimits");
  const limits = Object.keys(source).length > 0 ? source : value;
  return {
    ...(limits.primary && typeof limits.primary === "object" ? { primary: limits.primary } : {}),
    ...(limits.secondary && typeof limits.secondary === "object" ? { secondary: limits.secondary } : {}),
    ...(limits.credits && typeof limits.credits === "object" ? { credits: limits.credits } : {}),
    ...(typeof limits.limitId === "string" ? { limitId: limits.limitId } : {}),
    ...(typeof limits.limitName === "string" ? { limitName: limits.limitName } : {}),
    ...(typeof limits.planType === "string" ? { planType: limits.planType } : {})
  };
}

function normalizeError(params: Record<string, unknown>): Record<string, unknown> {
  const error = nestedObject(params, "error");
  const info = nestedString(error, "codexErrorInfo", "type") ?? nestedString(error, "codexErrorInfo");
  return {
    class: info === "UsageLimitExceeded" ? "usage_limit" : "unknown",
    message: nestedString(error, "message") ?? nestedString(params, "message") ?? "Runtime error",
    codexErrorInfo: info
  };
}

function extractReported(params: Record<string, unknown>): Record<string, unknown> {
  const items = nestedArray(params, "turn", "items");
  const messages = items.filter((item) => nestedString(item, "type") === "agentMessage");
  const final = messages.findLast((item) => nestedString(item, "phase") === "final_answer") ?? messages.at(-1);
  return { summary: nestedString(final, "text") ?? "" };
}

function parseInputAnswers(input: string): Record<string, string | string[]> | null {
  try {
    const parsed = JSON.parse(input) as unknown;
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      return parsed as Record<string, string | string[]>;
    }
  } catch {
    // Plain input is valid for a single-question request.
  }
  return null;
}

function truncate(value: string, max: number): string {
  return value.length <= max ? value : `${value.slice(0, max)}…`;
}
