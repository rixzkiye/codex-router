import type { RouterConfig, RuntimeConfig } from "./config.js";
import type {
  AgentCancelRequest,
  AgentContinueRequest,
  AgentHandoffRequest,
  AgentRespondRequest,
  AgentResult,
  AgentStartRequest,
  AgentSteerRequest,
  AgentWaitRequest,
  NormalizedRuntimeEvent,
  RuntimeProfile
} from "./domain.js";
import { isTerminalStatus } from "./domain.js";
import { asRouterError, RouterError } from "./errors.js";
import { ResultDistiller } from "./result.js";
import { Scheduler } from "./scheduler.js";
import { newId, type Logger, SecretRedactor } from "./security.js";
import { RouterDatabase } from "./store/database.js";
import { agentWakeState, Registry } from "./store/registry.js";
import { CodexAppServerAdapter } from "./runtime/codex-app-server.js";
import { ExternalProcessAdapter } from "./runtime/external-process.js";
import type { RuntimeAdapter, RuntimeTaskContext } from "./runtime/types.js";
import { WorktreeInspector } from "./worktree.js";
import { PlatformService } from "./platform/service.js";
import type { CredentialStore } from "./platform/credentials.js";

const NONTERMINAL = [
  "queued",
  "starting",
  "running",
  "needs_attention",
  "cancelling",
  "handing_off",
  "waiting_for_reset"
] as const;

export interface RouterDependencies {
  adapters?: Map<string, RuntimeAdapter>;
  credentialStore?: CredentialStore;
  logger: Logger;
  redactor: SecretRedactor;
}

export class CodexRouter {
  readonly registry: Registry;
  readonly platform: PlatformService;
  readonly #database: RouterDatabase;
  readonly #scheduler: Scheduler;
  readonly #worktrees: WorktreeInspector;
  readonly #distiller: ResultDistiller;
  readonly #adapters: Map<string, RuntimeAdapter>;
  readonly #unsubscribers: Array<() => void> = [];
  readonly #leaseTimers = new Map<string, NodeJS.Timeout>();

  private constructor(
    readonly config: RouterConfig,
    private readonly logger: Logger,
    private readonly redactor: SecretRedactor,
    database: RouterDatabase,
    worktrees: WorktreeInspector,
    adapters: Map<string, RuntimeAdapter>,
    credentialStore?: CredentialStore
  ) {
    this.#database = database;
    this.registry = new Registry(database);
    this.platform = new PlatformService(database.connection, this.registry, config.inference, {
      ...(credentialStore ? { credentialStore } : {})
    });
    this.#worktrees = worktrees;
    this.#scheduler = new Scheduler(this.registry);
    this.#distiller = new ResultDistiller(this.registry, worktrees);
    this.#adapters = adapters;
  }

  static async create(config: RouterConfig, dependencies: RouterDependencies): Promise<CodexRouter> {
    const database = new RouterDatabase(config.databasePath);
    const worktrees = await WorktreeInspector.create(config.allowedWorktreeRoots);
    const adapters = dependencies.adapters ?? createAdapters(config.runtimes, dependencies.logger, dependencies.redactor);
    const router = new CodexRouter(
      config,
      dependencies.logger,
      dependencies.redactor,
      database,
      worktrees,
      adapters,
      dependencies.credentialStore
    );
    router.#registerRuntimes();
    router.#subscribeAdapters();
    await router.#connectRuntimes();
    router.#restoreLeaseRenewals();
    await router.reconcileOnStartup();
    return router;
  }

