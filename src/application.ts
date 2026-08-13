import type { RouterConfig, RuntimeConfig } from "./config.js";
import type {
  AgentCancelRequest,
  AgentContinueRequest,
  AgentHandoffRequest,
  AgentRespondRequest,
  AgentStartRequest,
  AgentSteerRequest,
  AgentStatus,
  AgentWaitRequest,
  PendingInteraction
} from "./domain.js";
import { RouterError } from "./errors.js";
import type { CodexRouter } from "./router.js";
import type { SecretRedactor } from "./security.js";

export const WEB_SCHEMA_VERSION = 1;
export const ROUTER_VERSION = "0.1.0";

export class RouterApplicationService {
  constructor(
    readonly router: CodexRouter,
    private readonly redactor: SecretRedactor
  ) {}

  start(callerScope: string, request: AgentStartRequest) {
    return this.router.start(callerScope, request);
  }

  status(agentId: string, includeHistory = false) {
    return this.router.status(agentId, includeHistory);
  }

  list(input: Parameters<CodexRouter["list"]>[0]) {
    return this.router.list(input);
  }

  wait(request: AgentWaitRequest) {
    return this.router.wait(request);
  }

  steer(callerScope: string, request: AgentSteerRequest) {
    return this.router.steer(callerScope, request);
  }

  continue(callerScope: string, request: AgentContinueRequest) {
    return this.router.continue(callerScope, request);
  }

  cancel(callerScope: string, request: AgentCancelRequest) {
    return this.router.cancel(callerScope, request);
  }

  respond(callerScope: string, request: AgentRespondRequest) {
    return this.router.respond(callerScope, request);
  }

  handoff(callerScope: string, request: AgentHandoffRequest) {
    return this.router.handoff(callerScope, request);
  }

  result(agentId: string, version?: number, detail: "summary" | "evidence" | "debug" = "summary") {
    return this.router.result(agentId, version, detail);
  }

  diagnostics() {
    return this.router.diagnostics();
  }

  bootstrap(role: "viewer" | "operator" | "administrator" = "administrator") {
    const agents = this.#agents();
    const runtimes = this.runtimes();
    const interactions = this.interactions("pending");
    const diagnostics = this.diagnostics();
    return this.redactor.redact({
      schemaVersion: WEB_SCHEMA_VERSION,
      router: {
        version: ROUTER_VERSION,
        registryVersion: this.router.registry.registryVersion,
        oldestResumableVersion: 0,
        generatedAt: new Date().toISOString()
      },
      session: { role },
      summary: {
        agentsByStatus: countBy(agents, (agent) => agent.status),
        active: agents.filter((agent) => !isTerminal(agent.status)).length,
        attention: interactions.length,
        terminal: agents.filter((agent) => isTerminal(agent.status)).length,
        runtimeReady: runtimes.filter((runtime) => runtime.health.state === "ready").length,
        runtimeTotal: runtimes.length
      },
      agents: agents.slice(0, 100),
      runtimes,
      interactions,
      diagnostics
    });
  }

  agents(input: {
    status?: string;
    projectKey?: string;
    runtimeId?: string;
    worktree?: string;
    limit?: number;
  } = {}) {
    const limit = Math.min(Math.max(input.limit ?? 100, 1), 1_000);
    return this.redactor.redact(
      this.#agents()
        .filter((agent) => !input.status || agent.status === input.status)
        .filter((agent) => !input.projectKey || agent.projectKey === input.projectKey)
        .filter((agent) => !input.runtimeId || agent.runtime?.id === input.runtimeId)
        .filter((agent) => !input.worktree || agent.worktree.path === input.worktree)
        .slice(0, limit)
    );
  }