  async close(): Promise<void> {
    for (const timer of this.#leaseTimers.values()) clearInterval(timer);
    this.#leaseTimers.clear();
    for (const unsubscribe of this.#unsubscribers) unsubscribe();
    await Promise.allSettled([...this.#adapters.values()].map((adapter) => adapter.close()));
    await this.platform.close();
    this.#database.close();
  }

  async start(callerScope: string, request: AgentStartRequest) {
    const canonicalPath = await this.#worktrees.validate(request.worktree.path);
    const safeRequest = this.redactor.redact(request);
    const evidence = await this.#worktrees.inspect(canonicalPath);
    this.registry.registerWorktree(evidence);
    const { agent, replay } = this.registry.createAgent(
      callerScope,
      safeRequest,
      canonicalPath,
      this.config.idempotencyTtlMs
    );
    if (replay && agent.currentIncarnationId) return this.#startResponse(agent.id);
    if (replay && agent.status !== "queued") return this.#startResponse(agent.id);

    try {
      await this.#allocateAndStart(agent.id, safeRequest.idempotencyKey);
    } catch (error) {
      const routerError = asRouterError(error);
      this.logger.warn(
        { agent_id: agent.id, code: routerError.code, error: routerError.message },
        "Agent start was durably queued but could not start immediately"
      );
      const current = this.registry.getAgent(agent.id);
      if (["queued", "starting"].includes(current.status)) {
        this.registry.transitionAgent(
          agent.id,
          [current.status],
          "needs_attention",
          "start_needs_attention",
          { code: routerError.code, message: routerError.message }
        );
      }
    }
    return this.#startResponse(agent.id);
  }

  status(agentId: string, includeHistory = false) {
    const agent = this.registry.getAgent(agentId);
    const incarnation = agent.currentIncarnationId
      ? this.registry.getIncarnation(agent.currentIncarnationId)
      : null;
    const pendingInteraction = agent.pendingInteractionId
      ? this.registry.getPendingInteraction(agent.pendingInteractionId)
      : null;
    const runtime = incarnation ? this.registry.getRuntime(incarnation.runtimeId) : null;
    const events = this.registry.getEvents(agentId, 1);
    return {
      agentId: agent.id,
      status: agent.status,
      registryVersion: agent.registryVersion,
      activeIncarnation: incarnation,
      ...(includeHistory ? { incarnationHistory: this.registry.getIncarnations(agentId) } : {}),
      lastDurableEvent: events[0] ?? null,
      semanticOutputObserved: agent.semanticOutputSeen,
      sideEffectsObserved: agent.sideEffectsSeen,
      pendingInteraction,
      checkpointQuality: agent.checkpointQuality,
      runtime: runtime
        ? {
            id: runtime.profile.id,
            state: runtime.health.state,
            quota: runtime.health.quota,
            updatedAt: runtime.health.updatedAt
          }
        : null
    };
  }

  list(input: {
    status?: string | undefined;
    projectKey?: string | undefined;
    worktree?: string | undefined;
    runtimeId?: string | undefined;
    capabilityTier?: string | undefined;
    label?: { key: string; value: string } | undefined;
    afterVersion?: number | undefined;
    cursor?: string | undefined;
    limit: number;
  }) {
    const offset = decodeCursor(input.cursor);
    const filtered = this.registry.listAgents().filter((agent) => {
      if (input.status && agent.status !== input.status) return false;
      if (input.projectKey && agent.projectKey !== input.projectKey) return false;
      if (input.worktree && agent.worktreePath !== input.worktree) return false;
      if (input.capabilityTier && agent.routing.capabilityTier !== input.capabilityTier) return false;
      if (input.afterVersion !== undefined && agent.registryVersion <= input.afterVersion) return false;
      if (input.label && agent.labels[input.label.key] !== input.label.value) return false;
      if (input.runtimeId) {
        if (!agent.currentIncarnationId) return false;
        if (this.registry.getIncarnation(agent.currentIncarnationId).runtimeId !== input.runtimeId) return false;
      }
      return true;
    });
    const page = filtered.slice(offset, offset + input.limit);
    const nextOffset = offset + page.length;
    return {
      agents: page.map((agent) => ({
        agentId: agent.id,
        status: agent.status,
        projectKey: agent.projectKey,
        worktree: agent.worktreePath,
        registryVersion: agent.registryVersion,
        createdAt: agent.createdAt,
        updatedAt: agent.updatedAt
      })),
      nextCursor: nextOffset < filtered.length ? encodeCursor(nextOffset) : null,
      registryVersion: this.registry.registryVersion
    };
  }

  async wait(request: AgentWaitRequest) {
    const timeoutMs = Math.min(request.timeoutMs, this.config.maxWaitMs);
    const start = Date.now();
    const baseline = request.afterVersion ?? this.registry.registryVersion;
    let version = this.registry.registryVersion;
    while (true) {
      const agents = request.ids.map((id) => agentWakeState(this.registry.getAgent(id), baseline, request.wakeOn));
      const satisfied = request.mode === "all" ? agents.every((agent) => agent.satisfied) : agents.some((agent) => agent.satisfied);
      if (satisfied) {
        return {
          satisfied: true,
          timedOut: false,
          registryVersion: this.registry.registryVersion,
          agents: agents.map(({ satisfied: _satisfied, ...agent }) => agent)
        };
      }
      const remaining = timeoutMs - (Date.now() - start);
      if (remaining <= 0) {
        return {
          satisfied: false,
          timedOut: true,
          registryVersion: this.registry.registryVersion,
          agents: agents.map(({ satisfied: _satisfied, ...agent }) => agent)
        };
      }
      const next = await this.registry.waitForVersion(version, remaining);
      if (next === version) {
        const current = request.ids.map((id) => agentWakeState(this.registry.getAgent(id), baseline, request.wakeOn));
        return {
          satisfied: false,
          timedOut: true,
          registryVersion: next,
          agents: current.map(({ satisfied: _satisfied, ...agent }) => agent)
        };
      }
      version = next;
    }
  }

  async steer(callerScope: string, request: AgentSteerRequest) {
    const claim = this.registry.claimIdempotency<never>(
      callerScope,
      "agent_steer",
      request.idempotencyKey,
      request,
      this.config.idempotencyTtlMs
    );
    if (claim.state === "replay") return claim.result!;
    if (claim.state === "pending") return { accepted: false, state: "operation_pending" };
    try {
      const { agent, incarnation, adapter } = this.#active(request.agentId);
      if (agent.status !== "running") throw new RouterError("not_steerable", "Agent has no active regular turn");
      if (request.expectedIncarnationId && request.expectedIncarnationId !== incarnation.id) {
        throw new RouterError("stale_incarnation", "Expected incarnation does not match active incarnation");
      }
      if (!incarnation.threadId || !incarnation.turnId) throw new RouterError("not_steerable", "Active turn identifiers are unavailable");
      if (request.expectedTurnId && request.expectedTurnId !== incarnation.turnId) {
        throw new RouterError("stale_turn", "Expected turn does not match active turn");
      }
      if (!adapter.capabilities.steer) throw new RouterError("unsupported", "Runtime does not support active-turn steering");
      await adapter.steer(
        incarnation.threadId,
        incarnation.turnId,
        this.redactor.redact(request.input),
        request.idempotencyKey
      );
      this.registry.appendAndProject({
        eventId: newId("event"),
        runtimeId: incarnation.runtimeId,
        agentId: agent.id,
        incarnationId: incarnation.id,
        threadId: incarnation.threadId,
        turnId: incarnation.turnId,
        type: "router_command",
        payload: { command: "agent_steer", accepted: true },
        occurredAt: new Date().toISOString()
      });
      const result = { accepted: true, turnId: incarnation.turnId, registryVersion: this.registry.getAgent(agent.id).registryVersion };
      this.registry.completeIdempotency(callerScope, "agent_steer", request.idempotencyKey, result);
      return result;
    } catch (error) {
      this.registry.failIdempotency(callerScope, "agent_steer", request.idempotencyKey, serializeError(error));
      throw error;
    }
  }

  async continue(callerScope: string, request: AgentContinueRequest) {
    const claim = this.registry.claimIdempotency<never>(
      callerScope,
      "agent_continue",
      request.idempotencyKey,
      request,
      this.config.idempotencyTtlMs
    );
    if (claim.state === "replay") return claim.result!;
    if (claim.state === "pending") return { accepted: false, state: "operation_pending" };
    try {
      const { agent, incarnation, adapter } = this.#active(request.agentId);
      if (!(["completed", "interrupted"] as const).includes(agent.status as "completed" | "interrupted")) {
        throw new RouterError("invalid_transition", "Continuation requires a completed or interrupted agent boundary", {
          currentStatus: agent.status
        });
      }
      if (request.expectedResultVersion !== undefined && this.registry.latestResultVersion(agent.id) !== request.expectedResultVersion) {
        throw new RouterError("conflict", "Expected result version is stale");
      }
      if (!incarnation.threadId) throw new RouterError("handoff_required", "Original thread is unavailable");
      let decision;
      try {
        decision = this.#scheduler.selectForContinuation(agent, incarnation.runtimeId);
      } catch (error) {
        if (error instanceof RouterError && error.code === "no_eligible_runtime") {
          const runtime = this.registry.getRuntime(incarnation.runtimeId);
          if (runtime.health.state === "limited") {
            throw new RouterError("waiting_for_reset", "Original runtime is usage-limited; continuation retained affinity");
          }
          throw new RouterError("handoff_required", "Original runtime is unavailable; explicit handoff is required");
        }
        throw error;
      }
      if (decision.selectedRuntimeId !== incarnation.runtimeId) {
        throw new RouterError("handoff_required", "Continuation cannot silently switch runtime");
      }
      this.registry.recordRoutingDecision(agent.id, incarnation.id, decision);
      let fencingToken: number | undefined;
      if (agent.worktreeMode === "write") {
        fencingToken = this.registry.acquireWriteLease(
          agent.worktreePath,
          agent.id,
          incarnation.id,
          this.config.leaseTtlMs
        );
        this.#startLeaseRenewal(agent.id, incarnation.id, agent.worktreePath, fencingToken);
      }
      this.registry.transitionAgent(agent.id, [agent.status], "starting", "agent_continue");
      const started = await adapter.continueTurn({
        agentId: agent.id,
        incarnationId: incarnation.id,
        idempotencyKey: request.idempotencyKey,
        threadId: incarnation.threadId,
        input: this.redactor.redact(request.input),
        worktreePath: agent.worktreePath,
        worktreeMode: agent.worktreeMode,
        ...(agent.routing.model ? { model: agent.routing.model } : {}),
        ...(fencingToken === undefined ? {} : { fencingToken })
      });
      this.registry.setRuntimeIdentifiers(incarnation.id, {
        threadId: started.threadId,
        turnId: started.turnId,
        status: "turn_running"
      });
      const result = { accepted: true, ...started, registryVersion: this.registry.getAgent(agent.id).registryVersion };
      this.registry.completeIdempotency(callerScope, "agent_continue", request.idempotencyKey, result);
      return result;
    } catch (error) {
      this.registry.failIdempotency(callerScope, "agent_continue", request.idempotencyKey, serializeError(error));
      throw error;
    }
  }

  async cancel(callerScope: string, request: AgentCancelRequest) {
    const claim = this.registry.claimIdempotency<never>(
      callerScope,
      "agent_cancel",
      request.idempotencyKey,
      request,
      this.config.idempotencyTtlMs
    );
    if (claim.state === "replay") return claim.result!;
    if (claim.state === "pending") return { accepted: false, state: "operation_pending" };
    try {
      const { agent, incarnation, adapter } = this.#active(request.agentId);
      if (!incarnation.threadId || !incarnation.turnId) throw new RouterError("conflict", "No active turn to cancel");
      if (request.expectedTurnId && request.expectedTurnId !== incarnation.turnId) {
        throw new RouterError("stale_turn", "Expected turn does not match active turn");
      }
      if (!adapter.capabilities.interrupt) throw new RouterError("unsupported", "Runtime does not support interruption");
      this.registry.transitionAgent(agent.id, ["running", "needs_attention"], "cancelling", "agent_cancel", {
        cleanBackgroundTerminals: request.cleanBackgroundTerminals
      });
      await adapter.interrupt(incarnation.threadId, incarnation.turnId);
      const terminals = request.cleanBackgroundTerminals
        ? await adapter.inspectBackgroundTerminals(incarnation.threadId)
        : null;
      const result = {
        accepted: true,
        status: "cancelling",
        turnId: incarnation.turnId,
        backgroundTerminals: terminals
      };
      this.registry.completeIdempotency(callerScope, "agent_cancel", request.idempotencyKey, result);
      return result;
    } catch (error) {
      this.registry.failIdempotency(callerScope, "agent_cancel", request.idempotencyKey, serializeError(error));
      throw error;
    }
  }

  async respond(callerScope: string, request: AgentRespondRequest) {
    const claim = this.registry.claimIdempotency<never>(
      callerScope,
      "agent_respond",
      request.idempotencyKey,
      request,
      this.config.idempotencyTtlMs
    );
    if (claim.state === "replay") return claim.result!;
    if (claim.state === "pending") return { accepted: false, state: "operation_pending" };
    try {
      const agent = this.registry.getAgent(request.agentId);
      const interaction = this.registry.getPendingInteraction(request.interactionId);
      if (
        interaction.agentId !== agent.id ||
        interaction.state !== "pending" ||
        interaction.incarnationId !== agent.currentIncarnationId ||
        interaction.id !== agent.pendingInteractionId
      ) {
        throw new RouterError("conflict", "Interaction is not pending for this agent");
      }
      assertInteractionAuthority(agent.authority, interaction.params, request.response);
      const adapter = this.#adapter(interaction.runtimeId);
      await adapter.respond(
        interaction.backendRequestId,
        interaction.method,
        request.response,
        interaction.params
      );
      this.registry.resolveInteraction(interaction.id, request.response);
      const result = { accepted: true, interactionId: interaction.id };
      this.registry.completeIdempotency(callerScope, "agent_respond", request.idempotencyKey, result);
      return result;
    } catch (error) {
      this.registry.failIdempotency(callerScope, "agent_respond", request.idempotencyKey, serializeError(error));
      throw error;
    }
  }

  async handoff(callerScope: string, request: AgentHandoffRequest) {
    const claim = this.registry.claimIdempotency<never>(
      callerScope,
      "agent_handoff",
      request.idempotencyKey,
      request,
      this.config.idempotencyTtlMs
    );
    if (claim.state === "replay") return claim.result!;
    if (claim.state === "pending") return { accepted: false, state: "operation_pending" };
    try {
      const { agent, incarnation: previous, adapter: previousAdapter } = this.#active(request.agentId);
      const previousWasTerminal =
        isTerminalStatus(agent.status) ||
        (["completed", "failed", "interrupted"] as const).includes(
          previous.status as "completed" | "failed" | "interrupted"
        );
      this.registry.transitionAgent(
        agent.id,
        ["running", "needs_attention", "failed", "interrupted", "waiting_for_reset", "completed"],
        "handing_off",
        "agent_handoff",
        { reason: request.reason }
      );
      if (!previousWasTerminal) this.registry.setRuntimeIdentifiers(previous.id, { status: "quiescing" });
      if (
        !previousWasTerminal &&
        previous.threadId &&
        previous.turnId &&
        ["running", "needs_attention"].includes(agent.status)
      ) {
        await previousAdapter.interrupt(previous.threadId, previous.turnId).catch(() => undefined);
        await this.#waitUntilTerminal(agent.id, 5_000);
      }
      const reconciled = previous.threadId
        ? await previousAdapter.reconcile(previous.threadId, previous.turnId).catch((error) => ({
            state: "unknown" as const,
            threadId: previous.threadId!,
            turnId: previous.turnId,
            evidence: { error: error instanceof Error ? error.message : String(error) }
          }))
        : { state: "unknown" as const, threadId: "", turnId: null, evidence: {} };
      const terminals = previous.threadId
        ? await previousAdapter.inspectBackgroundTerminals(previous.threadId).catch((error) => ({
            clean: false,
            terminals: [
              {
                id: "unknown",
                status: "inspection_failed",
                command: error instanceof Error ? error.message : String(error)
              }
            ],
            inspectedAt: new Date().toISOString()
          }))
        : { clean: false, terminals: [], inspectedAt: new Date().toISOString() };
      const worktree = await this.#worktrees.inspect(agent.worktreePath);
      const terminalConfirmed =
        previousWasTerminal ||
        reconciled.state === "terminal" ||
        isTerminalStatus(this.registry.getAgent(agent.id).status);
      const previousAfterReconciliation = this.registry.getIncarnation(previous.id);
      if (
        previousAfterReconciliation.status === "quiescing" &&
        reconciled.state === "terminal" &&
        reconciled.turnStatus
      ) {
        this.registry.setRuntimeIdentifiers(previous.id, { status: reconciled.turnStatus });
      }
      const clean = terminalConfirmed && terminals.clean;
      const quality = clean ? "clean" : "unclean";
      const checkpointPayload = {
        reason: request.reason,
        terminalConfirmed,
        reconciliation: reconciled,
        backgroundTerminals: terminals,
        worktree,
        semanticOutputSeen: agent.semanticOutputSeen,
        sideEffectsSeen: agent.sideEffectsSeen,
        requiredVerification: clean
          ? ["Inspect actual worktree before editing"]
          : ["Confirm old writer is stopped", "Inspect background processes", "Inspect actual worktree and external effects"]
      };
      const checkpointId = this.registry.createCheckpoint(agent.id, previous.id, quality, checkpointPayload);
      if (!clean && !request.allowUnclean) {
        const current = this.registry.getAgent(agent.id);
        this.registry.transitionAgent(agent.id, [current.status], "needs_attention", "unclean_handoff_blocked", {
          checkpointId
        });
        throw new RouterError("conflict", "Unclean checkpoint requires explicit allowUnclean authorization", {
          checkpointId
        });
      }
      if (!terminalConfirmed && this.registry.getIncarnation(previous.id).status === "quiescing") {
        this.registry.setRuntimeIdentifiers(previous.id, { status: "lost" });
      }
      if (agent.worktreeMode === "write" && previous.fencingToken !== null) {
        this.#stopLeaseRenewal(previous.id);
        this.registry.releaseWriteLease(agent.worktreePath, previous.id, previous.fencingToken);
      }
      const decision = this.#scheduler.selectForHandoff(
        agent,
        request.targetRuntimeId,
        request.targetRuntimeId ? [] : [previous.runtimeId]
      );
      const next = this.registry.createIncarnation(agent.id, decision.selectedRuntimeId);
      this.registry.recordRoutingDecision(agent.id, next.id, decision);
      let fencingToken: number | undefined;
      if (agent.worktreeMode === "write") {
        fencingToken = this.registry.acquireWriteLease(
          agent.worktreePath,
          agent.id,
          next.id,
          this.config.leaseTtlMs
        );
        this.#startLeaseRenewal(agent.id, next.id, agent.worktreePath, fencingToken);
      }
      const adapter = this.#adapter(next.runtimeId);
      const hydration = {
        checkpointId,
        quality,
        ...checkpointPayload,
        additionalInstruction: this.redactor.redact(request.additionalInstruction)
      };
      const started = await adapter.startTask({
        agentId: agent.id,
        incarnationId: next.id,
        idempotencyKey: request.idempotencyKey,
        task: agent.task,
        worktreePath: agent.worktreePath,
        worktreeMode: agent.worktreeMode,
        authority: agent.authority,
        ...(agent.routing.model ? { model: agent.routing.model } : {}),
        ...(fencingToken === undefined ? {} : { fencingToken }),
        hydration
      });
      this.registry.setRuntimeIdentifiers(next.id, {
        threadId: started.threadId,
        turnId: started.turnId,
        status: "turn_running"
      });
      const result = {
        accepted: true,
        agentId: agent.id,
        checkpointId,
        checkpointQuality: quality,
        previousIncarnationId: previous.id,
        incarnation: { id: next.id, runtimeId: next.runtimeId, ...started }
      };
      this.registry.completeIdempotency(callerScope, "agent_handoff", request.idempotencyKey, result);
      return result;
    } catch (error) {
      this.registry.failIdempotency(callerScope, "agent_handoff", request.idempotencyKey, serializeError(error));
      const current = this.registry.getAgent(request.agentId);
      if (["handing_off", "starting"].includes(current.status)) {
        this.registry.transitionAgent(
          current.id,
          [current.status],
          "needs_attention",
          "handoff_failed",
          serializeError(error)
        );
      }
      throw error;
    }
  }

  result(agentId: string, version?: number, detail: "summary" | "evidence" | "debug" = "summary") {
    const result = this.registry.getResult(agentId, version);
    if (detail === "summary") return result;
    const response: Record<string, unknown> = { ...result };
    if (detail === "debug") response.events = this.registry.getEvents(agentId, 100);
    return this.redactor.redact(response);
  }

  diagnostics(): Record<string, unknown> {
    return this.redactor.redact(this.registry.diagnostics());
  }

  async reconcileOnStartup(): Promise<void> {
    for (const agent of this.registry.listAgents().filter((item) => NONTERMINAL.includes(item.status as never))) {
      if (!agent.currentIncarnationId) continue;
      let incarnation = this.registry.getIncarnation(agent.currentIncarnationId);
      if (!incarnation.threadId) {
        const discoveryAdapter = this.#adapters.get(incarnation.runtimeId);
        const discovered = discoveryAdapter
          ? await discoveryAdapter
              .findThreadByCorrelation(agent.id, incarnation.id, agent.worktreePath)
              .catch(() => null)
          : null;
        if (discovered) {
          incarnation = this.registry.setRuntimeIdentifiers(incarnation.id, { threadId: discovered });
        } else {
          if (agent.status !== "queued" && agent.status !== "needs_attention") {
            this.registry.transitionAgent(agent.id, [agent.status], "needs_attention", "reconcile_missing_thread");
          }
          continue;
        }
      }
      const adapter = this.#adapters.get(incarnation.runtimeId);
      if (!adapter || adapter.state === "offline") continue;
      const threadId = incarnation.threadId;
      if (!threadId) continue;
      adapter.bindContext(agent.id, incarnation.id, threadId, incarnation.turnId);
      const reconciled = await adapter.reconcile(threadId, incarnation.turnId);
      if (reconciled.turnId && reconciled.turnId !== incarnation.turnId) {
        incarnation = this.registry.setRuntimeIdentifiers(incarnation.id, { turnId: reconciled.turnId });
        adapter.bindContext(agent.id, incarnation.id, threadId, reconciled.turnId);
      }
      this.registry.appendAndProject({
        eventId: newId("event"),
        runtimeId: incarnation.runtimeId,
        agentId: agent.id,
        incarnationId: incarnation.id,
        threadId,
        ...(incarnation.turnId ? { turnId: incarnation.turnId } : {}),
        type: "reconciliation",
        payload: reconciled as unknown as Record<string, unknown>,
        occurredAt: new Date().toISOString()
      });
      if (reconciled.state === "terminal" && reconciled.turnStatus) {
        await this.#handleRuntimeEvent({
          eventId: newId("event"),
          backendEventKey: `${incarnation.runtimeId}:reconciled_terminal:${incarnation.turnId ?? threadId}:${reconciled.turnStatus}`,
          runtimeId: incarnation.runtimeId,
          agentId: agent.id,
          incarnationId: incarnation.id,
          threadId,
          ...(incarnation.turnId ? { turnId: incarnation.turnId } : {}),
          type: "turn_completed",
          payload: { status: reconciled.turnStatus, terminalReason: "reconciled" },
          occurredAt: new Date().toISOString()
        });
      } else if (reconciled.state === "active" && reconciled.turnId) {
        await this.#handleRuntimeEvent({
          eventId: newId("event"),
          backendEventKey: `${incarnation.runtimeId}:reconciled_active:${reconciled.turnId}`,
          runtimeId: incarnation.runtimeId,
          agentId: agent.id,
          incarnationId: incarnation.id,
          threadId,
          turnId: reconciled.turnId,
          type: "turn_started",
          payload: { turnId: reconciled.turnId, reconciled: true },
          occurredAt: new Date().toISOString()
        });
      }
    }
  }

  async #allocateAndStart(agentId: string, idempotencyKey: string, hydration?: Record<string, unknown>) {
    const agent = this.registry.getAgent(agentId);
    const request: AgentStartRequest = {
      idempotencyKey,
      task: agent.task,
      projectKey: agent.projectKey,
      worktree: { path: agent.worktreePath, mode: agent.worktreeMode },
      routing: agent.routing,
      authority: agent.authority,
      recoveryPolicy: agent.recoveryPolicy,
      labels: agent.labels
    };
    const decision = this.#scheduler.selectForStart(request);
    const incarnation = this.registry.createIncarnation(agent.id, decision.selectedRuntimeId);
    this.registry.recordRoutingDecision(agent.id, incarnation.id, decision);
    let fencingToken: number | undefined;
    if (agent.worktreeMode === "write") {
      fencingToken = this.registry.acquireWriteLease(
        agent.worktreePath,
        agent.id,
        incarnation.id,
        this.config.leaseTtlMs
      );
      this.#startLeaseRenewal(agent.id, incarnation.id, agent.worktreePath, fencingToken);
    }
    const context: RuntimeTaskContext = {
      agentId: agent.id,
      incarnationId: incarnation.id,
      idempotencyKey,
      task: agent.task,
      worktreePath: agent.worktreePath,
      worktreeMode: agent.worktreeMode,
      authority: agent.authority,
      ...(agent.routing.model ? { model: agent.routing.model } : {}),
      ...(fencingToken === undefined ? {} : { fencingToken }),
      ...(hydration ? { hydration } : {})
    };
    const started = await this.#adapter(incarnation.runtimeId).startTask(context);
    this.registry.setRuntimeIdentifiers(incarnation.id, {
      threadId: started.threadId,
      turnId: started.turnId,
      status: "turn_running"
    });
    return started;
  }

  #startResponse(agentId: string) {
    const agent = this.registry.getAgent(agentId);
    const incarnation = agent.currentIncarnationId
      ? this.registry.getIncarnation(agent.currentIncarnationId)
      : null;
    return {
      agentId: agent.id,
      status: agent.status,
      registryVersion: agent.registryVersion,
      ...(incarnation
        ? {
            incarnation: {
              id: incarnation.id,
              runtimeId: incarnation.runtimeId,
              ...(incarnation.threadId ? { threadId: incarnation.threadId } : {}),
              ...(incarnation.turnId ? { turnId: incarnation.turnId } : {})
            }
          }
        : {})
    };
  }

  #active(agentId: string) {
    const agent = this.registry.getAgent(agentId);
    if (!agent.currentIncarnationId) throw new RouterError("conflict", "Agent has no active incarnation");
    const incarnation = this.registry.getIncarnation(agent.currentIncarnationId);
    return { agent, incarnation, adapter: this.#adapter(incarnation.runtimeId) };
  }

  #adapter(runtimeId: string): RuntimeAdapter {
    const adapter = this.#adapters.get(runtimeId);
    if (!adapter) throw new RouterError("runtime_unavailable", `Runtime adapter ${runtimeId} is unavailable`);
    return adapter;
  }

  #registerRuntimes(): void {
    for (const config of this.config.runtimes) {
      const profile: RuntimeProfile = {
        id: config.id,
        adapter: config.adapter,
        provider: config.provider,
        capabilityTiers: config.capabilityTiers,
        allowedModels: config.allowedModels,
        maxConcurrency: config.maxConcurrency,
        policyTags: config.policyTags,
        enabled: config.enabled
      };
      this.registry.registerRuntime(profile);
    }
  }

  #subscribeAdapters(): void {
    for (const adapter of this.#adapters.values()) {
      this.#unsubscribers.push(adapter.onEvent((event) => this.#handleRuntimeEvent(event)));
    }
  }

  async #connectRuntimes(): Promise<void> {
    await Promise.all(
      this.config.runtimes
        .filter((runtime) => runtime.enabled)
        .map(async (runtime) => {
          const adapter = this.#adapters.get(runtime.id);
          if (!adapter) return;
          try {
            await adapter.connect();
            this.registry.updateRuntimeHealth(runtime.id, {
              initialized: true,
              state: "ready"
            });
          } catch (error) {
            this.registry.updateRuntimeHealth(runtime.id, {
              initialized: false,
              state: "offline"
            });
            this.logger.error(
              { runtime_id: runtime.id, error: error instanceof Error ? error.message : String(error) },
              "Runtime initialization failed"
            );
          }
        })
    );
  }

  async #handleRuntimeEvent(rawEvent: NormalizedRuntimeEvent): Promise<void> {
    const event = this.redactor.redact(rawEvent);
    const projection = this.registry.appendAndProject(event);
    if (!projection.inserted) return;
    const eventAgent = event.agentId ? this.registry.getAgent(event.agentId) : null;
    const targetsCurrentIncarnation = Boolean(
      eventAgent &&
      (!event.incarnationId || event.incarnationId === eventAgent.currentIncarnationId)
    );
    if (event.type === "runtime_disconnected") {
      this.registry.updateRuntimeHealth(event.runtimeId, { state: "degraded", initialized: false });
    }
    if (event.type === "runtime_error" && event.payload.class === "usage_limit") {
      this.registry.updateRuntimeHealth(event.runtimeId, { state: "limited" });
      if (eventAgent && targetsCurrentIncarnation) {
        const agent = eventAgent;
        if (agent.recoveryPolicy === "wait_for_reset" && ["running", "needs_attention"].includes(agent.status)) {
          this.registry.transitionAgent(
            agent.id,
            [agent.status],
            "waiting_for_reset",
            "usage_limit_wait_for_reset"
          );
        }
      }
    }
    if (event.type === "rate_limits_updated") {
      const runtime = this.registry.getRuntime(event.runtimeId);
      const used = Math.max(
        runtime.health.quota?.primary?.usedPercent ?? 0,
        runtime.health.quota?.secondary?.usedPercent ?? 0
      );
      const nextState =
        used >= 100
          ? "limited"
          : used >= 90
            ? "draining"
            : used < 85 && ["limited", "draining"].includes(runtime.health.state)
              ? "ready"
              : runtime.health.state;
      if (nextState !== runtime.health.state) {
        this.registry.updateRuntimeHealth(event.runtimeId, { state: nextState });
      }
    }
    if (event.type === "turn_completed" && event.agentId) {
      if (!targetsCurrentIncarnation) return;
      const currentAgent = this.registry.getAgent(event.agentId);
      const currentIncarnation = currentAgent.currentIncarnationId
        ? this.registry.getIncarnation(currentAgent.currentIncarnationId)
        : null;
      if (event.turnId && currentIncarnation?.turnId && event.turnId !== currentIncarnation.turnId) return;
      const distilled = await this.#distiller.distill(event.agentId);
      const { resultVersion: _unused, ...withoutVersion } = distilled;
      this.registry.saveResult(withoutVersion);
      await this.#releaseTerminalLeaseIfClean(event.agentId);
      const agent = this.registry.getAgent(event.agentId);
      const recentUsageLimit = this.registry
        .getEvents(event.agentId, 20)
        .some(
          (entry) =>
            entry.type === "runtime_error" &&
            (entry.payload as Record<string, unknown>).class === "usage_limit"
        );
      if (recentUsageLimit && agent.recoveryPolicy === "wait_for_reset" && agent.status === "failed") {
        this.registry.transitionAgent(
          agent.id,
          ["failed"],
          "waiting_for_reset",
          "usage_limit_wait_for_reset"
        );
      }
      if (recentUsageLimit && agent.recoveryPolicy === "auto_handoff_if_clean" && agent.status === "failed") {
        setImmediate(() => {
          void this.handoff(`recovery:${agent.id}`, {
            agentId: agent.id,
            idempotencyKey: `usage-limit:${event.eventId}`,
            reason: "quota",
            allowUnclean: false
          }).catch((error) => {
            this.logger.warn(
              { agent_id: agent.id, error: error instanceof Error ? error.message : String(error) },
              "Automatic clean handoff could not complete"
            );
          });
        });
      }
    }
  }

  async #waitUntilTerminal(agentId: string, timeoutMs: number): Promise<void> {
    const started = Date.now();
    let version = this.registry.registryVersion;
    while (!isTerminalStatus(this.registry.getAgent(agentId).status) && Date.now() - started < timeoutMs) {
      version = await this.registry.waitForVersion(version, timeoutMs - (Date.now() - started));
    }
  }

  async #releaseTerminalLeaseIfClean(agentId: string): Promise<void> {
    const agent = this.registry.getAgent(agentId);
    if (agent.worktreeMode !== "write" || !agent.currentIncarnationId) return;
    const incarnation = this.registry.getIncarnation(agent.currentIncarnationId);
    if (!incarnation.threadId || incarnation.fencingToken === null) return;
    const lease = this.registry.getLeaseForIncarnation(incarnation.id);
    if (!lease) {
      this.#stopLeaseRenewal(incarnation.id);
      return;
    }
    const adapter = this.#adapters.get(incarnation.runtimeId);
    const terminals = adapter
      ? await adapter.inspectBackgroundTerminals(incarnation.threadId).catch((error) => ({
          clean: false,
          terminals: [
            {
              id: "unknown",
              status: "inspection_failed",
              command: error instanceof Error ? error.message : String(error)
            }
          ],
          inspectedAt: new Date().toISOString()
        }))
      : {
          clean: false,
          terminals: [{ id: "unknown", status: "runtime_unavailable" }],
          inspectedAt: new Date().toISOString()
        };
    if (terminals.clean) {
      this.#stopLeaseRenewal(incarnation.id);
      this.registry.releaseWriteLease(
        agent.worktreePath,
        incarnation.id,
        incarnation.fencingToken
      );
      return;
    }
    if (isTerminalStatus(agent.status)) {
      this.registry.transitionAgent(
        agent.id,
        [agent.status],
        "needs_attention",
        "background_terminals_detected",
        { terminals: terminals.terminals }
      );
    }
  }

  #restoreLeaseRenewals(): void {
    for (const agent of this.registry.listAgents()) {
      if (agent.worktreeMode !== "write" || !agent.currentIncarnationId) continue;
      const lease = this.registry.getLeaseForIncarnation(agent.currentIncarnationId);
      if (!lease) continue;
      if (new Date(lease.expiresAt).getTime() <= Date.now()) {
        if (!isTerminalStatus(agent.status) && agent.status !== "needs_attention") {
          this.registry.transitionAgent(
            agent.id,
            [agent.status],
            "needs_attention",
            "expired_writer_lease_on_restart"
          );
        }
        continue;
      }
      this.#startLeaseRenewal(
        agent.id,
        lease.incarnationId,
        lease.canonicalPath,
        lease.fencingToken
      );
    }
  }

  #startLeaseRenewal(
    agentId: string,
    incarnationId: string,
    worktreePath: string,
    fencingToken: number
  ): void {
    this.#stopLeaseRenewal(incarnationId);
    const renew = () => {
      try {
        this.registry.renewWriteLease(
          worktreePath,
          incarnationId,
          fencingToken,
          this.config.leaseTtlMs
        );
      } catch (error) {
        this.#stopLeaseRenewal(incarnationId);
        const agent = this.registry.getAgent(agentId);
        if (!isTerminalStatus(agent.status) && agent.status !== "needs_attention") {
          this.registry.transitionAgent(
            agent.id,
            [agent.status],
            "needs_attention",
            "writer_lease_fenced",
            serializeError(error)
          );
        }
      }
    };
    renew();
    const timer = setInterval(renew, Math.max(25, Math.floor(this.config.leaseTtlMs / 3)));
    timer.unref();
    this.#leaseTimers.set(incarnationId, timer);
  }

  #stopLeaseRenewal(incarnationId: string): void {
    const timer = this.#leaseTimers.get(incarnationId);
    if (timer) clearInterval(timer);
    this.#leaseTimers.delete(incarnationId);
  }
}