  agent(agentId: string) {
    const agent = this.router.registry.getAgent(agentId);
    const incarnations = this.router.registry.getIncarnations(agentId);
    const activeIncarnation = agent.currentIncarnationId
      ? this.router.registry.getIncarnation(agent.currentIncarnationId)
      : null;
    const runtime = activeIncarnation ? this.router.registry.getRuntime(activeIncarnation.runtimeId) : null;
    const latestCheckpoint = this.router.registry.getLatestCheckpoint(agentId);
    const routingDecisions = this.router.registry.listRoutingDecisions(agentId);
    const pendingInteraction = agent.pendingInteractionId
      ? this.router.registry.getPendingInteraction(agent.pendingInteractionId)
      : null;
    return this.redactor.redact({
      ...agent,
      taskSummary: taskSummary(agent.task),
      worktree: { path: agent.worktreePath, mode: agent.worktreeMode },
      activeIncarnation,
      incarnations,
      runtime: runtime ? { ...runtime.profile, health: runtime.health } : null,
      pendingInteraction,
      latestCheckpoint,
      routingDecisions,
      latestResultVersion: this.router.registry.latestResultVersion(agentId)
    });
  }

  agentEvents(agentId: string, limit = 100) {
    this.router.registry.getAgent(agentId);
    return this.redactor.redact(this.router.registry.getEvents(agentId, Math.min(Math.max(limit, 1), 500)));
  }

  results(agentId: string) {
    this.router.registry.getAgent(agentId);
    return this.redactor.redact(this.router.registry.listResults(agentId));
  }

  interactions(state?: PendingInteraction["state"]) {
    return this.redactor.redact(this.router.registry.listInteractions(state));
  }

  runtimes() {
    return this.redactor.redact(
      this.router.registry.listRuntimes().map((entry) => {
        const config = this.#runtimeConfig(entry.profile.id);
        return {
          id: entry.profile.id,
          adapter: entry.profile.adapter,
          provider: entry.profile.provider,
          capabilityTiers: entry.profile.capabilityTiers,
          allowedModels: entry.profile.allowedModels,
          maxConcurrency: entry.profile.maxConcurrency,
          policyTags: entry.profile.policyTags,
          enabled: entry.profile.enabled,
          activeCount: entry.activeCount,
          health: entry.health,
          modelPolicy: modelPolicy(config),
          authentication: authenticationProjection(config)
        };
      })
    );
  }

  runtime(runtimeId: string) {
    const runtime = this.runtimes().find((entry) => entry.id === runtimeId);
    if (!runtime) throw new RouterError("not_found", `Runtime ${runtimeId} was not found`);
    const agents = this.#agents().filter((agent) => agent.runtime?.id === runtimeId);
    return { ...runtime, agents };
  }

  models(runtimeId?: string) {
    const runtimes = runtimeId ? [this.runtime(runtimeId)] : this.runtimes();
    return runtimes.map((runtime) => ({
      runtimeId: runtime.id,
      catalog: {
        state: "unavailable" as const,
        source: "runtime_adapter",
        message: "This adapter does not expose a runtime-authoritative model catalog. No fallback catalog was invented.",
        refreshedAt: null,
        models: []
      },
      policy: runtime.modelPolicy
    }));
  }

  worktrees() {
    return this.redactor.redact(this.router.registry.listWorktrees());
  }

  events(input: {
    agentId?: string;
    runtimeId?: string;
    eventType?: string;
    beforeSequence?: number;
    limit?: number;
  } = {}) {
    return this.redactor.redact(this.router.registry.listEvents(input));
  }

  config() {
    return this.redactor.redact(safeConfig(this.router.config));
  }

  async waitForVersion(afterVersion: number, timeoutMs: number) {
    return this.router.registry.waitForVersion(afterVersion, timeoutMs);
  }

  #runtimeConfig(runtimeId: string): RuntimeConfig {
    const config = this.router.config.runtimes.find((entry) => entry.id === runtimeId);
    if (!config) throw new RouterError("not_found", `Runtime ${runtimeId} was not found`);
    return config;
  }

  #agents() {
    return this.router.registry.listAgents().map((agent) => {
      const incarnation = agent.currentIncarnationId
        ? this.router.registry.getIncarnation(agent.currentIncarnationId)
        : null;
      const runtime = incarnation ? this.router.registry.getRuntime(incarnation.runtimeId) : null;
      return {
        id: agent.id,
        status: agent.status,
        taskSummary: taskSummary(agent.task),
        projectKey: agent.projectKey,
        worktree: { path: agent.worktreePath, mode: agent.worktreeMode },
        routing: agent.routing,
        labels: agent.labels,
        authority: agent.authority,
        recoveryPolicy: agent.recoveryPolicy,
        registryVersion: agent.registryVersion,
        semanticOutputObserved: agent.semanticOutputSeen,
        sideEffectsObserved: agent.sideEffectsSeen,
        pendingInteractionId: agent.pendingInteractionId,
        checkpointQuality: agent.checkpointQuality,
        incarnation,
        runtime: runtime
          ? {
              id: runtime.profile.id,
              provider: runtime.profile.provider,
              state: runtime.health.state,
              model: agent.routing.model ?? null
            }
          : null,
        createdAt: agent.createdAt,
        updatedAt: agent.updatedAt
      };
    });
  }
}