function createAdapters(
  runtimes: RuntimeConfig[],
  logger: Logger,
  redactor: SecretRedactor
): Map<string, RuntimeAdapter> {
  const adapters = new Map<string, RuntimeAdapter>();
  for (const runtime of runtimes) {
    if (runtime.adapter === "codex_app_server") {
      adapters.set(runtime.id, new CodexAppServerAdapter(runtime, logger, redactor));
    } else {
      adapters.set(runtime.id, new ExternalProcessAdapter(runtime, logger, redactor));
    }
  }
  return adapters;
}

function assertInteractionAuthority(
  authority: { allowPush: boolean; allowMerge: boolean; allowDeploy: boolean; allowExternalWrites: boolean },
  params: Record<string, unknown>,
  response: AgentRespondRequest["response"]
): void {
  if (response.type !== "approval" || response.decision !== "approve_once") return;
  const serialized = collectStrings(params).join(" ").toLowerCase();
  if (/git\s+push|gh\s+pr\s+create/.test(serialized) && !authority.allowPush) {
    throw new RouterError("unauthorized", "Original authority does not allow push operations");
  }
  if (/gh\s+pr\s+merge|git\s+merge/.test(serialized) && !authority.allowMerge) {
    throw new RouterError("unauthorized", "Original authority does not allow merge operations");
  }
  if (/deploy|release|publish/.test(serialized) && !authority.allowDeploy) {
    throw new RouterError("unauthorized", "Original authority does not allow deployment operations");
  }
  if (/curl.+(-x\s*post|--request\s+post)|terraform\s+apply/.test(serialized) && !authority.allowExternalWrites) {
    throw new RouterError("unauthorized", "Original authority does not allow external writes");
  }
}

function collectStrings(value: unknown): string[] {
  if (typeof value === "string") return [value];
  if (Array.isArray(value)) return value.flatMap(collectStrings);
  if (value && typeof value === "object") {
    return Object.values(value as Record<string, unknown>).flatMap(collectStrings);
  }
  return [];
}

function serializeError(error: unknown): Record<string, unknown> {
  const normalized = asRouterError(error);
  return { code: normalized.code, message: normalized.message, details: normalized.details };
}

function encodeCursor(offset: number): string {
  return Buffer.from(JSON.stringify({ offset }), "utf8").toString("base64url");
}

function decodeCursor(cursor: string | undefined): number {
  if (!cursor) return 0;
  try {
    const parsed = JSON.parse(Buffer.from(cursor, "base64url").toString("utf8")) as { offset?: unknown };
    if (typeof parsed.offset === "number" && Number.isInteger(parsed.offset) && parsed.offset >= 0) return parsed.offset;
  } catch {
    // Report a stable product error below.
  }
  throw new RouterError("conflict", "Invalid pagination cursor");
}