function modelPolicy(config: RuntimeConfig) {
  return {
    allowedModels: config.allowedModels,
    defaultModel: config.adapter === "codex_app_server" ? (config.defaultModel ?? null) : null,
    defaultReasoningEffort: null,
    catalogRequiredForChanges: true
  };
}

function authenticationProjection(config: RuntimeConfig) {
  const reference = config.adapter === "codex_app_server" ? config.codexHomeRef : (config.credentialRef ?? null);
  return {
    type: config.adapter === "codex_app_server" ? "unknown" : reference ? "provider_reference" : "local_no_auth",
    status: reference ? "unknown" : "authenticated",
    storageMode: "unknown",
    accountLabel: null,
    reference,
    resolutionState: reference ? secretReferenceState(reference) : "not_checked",
    lastCheckedAt: null,
    capabilities: {
      browserLogin: false,
      deviceLogin: false,
      referenceLogin: Boolean(reference),
      logout: false
    },
    message: reference
      ? "Credential material remains runtime-scoped. This adapter does not expose authoritative account readback."
      : "This runtime is configured for local or provider-managed authentication."
  };
}

function secretReferenceState(reference: string): "resolved" | "unresolved" {
  const variable = reference.startsWith("env:") ? reference.slice(4) : "";
  return variable && process.env[variable] ? "resolved" : "unresolved";
}

function safeConfig(config: RouterConfig) {
  return {
    version: 1,
    allowedWorktreeRoots: config.allowedWorktreeRoots,
    policies: {
      maxWaitMs: config.maxWaitMs,
      leaseTtlMs: config.leaseTtlMs,
      idempotencyTtlMs: config.idempotencyTtlMs
    },
    web: {
      defaultBind: "127.0.0.1",
      cors: "disabled",
      session: "one-time bootstrap token with HttpOnly SameSite=Strict cookie"
    },
    inference: config.inference
      ? {
          enabled: true,
          host: config.inference.host,
          port: config.inference.port,
          protocol: "openai_responses",
          providers: config.inference.providers.map((provider) => ({ id: provider.id, keyless: provider.keyless })),
          models: config.inference.models.map((model) => ({ id: model.id, providerId: model.providerId }))
        }
      : { enabled: false },
    runtimes: config.runtimes.map((runtime) => ({
      id: runtime.id,
      adapter: runtime.adapter,
      provider: runtime.provider,
      enabled: runtime.enabled,
      maxConcurrency: runtime.maxConcurrency,
      capabilityTiers: runtime.capabilityTiers,
      allowedModels: runtime.allowedModels,
      defaultModel: runtime.adapter === "codex_app_server" ? (runtime.defaultModel ?? null) : null,
      reference: runtime.adapter === "codex_app_server" ? runtime.codexHomeRef : (runtime.credentialRef ?? null),
      resolutionState: secretReferenceState(
        runtime.adapter === "codex_app_server" ? runtime.codexHomeRef : (runtime.credentialRef ?? "")
      )
    }))
  };
}

function taskSummary(task: string): string {
  const first = task
    .split(/\r?\n/)
    .map((line) => line.trim())
    .find(Boolean);
  if (!first) return "Untitled agent task";
  return first.length > 120 ? `${first.slice(0, 117)}…` : first;
}

function isTerminal(status: AgentStatus): boolean {
  return status === "completed" || status === "failed" || status === "interrupted";
}

function countBy<T>(items: T[], key: (item: T) => string): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const item of items) {
    const value = key(item);
    counts[value] = (counts[value] ?? 0) + 1;
  }
  return counts;
}
