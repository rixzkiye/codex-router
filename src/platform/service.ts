import { createHash } from "node:crypto";
import type Database from "better-sqlite3";
import type { InferenceConfig, InferenceProviderConfig } from "../config.js";
import { RouterError } from "../errors.js";
import { newId } from "../security.js";
import type { Registry } from "../store/registry.js";
import { generatePlatformArtifacts } from "./artifacts.js";
import { loginLaunch, observeAuthentication, runOfficialCli, type AuthenticationObservation, type LoginLaunch } from "./auth.js";
import { builtinProviders, configuredModels, registryHash } from "./builtin-registry.js";
import { captureNativeCatalog, mergeNativeCatalog, type NativeCatalogSnapshot } from "./catalog.js";
import { OllamaClient, type LocalModelRecord } from "./local-models.js";
import { InstallationManager, type InstallManifest, type InstallPlan } from "./installation.js";
import { applyRequestProfile } from "./profiles.js";
import { estimatedCost, evaluateCandidates, selectCandidate, type RouteConstraints } from "./routing.js";
import type {
  CapabilityLedgerEntry,
  DoctorCheck,
  InferenceRequestRecord,
  ModelDefinition,
  ModelProjection,
  LocalModelProjection,
  PlatformEvidence,
  PlatformMutationInput,
  PlatformOperation,
  PlatformOperationKind,
  ProviderDefinition,
  ProviderProjection,
  RoutingDecision
} from "./types.js";

type Row = Record<string, unknown>;

const UNKNOWN_EVIDENCE = Object.freeze({ state: "unknown" as const, message: "No authoritative observation is available.", checkedAt: null });

export class PlatformService {
  readonly #db: Database.Database;
  readonly #registry: Registry;
  readonly #config: InferenceConfig | undefined;
  readonly #providers: ProviderDefinition[];
  readonly #models: ModelDefinition[];
  readonly #operationControllers = new Map<string, AbortController>();
  readonly #operationTasks = new Set<Promise<void>>();
  readonly #ollama: OllamaClient;
  readonly #installer = new InstallationManager();
  readonly manifest: ReturnType<typeof generatePlatformArtifacts>["manifest"] | null;

  constructor(database: Database.Database, registry: Registry, config: InferenceConfig | undefined) {
    this.#db = database;
    this.#registry = registry;
    this.#config = config;
    this.#providers = effectiveProviders(config);
    this.#models = configuredModels(config);
    this.#ollama = new OllamaClient(config?.localModels.baseUrl);
    const hash = registryHash(this.#providers, this.#models);
    this.manifest = config ? generatePlatformArtifacts(config, hash).manifest : null;
    this.#synchronizeRegistry();
    this.#reconcileOperations();
  }

  async close(): Promise<void> {
    for (const controller of this.#operationControllers.values()) controller.abort();
    await Promise.allSettled(this.#operationTasks);
  }

  snapshot() {
    const providers = this.providers();
    const models = this.models();
    const operations = this.operations(20);
    const requests = this.requests(30);
    const checks = this.doctor();
    const readyProviders = providers.filter((provider) => provider.enabled && provider.health.state === "ready").length;
    const attention = checks.filter((check) => check.state === "fail" || check.state === "warning").length;
    return {
      registry: {
        hash: registryHash(this.#providers, this.#models),
        manifest: this.manifest,
        providerCount: providers.length,
        modelCount: models.length
      },
      summary: {
        enabledProviders: providers.filter((provider) => provider.enabled).length,
        readyProviders,
        listedModels: models.filter((model) => model.enabled).length,
        requests24h: this.#requestCount24h(),
        operationsInFlight: operations.filter((operation) => operation.state === "pending" || operation.state === "running").length,
        diagnosticsAttention: attention
      },
      providers,
      models,
      accounts: this.accounts(providers),
      requests,
      usage: this.usage(),
      operations,
      diagnostics: checks,
      localRuntime: this.localRuntime(),
      localModels: this.localModels(),
      routingDecisions: this.routingDecisions(30),
      nativeCatalogs: this.nativeCatalogs(),
      evidence: this.evidence(),
      installState: this.installState(),
      capabilityLedger: capabilityLedger()
    };
  }

  providers(): ProviderProjection[] {
    const counts = new Map<string, number>();
    for (const model of this.models()) counts.set(model.providerVariant, (counts.get(model.providerVariant) ?? 0) + 1);
    return (this.#db.prepare("SELECT * FROM platform_providers ORDER BY id").all() as Row[]).map((row) => {
      const definition = parse<ProviderDefinition>(row.definition_json);
      const catalog = parse<ProviderProjection["catalog"]>(row.catalog_json);
      return {
        ...definition,
        version: Number(row.version),
        enabled: Boolean(row.enabled),
        authentication: parse(row.authentication_json),
        entitlement: parse(row.entitlement_json),
        health: parse(row.health_json),
        catalog: { ...catalog, modelCount: counts.get(definition.id) ?? 0 }
      };
    });
  }

  provider(id: string): ProviderProjection {
    const provider = this.providers().find((entry) => entry.id === id);
    if (!provider) throw new RouterError("not_found", `Provider ${id} was not found`);
    return provider;
  }

  models(): ModelProjection[] {
    return (this.#db.prepare("SELECT * FROM platform_models ORDER BY gateway_id").all() as Row[]).map((row) => ({
      ...parse<ModelDefinition>(row.definition_json),
      version: Number(row.version),
      enabled: Boolean(row.enabled),
      compatibility: parse(row.compatibility_json)
    }));
  }

  model(id: string): ModelProjection {
    const model = this.models().find((entry) => entry.gatewayId === id);
    if (!model) throw new RouterError("not_found", `Model ${id} was not found`);
    return model;
  }

  accounts(providers = this.providers()) {
    return providers
      .filter((provider) => provider.credential.mechanism !== "keyless")
      .map((provider) => ({
        id: `account:${provider.canonicalProvider}`,
        providerId: provider.id,
        canonicalProvider: provider.canonicalProvider,
        label: provider.displayName,
        authentication: provider.authentication,
        entitlement: provider.entitlement,
        quota: this.#accountQuota(provider.id),
        affinity: { activeRequests: 0, continuations: 0 },
        operations: this.operations(100).filter((operation) => operation.targetId === provider.id).slice(0, 3)
      }));
  }

  operations(limit = 100): PlatformOperation[] {
    return (this.#db.prepare("SELECT * FROM platform_operations ORDER BY created_at DESC LIMIT ?").all(limit) as Row[]).map(mapOperation);
  }

  operation(id: string): PlatformOperation {
    const row = this.#db.prepare("SELECT * FROM platform_operations WHERE id = ?").get(id) as Row | undefined;
    if (!row) throw new RouterError("not_found", `Operation ${id} was not found`);
    return mapOperation(row);
  }

  async waitForOperation(id: string, timeoutMs = 30 * 60 * 1000): Promise<PlatformOperation> {
    const deadline = Date.now() + Math.max(1, timeoutMs);
    while (true) {
      const operation = this.operation(id);
      if (!["pending", "running"].includes(operation.state)) return operation;
      const remaining = deadline - Date.now();
      if (remaining <= 0) throw new RouterError("runtime_unavailable", `Platform operation ${id} did not become terminal before the wait deadline`);
      const version = this.#registry.registryVersion;
      await this.#registry.waitForVersion(version, Math.min(remaining, 1_000));
    }
  }

  cancelOperation(actor: string, id: string): PlatformOperation {
    const operation = this.operation(id);
    if (!["pending", "running"].includes(operation.state)) return operation;
    const controller = this.#operationControllers.get(id);
    if (!controller) throw new RouterError("conflict", "This operation has no live owner and must be reconciled by restart/readback");
    this.#versioned(() => {
      this.#appendEvent("platform_operation_cancel_requested", operation.targetType, operation.targetId, operation.id, actor, {
        ownerActor: operation.actor
      });
      this.#db.prepare("UPDATE platform_operations SET message = ?, updated_at = ? WHERE id = ?")
        .run("Cancellation requested; waiting for the owned process to stop.", new Date().toISOString(), id);
    });
    controller.abort(new RouterError("runtime_unavailable", "Operation cancelled by the authorized operator"));
    return this.operation(id);
  }

  setProviderEnabled(actor: string, providerId: string, enabled: boolean, input: PlatformMutationInput): PlatformOperation {
    const kind: PlatformOperationKind = enabled ? "provider-enable" : "provider-disable";
    const replay = this.#operationReplay(actor, kind, input.idempotencyKey);
    if (replay) return replay;
    const provider = this.provider(providerId);
    if (provider.version !== input.expectedVersion) {
      throw new RouterError("conflict", `Provider ${providerId} changed from version ${input.expectedVersion} to ${provider.version}`);
    }
    if (enabled && provider.authentication.state !== "ready" && provider.credential.mechanism !== "keyless") {
      throw new RouterError(
        "runtime_unavailable",
        `${provider.displayName} cannot be enabled until authentication is independently resolved`,
        { authenticationState: provider.authentication.state }
      );
    }
    const operation = newOperation(kind, "provider", providerId, actor, input);
    const now = new Date().toISOString();
    this.#versioned(() => {
      this.#appendEvent("platform_operation_started", "provider", providerId, operation.id, actor, { kind, expectedVersion: input.expectedVersion });
      this.#insertOperation(operation);
      this.#appendEvent("provider_enablement_changed", "provider", providerId, operation.id, actor, { enabled, previousVersion: provider.version });
      this.#db.prepare("UPDATE platform_providers SET enabled = ?, version = version + 1, updated_at = ? WHERE id = ?")
        .run(enabled ? 1 : 0, now, providerId);
      this.#appendEvent("platform_operation_completed", "provider", providerId, operation.id, actor, { enabled });
      this.#db.prepare("UPDATE platform_operations SET state = 'completed', progress = 1, message = ?, result_json = ?, updated_at = ?, completed_at = ? WHERE id = ?")
        .run(enabled ? "Provider enabled after authoritative readback." : "Provider disabled; retained state was preserved.", json({ enabled }), now, now, operation.id);
    });
    return this.operation(operation.id);
  }

  setModelEnabled(actor: string, modelId: string, enabled: boolean, input: PlatformMutationInput): PlatformOperation {
    const kind: PlatformOperationKind = enabled ? "model-enable" : "model-disable";
    const replay = this.#operationReplay(actor, kind, input.idempotencyKey);
    if (replay) return replay;
    const model = this.model(modelId);
    if (model.version !== input.expectedVersion) throw new RouterError("conflict", `Model ${modelId} has a newer projection`);
    const provider = this.provider(model.providerVariant);
    if (enabled && !provider.enabled) throw new RouterError("invalid_transition", `Enable ${provider.displayName} before listing ${model.displayName}`);
    if (enabled && !["mock-compatible", "live-compatible", "listed"].includes(model.publication)) {
      throw new RouterError("invalid_transition", `${model.displayName} has no publishable compatibility evidence`);
    }
    const operation = newOperation(kind, "model", modelId, actor, input);
    const now = new Date().toISOString();
    this.#versioned(() => {
      this.#appendEvent("platform_operation_started", "model", modelId, operation.id, actor, { kind });
      this.#insertOperation(operation);
      this.#appendEvent("model_picker_state_changed", "model", modelId, operation.id, actor, { enabled, compatibilityHash: model.compatibilityHash });
      this.#db.prepare("UPDATE platform_models SET enabled = ?, version = version + 1, updated_at = ? WHERE gateway_id = ?")
        .run(enabled ? 1 : 0, now, modelId);
      this.#appendEvent("platform_operation_completed", "model", modelId, operation.id, actor, { enabled });
      this.#db.prepare("UPDATE platform_operations SET state = 'completed', progress = 1, message = ?, result_json = ?, updated_at = ?, completed_at = ? WHERE id = ?")
        .run(enabled ? "Model added to the effective picker projection." : "Model removed from the picker projection.", json({ enabled }), now, now, operation.id);
    });
    return this.operation(operation.id);
  }

  validateProvider(actor: string, providerId: string, input: PlatformMutationInput): PlatformOperation {
    const kind: PlatformOperationKind = "provider-validate";
    const replay = this.#operationReplay(actor, kind, input.idempotencyKey);
    if (replay) return replay;
    const provider = this.provider(providerId);
    if (provider.version !== input.expectedVersion) throw new RouterError("conflict", `Provider ${providerId} has a newer projection`);
    const operation = this.#createLockedOperation(kind, "provider", providerId, actor, input, `credential:${provider.canonicalProvider}`);
    this.#trackOperation(operation, async (signal) => {
      signal.throwIfAborted();
      const authentication = await observeAuthentication(this.#provider(providerId)!);
      this.#finishAuthentication(operation, authentication);
    });
    return this.operation(operation.id);
  }

  providerLoginLaunch(providerId: string): LoginLaunch {
    this.provider(providerId);
    return loginLaunch(providerId);
  }

  loginProvider(
    actor: string,
    providerId: string,
    input: PlatformMutationInput,
    options: { codexHome?: string; inheritTerminal?: boolean } = {}
  ): PlatformOperation {
    return this.#runProviderCliOperation("provider-login", "login", actor, providerId, input, options);
  }

  logoutProvider(
    actor: string,
    providerId: string,
    input: PlatformMutationInput,
    options: { codexHome?: string; inheritTerminal?: boolean } = {}
  ): PlatformOperation {
    return this.#runProviderCliOperation("provider-logout", "logout", actor, providerId, input, options);
  }

  refreshProviderCatalog(actor: string, providerId: string, input: PlatformMutationInput): PlatformOperation {
    const kind: PlatformOperationKind = "catalog-refresh";
    const replay = this.#operationReplay(actor, kind, input.idempotencyKey);
    if (replay) return replay;
    const provider = this.provider(providerId);
    if (provider.version !== input.expectedVersion) throw new RouterError("conflict", `Provider ${providerId} has a newer projection`);
    if (provider.discovery === "not-supported") throw new RouterError("unsupported", `${provider.displayName} has no declared catalog authority`);
    if (provider.authentication.state !== "ready" && provider.credential.mechanism !== "keyless") {
      throw new RouterError("runtime_unavailable", `Validate ${provider.displayName} authentication before discovery`);
    }
    const operation = this.#createLockedOperation(kind, "provider", providerId, actor, input, `catalog:${provider.canonicalProvider}`);
    this.#trackOperation(operation, async (signal) => {
      try {
        await this.#runCatalogRefresh(operation, providerId, signal);
      } catch (error) {
        const latest = this.provider(providerId);
        const now = new Date().toISOString();
        this.#versioned(() => {
          this.#appendEvent("provider_catalog_stale", "provider", providerId, operation.id, actor, { previousRefreshedAt: latest.catalog.refreshedAt });
          this.#db.prepare("UPDATE platform_providers SET catalog_json = ?, version = version + 1, updated_at = ? WHERE id = ?")
            .run(json({ state: "stale", modelCount: latest.catalog.modelCount, refreshedAt: latest.catalog.refreshedAt }), now, providerId);
        });
        throw error;
      }
    });
    return this.operation(operation.id);
  }

  runMockCompatibility(actor: string, modelId: string, input: PlatformMutationInput): PlatformOperation {
    const kind: PlatformOperationKind = "compatibility-probe";
    const replay = this.#operationReplay(actor, kind, input.idempotencyKey);
    if (replay) return replay;
    const model = this.model(modelId);
    if (model.version !== input.expectedVersion) throw new RouterError("conflict", `Model ${modelId} has a newer projection`);
    const provider = this.provider(model.providerVariant);
    const operation = newOperation(kind, "model", modelId, actor, input);
    const profile = applyRequestProfile(model.requestProfile, {
      model: model.gatewayId,
      input: [{ type: "message", role: "user", content: [{ type: "input_text", text: "mock fixture" }] }],
      tools: model.capabilities.tools ? [{ type: "function", name: "fixture", parameters: { type: "object" } }] : []
    });
    const now = new Date().toISOString();
    this.#versioned(() => {
      this.#appendEvent("platform_operation_started", "model", modelId, operation.id, actor, { kind, quotaConsuming: false });
      this.#insertOperation(operation);
      this.#appendEvent("model_compatibility_observed", "model", modelId, operation.id, actor, {
        mode: "mock",
        state: "ready",
        providerId: provider.id,
        profileHash: profile.profileHash,
        transformationCategories: profile.changes
      });
      this.#db.prepare(
        `UPDATE platform_models SET compatibility_json = ?, definition_json = ?, definition_hash = ?,
          version = version + 1, updated_at = ? WHERE gateway_id = ?`
      ).run(
        json({ mock: "ready", live: model.compatibility.live, checkedAt: now, profileHash: profile.profileHash }),
        json({ ...modelDefinition(model), publication: model.publication === "discovered" ? "mock-compatible" : model.publication }),
        hash(json({ ...modelDefinition(model), publication: model.publication === "discovered" ? "mock-compatible" : model.publication })),
        now,
        modelId
      );
      this.#appendEvent("platform_operation_completed", "model", modelId, operation.id, actor, { mode: "mock", state: "ready" });
      this.#db.prepare("UPDATE platform_operations SET state = 'completed', progress = 1, message = ?, result_json = ?, updated_at = ?, completed_at = ? WHERE id = ?")
        .run("Mock compatibility completed without provider quota.", json({ mode: "mock", profileHash: profile.profileHash }), now, now, operation.id);
    });
    return this.operation(operation.id);
  }

  doctor(): DoctorCheck[] {
    const providers = this.providers();
    const models = this.models();
    const configured = this.#config;
    const translationNeeded = Boolean(configured?.providers.some((provider) => (provider.protocol ?? "responses") !== "responses"));
    return [
      {
        id: "registry-integrity",
        label: "Registry integrity",
        state: providers.length === this.#providers.length && models.length === this.#models.length ? "pass" : "fail",
        message: `${providers.length} provider variants and ${models.length} configured models match the effective registry projection.`,
        repairable: true
      },
      {
        id: "credential-boundary",
        label: "Credential boundary",
        state: providers.some((provider) => provider.credential.references.some((reference) => !reference.startsWith("env:"))) ? "fail" : "pass",
        message: "Durable provider definitions contain symbolic references only.",
        repairable: false
      },
      {
        id: "translation-core",
        label: "LiteLLM translation core",
        state: translationNeeded && !configured?.translation ? "fail" : translationNeeded ? "unknown" : "pass",
        message: translationNeeded
          ? configured?.translation
            ? "Translation is configured on loopback; live process health has not been probed in this snapshot."
            : "A non-Responses provider requires a configured loopback LiteLLM core."
          : "No configured route currently requires protocol translation.",
        repairable: true
      },
      {
        id: "artifact-manifest",
        label: "Generated artifact manifest",
        state: configured && this.manifest ? "pass" : "unknown",
        message: this.manifest ? `Loaded generation manifest ${this.manifest.registryHash.slice(0, 12)}.` : "Inference artifacts are not configured.",
        repairable: true
      },
      {
        id: "catalog-publication",
        label: "Catalog publication truth",
        state: models.every((model) => !model.enabled || ["mock-compatible", "live-compatible", "listed"].includes(model.publication)) ? "pass" : "fail",
        message: "Only models with explicit publishable evidence may be listed.",
        repairable: true
      }
    ];
  }

  requests(limit = 100): InferenceRequestRecord[] {
    return (this.#db.prepare("SELECT * FROM inference_requests ORDER BY started_at DESC LIMIT ?").all(limit) as Row[]).map(mapRequest);
  }

  usage() {
    const totals = this.#db.prepare(
      `SELECT provider_id, model_id, COUNT(*) request_count,
              SUM(input_tokens) input_tokens, SUM(output_tokens) output_tokens,
              SUM(cached_input_tokens) cached_input_tokens, SUM(reasoning_tokens) reasoning_tokens,
              SUM(estimated_input_tokens) estimated_input_tokens,
              MAX(observed_at) updated_at
         FROM platform_usage_events GROUP BY provider_id, model_id ORDER BY provider_id, model_id`
    ).all() as Row[];
    const models = new Map(this.models().map((model) => [model.gatewayId, model]));
    const rows = totals.map((row) => {
      const model = models.get(String(row.model_id));
      const inputTokens = nullableNumber(row.input_tokens);
      const outputTokens = nullableNumber(row.output_tokens);
      return {
        providerId: String(row.provider_id), modelId: String(row.model_id), requests: Number(row.request_count),
        inputTokens, outputTokens,
        cachedInputTokens: nullableNumber(row.cached_input_tokens), reasoningTokens: nullableNumber(row.reasoning_tokens),
        estimatedInputTokens: nullableNumber(row.estimated_input_tokens), updatedAt: String(row.updated_at),
        estimatedCost: model ? estimatedCost(model, { inputTokens, outputTokens }) : null
      };
    });
    return {
      provenance: "provider-reported and separately labeled estimates",
      estimatedCostUsd: rows.some((row) => row.estimatedCost !== null)
        ? Number(rows.reduce((sum, row) => sum + (row.estimatedCost?.amount ?? 0), 0).toFixed(8))
        : null,
      totals: rows
    };
  }

  beginRequest(input: Omit<InferenceRequestRecord, "connectedAt" | "firstSemanticAt" | "completedAt" | "status" | "errorClass" | "cancelled" | "retryCount" | "failoverCount" | "semanticOutputObserved" | "usage" | "flags">): void {
    this.#insertInferenceRequest(input);
  }

  beginRoutedRequest(
    input: Omit<InferenceRequestRecord, "connectedAt" | "firstSemanticAt" | "completedAt" | "status" | "errorClass" | "cancelled" | "retryCount" | "failoverCount" | "semanticOutputObserved" | "usage" | "flags">,
    decision: RoutingDecision
  ): void {
    if (decision.requestId !== input.id) throw new RouterError("invalid_request", "Routing decision identity does not match the inference request");
    this.#versioned(() => {
      this.#appendEvent("inference_route_selected", "inference-request", decision.requestId, null, "inference-edge", {
        policyVersion: decision.policyVersion,
        catalogVersion: decision.catalogVersion,
        selected: decision.selected,
        candidateCount: decision.candidates.length
      });
      this.#insertInferenceRequest(input);
      this.#insertRoutingDecision(decision);
    });
  }

  #insertInferenceRequest(input: Omit<InferenceRequestRecord, "connectedAt" | "firstSemanticAt" | "completedAt" | "status" | "errorClass" | "cancelled" | "retryCount" | "failoverCount" | "semanticOutputObserved" | "usage" | "flags">): void {
    const usage = emptyUsage();
    this.#db.prepare(
      `INSERT INTO inference_requests(
        id, attempt_id, caller_class, runtime_id, provider_id, account_ref_id, model_id, profile_hash,
        started_at, status, usage_json, flags_json
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'connecting', ?, '[]')`
    ).run(input.id, input.attemptId, input.callerClass, input.runtimeId, input.providerId, input.accountRefId, input.modelId, input.profileHash, input.startedAt, json(usage));
  }

  markRequestConnected(requestId: string): void {
    this.#db.prepare("UPDATE inference_requests SET connected_at = ?, status = 'streaming' WHERE id = ?")
      .run(new Date().toISOString(), requestId);
  }

  markSemanticOutput(requestId: string): void {
    this.#db.prepare(
      "UPDATE inference_requests SET semantic_output_seen = 1, first_semantic_at = COALESCE(first_semantic_at, ?) WHERE id = ?"
    ).run(new Date().toISOString(), requestId);
  }

  completeRequest(
    requestId: string,
    input: { status: string; errorClass?: string | null; cancelled?: boolean; usage?: InferenceRequestRecord["usage"]; flags?: string[] }
  ): void {
    const existing = this.#db.prepare("SELECT provider_id, model_id, usage_json FROM inference_requests WHERE id = ?").get(requestId) as Row | undefined;
    if (!existing) return;
    const usage = input.usage ?? parse<InferenceRequestRecord["usage"]>(existing.usage_json);
    const now = new Date().toISOString();
    this.#db.transaction(() => {
      this.#db.prepare(
        `UPDATE inference_requests SET completed_at = ?, status = ?, error_class = ?, cancelled = ?, usage_json = ?, flags_json = ? WHERE id = ?`
      ).run(now, input.status, input.errorClass ?? null, input.cancelled ? 1 : 0, json(usage), json(input.flags ?? []), requestId);
      this.#db.prepare(
        `INSERT INTO platform_usage_events(
          request_id, provider_id, model_id, input_tokens, output_tokens, cached_input_tokens,
          reasoning_tokens, estimated_input_tokens, observed_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
      ).run(requestId, existing.provider_id, existing.model_id, usage.providerInputTokens, usage.providerOutputTokens,
        usage.cachedInputTokens, usage.reasoningTokens, usage.estimatedInputTokens, now);
    })();
  }

  observeProviderResponse(providerId: string, status: number, headers: Headers): void {
    const row = this.#db.prepare("SELECT id, authentication_json, entitlement_json FROM platform_providers WHERE id = ?").get(providerId) as Row | undefined;
    if (!row) return;
    const now = new Date().toISOString();
    const authentication = parse<ProviderProjection["authentication"]>(row.authentication_json);
    const entitlement = parse<ProviderProjection["entitlement"]>(row.entitlement_json);
    const health = status >= 200 && status < 400
      ? { state: "ready", message: "The latest routed response reached the provider boundary.", checkedAt: now }
      : status === 429
        ? { state: "restricted", message: "The provider reported a rate or quota limit.", checkedAt: now }
        : status >= 500
          ? { state: "degraded", message: `The provider returned status ${status}.`, checkedAt: now }
          : { state: "unknown", message: `The provider returned status ${status}.`, checkedAt: now };
    const nextAuthentication = status === 401
      ? { ...authentication, state: "unavailable" as const, checkedAt: now }
      : status >= 200 && status < 400
        ? { ...authentication, state: "ready" as const, checkedAt: now }
        : authentication;
    const nextEntitlement = status === 403
      ? { state: "restricted" as const, message: "The provider authenticated but denied this route or plan entitlement.", checkedAt: now }
      : status >= 200 && status < 400
        ? { state: "ready" as const, message: "The selected route was accepted by the provider.", checkedAt: now }
        : entitlement;
    const quota = normalizedQuota(headers, status, now);
    this.#versioned(() => {
      this.#appendEvent("provider_response_observed", "provider", providerId, null, "inference-edge", {
        status,
        healthState: health.state,
        authenticationState: nextAuthentication.state,
        entitlementState: nextEntitlement.state,
        quotaState: quota.state
      });
      this.#db.prepare(
        "UPDATE platform_providers SET authentication_json = ?, entitlement_json = ?, health_json = ?, version = version + 1, updated_at = ? WHERE id = ?"
      ).run(json(nextAuthentication), json(nextEntitlement), json(health), now, providerId);
      this.#db.prepare(
        `INSERT INTO platform_settings(key, value_json, version, updated_at) VALUES (?, ?, 1, ?)
         ON CONFLICT(key) DO UPDATE SET value_json = excluded.value_json, version = platform_settings.version + 1, updated_at = excluded.updated_at`
      ).run(`quota:${providerId}`, json(quota), now);
    });
  }

  artifacts() {
    if (!this.#config) throw new RouterError("not_found", "Inference configuration is not available");
    return generatePlatformArtifacts(this.#config, registryHash(this.#providers, this.#models));
  }

  localRuntime() {
    const row = this.#db.prepare("SELECT value_json, version, updated_at FROM platform_settings WHERE key = 'local-runtime:ollama'").get() as Row | undefined;
    return row
      ? { ...parse<Record<string, unknown>>(row.value_json), version: Number(row.version), updatedAt: String(row.updated_at) }
      : { runtimeId: "ollama", state: "unknown", baseUrl: this.#config?.localModels.baseUrl ?? "http://127.0.0.1:11434", version: 1, updatedAt: null };
  }

  localModels(): LocalModelProjection[] {
    return (this.#db.prepare("SELECT * FROM platform_local_models ORDER BY id").all() as Row[]).map(mapLocalModel);
  }

  localModel(id: string): LocalModelProjection {
    const row = this.#db.prepare("SELECT * FROM platform_local_models WHERE id = ?").get(id) as Row | undefined;
    if (!row) throw new RouterError("not_found", `Local model ${id} was not found`);
    return mapLocalModel(row);
  }

  discoverLocalModels(actor: string, input: PlatformMutationInput): PlatformOperation {
    const kind: PlatformOperationKind = "local-model-discover";
    const replay = this.#operationReplay(actor, kind, input.idempotencyKey);
    if (replay) return replay;
    const runtime = this.localRuntime();
    if (runtime.version !== input.expectedVersion) throw new RouterError("conflict", "The local runtime projection changed; refresh before discovery");
    const operation = this.#createLockedOperation(kind, "local-runtime", "ollama", actor, input, "local-runtime:ollama");
    this.#trackOperation(operation, async (signal) => {
      if (!(await this.#ollama.health(signal))) throw new RouterError("runtime_unavailable", "The configured Ollama runtime is offline");
      const listed = await this.#ollama.list(signal);
      const models: LocalModelRecord[] = [];
      for (const entry of listed) {
        signal.throwIfAborted();
        try {
          const inspected = await this.#ollama.inspect(entry.id, signal);
          models.push({ ...entry, ...inspected, sizeBytes: entry.sizeBytes, digest: entry.digest, modifiedAt: inspected.modifiedAt ?? entry.modifiedAt });
        } catch {
          models.push(entry);
        }
      }
      const checkedAt = new Date().toISOString();
      this.#completeOperation(operation, `Discovered ${models.length} installed local models.`, { discovered: models.length }, () => {
        this.#appendEvent("local_models_observed", "local-runtime", "ollama", operation.id, actor, { count: models.length });
        for (const model of models) this.#upsertLocalModel(model, "installed", operation.id, checkedAt);
        this.#db.prepare(
          `INSERT INTO platform_settings(key, value_json, version, updated_at) VALUES ('local-runtime:ollama', ?, 2, ?)
           ON CONFLICT(key) DO UPDATE SET value_json = excluded.value_json, version = platform_settings.version + 1, updated_at = excluded.updated_at`
        ).run(json({ runtimeId: "ollama", state: "ready", baseUrl: this.#config?.localModels.baseUrl ?? "http://127.0.0.1:11434", checkedAt }), checkedAt);
      });
    });
    return this.operation(operation.id);
  }

  downloadLocalModel(actor: string, modelId: string, input: PlatformMutationInput & { consent: boolean }): PlatformOperation {
    if (!input.consent) throw new RouterError("unauthorized", "Local model download requires explicit operator consent");
    const kind: PlatformOperationKind = "local-model-download";
    const replay = this.#operationReplay(actor, kind, input.idempotencyKey);
    if (replay) return replay;
    const existing = this.#optionalLocalModel(modelId);
    if (existing && existing.version !== input.expectedVersion) throw new RouterError("conflict", `Local model ${modelId} changed; refresh before download`);
    const operation = this.#createLockedOperation(kind, "local-model", modelId, actor, input, `local-model:${modelId}`);
    this.#setLocalModelState(modelId, "downloading", operation, existing);
    this.#trackOperation(operation, async (signal) => {
      const model = await this.#ollama.pull(modelId, {
        consent: true,
        signal,
        onProgress: (progress) => this.#progressOperation(operation, progress.fraction, progress.status, {
          digest: progress.digest, completed: progress.completed, total: progress.total
        })
      });
      const completedAt = new Date().toISOString();
      this.#completeOperation(operation, `${modelId} downloaded and independently inspected.`, { modelId }, () => {
        this.#appendEvent("local_model_installed", "local-model", modelId, operation.id, actor, { digest: model.digest, sizeBytes: model.sizeBytes });
        this.#upsertLocalModel(model, "installed", operation.id, completedAt);
      });
    });
    return this.operation(operation.id);
  }

  benchmarkLocalModel(actor: string, modelId: string, input: PlatformMutationInput): PlatformOperation {
    const kind: PlatformOperationKind = "local-model-benchmark";
    const replay = this.#operationReplay(actor, kind, input.idempotencyKey);
    if (replay) return replay;
    const model = this.localModel(modelId);
    if (model.version !== input.expectedVersion) throw new RouterError("conflict", `Local model ${modelId} changed; refresh before validation`);
    const operation = this.#createLockedOperation(kind, "local-model", modelId, actor, input, `local-model:${modelId}`);
    this.#trackOperation(operation, async (signal) => {
      const benchmark = await this.#ollama.benchmark(modelId, signal);
      const state: LocalModelProjection["state"] = benchmark.completed && benchmark.toolCallObserved ? "validated" : "installed";
      const completedAt = new Date().toISOString();
      this.#completeOperation(operation, benchmark.toolCallObserved
        ? `${modelId} produced a measured tool call and is eligible for explicit selection.`
        : `${modelId} completed the text benchmark but did not prove tool-call compatibility.`, { benchmark, validated: state === "validated" }, () => {
        this.#appendEvent("local_model_benchmarked", "local-model", modelId, operation.id, actor, { benchmark, validated: state === "validated" });
        this.#db.prepare("UPDATE platform_local_models SET state = ?, benchmark_json = ?, operation_id = ?, version = version + 1, updated_at = ? WHERE id = ?")
          .run(state, json(benchmark), operation.id, completedAt, modelId);
      });
    });
    return this.operation(operation.id);
  }

  setLocalModelSelected(actor: string, modelId: string, selected: boolean, input: PlatformMutationInput): PlatformOperation {
    const kind: PlatformOperationKind = selected ? "local-model-select" : "local-model-unselect";
    const replay = this.#operationReplay(actor, kind, input.idempotencyKey);
    if (replay) return replay;
    const model = this.localModel(modelId);
    if (model.version !== input.expectedVersion) throw new RouterError("conflict", `Local model ${modelId} changed; refresh before selection`);
    if (selected && model.state !== "validated") throw new RouterError("invalid_transition", "A local model must pass measured agent capability validation before selection");
    const operation = newOperation(kind, "local-model", modelId, actor, input);
    const now = new Date().toISOString();
    this.#versioned(() => {
      this.#appendEvent("platform_operation_started", "local-model", modelId, operation.id, actor, { kind });
      this.#insertOperation(operation);
      this.#appendEvent("local_model_selection_changed", "local-model", modelId, operation.id, actor, { selected });
      this.#db.prepare("UPDATE platform_local_models SET selected = ?, version = version + 1, updated_at = ? WHERE id = ?")
        .run(selected ? 1 : 0, now, modelId);
      this.#appendEvent("platform_operation_completed", "local-model", modelId, operation.id, actor, { selected });
      this.#db.prepare("UPDATE platform_operations SET state = 'completed', progress = 1, message = ?, result_json = ?, updated_at = ?, completed_at = ? WHERE id = ?")
        .run(selected ? "Local model selected." : "Local model unselected; downloaded bytes were retained.", json({ selected }), now, now, operation.id);
    });
    return this.operation(operation.id);
  }

  removeLocalModel(actor: string, modelId: string, input: PlatformMutationInput & { consent: boolean }): PlatformOperation {
    if (!input.consent) throw new RouterError("unauthorized", "Local model removal requires explicit operator consent");
    const kind: PlatformOperationKind = "local-model-remove";
    const replay = this.#operationReplay(actor, kind, input.idempotencyKey);
    if (replay) return replay;
    const model = this.localModel(modelId);
    if (model.version !== input.expectedVersion) throw new RouterError("conflict", `Local model ${modelId} changed; refresh before removal`);
    if (model.selected) throw new RouterError("invalid_transition", "Unselect the local model before deleting its downloaded bytes");
    const operation = this.#createLockedOperation(kind, "local-model", modelId, actor, input, `local-model:${modelId}`);
    this.#setLocalModelState(modelId, "removing", operation, model);
    this.#trackOperation(operation, async (signal) => {
      await this.#ollama.remove(modelId, { consent: true, signal });
      this.#completeOperation(operation, `${modelId} was removed from the local runtime.`, { removed: true, recoverable: false }, () => {
        this.#appendEvent("local_model_removed", "local-model", modelId, operation.id, actor, { recoverable: false });
        this.#db.prepare("DELETE FROM platform_local_models WHERE id = ?").run(modelId);
      });
    });
    return this.operation(operation.id);
  }

  createRoutingDecision(requestId: string, constraints: RouteConstraints): RoutingDecision {
    const providers = new Map(this.providers().map((provider) => [provider.id, provider]));
    const candidates = this.models().map((model) => {
      const provider = providers.get(model.providerVariant);
      if (!provider) throw new RouterError("not_found", `Model ${model.gatewayId} has no provider projection`);
      const accountRefId = provider.credential.mechanism === "keyless" ? null : `account:${provider.canonicalProvider}`;
      const quota = quotaFraction(this.#accountQuota(provider.id));
      const active = this.#db.prepare(
        "SELECT COUNT(*) count FROM inference_requests WHERE provider_id = ? AND model_id = ? AND completed_at IS NULL"
      ).get(provider.id, model.gatewayId) as Row;
      const last = this.#db.prepare(
        "SELECT created_at FROM platform_routing_decisions WHERE json_extract(selected_json, '$.modelId') = ? ORDER BY created_at DESC LIMIT 1"
      ).get(model.gatewayId) as Row | undefined;
      return { provider, model, accountRefId, activeRequests: Number(active.count), quotaRemainingFraction: quota, lastSelectedAt: last ? String(last.created_at) : null };
    });
    const evaluated = evaluateCandidates(candidates, constraints);
    const selected = selectCandidate(candidates, constraints);
    const quotaVersion = this.#db.prepare("SELECT MAX(version) version FROM platform_settings WHERE key LIKE 'quota:%'").get() as Row;
    return {
      requestId,
      policyVersion: this.#config?.routingPolicy.policyVersion ?? "routing/v1",
      catalogVersion: registryHash(this.#providers, this.#models),
      quotaSnapshotVersion: quotaVersion.version === null || quotaVersion.version === undefined ? null : String(quotaVersion.version),
      selected: { providerId: selected.providerId, accountRefId: selected.accountRefId, modelId: selected.modelId, score: selected.score },
      candidates: evaluated,
      createdAt: new Date().toISOString()
    };
  }

  recordRoutingDecision(decision: RoutingDecision): void {
    this.#versioned(() => {
      this.#appendEvent("inference_route_selected", "inference-request", decision.requestId, null, "inference-edge", {
        policyVersion: decision.policyVersion,
        catalogVersion: decision.catalogVersion,
        selected: decision.selected,
        candidateCount: decision.candidates.length
      });
      this.#insertRoutingDecision(decision);
    });
  }

  #insertRoutingDecision(decision: RoutingDecision): void {
    this.#db.prepare(
      `INSERT INTO platform_routing_decisions(request_id, policy_version, catalog_version, quota_snapshot_version, selected_json, candidates_json, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`
    ).run(decision.requestId, decision.policyVersion, decision.catalogVersion, decision.quotaSnapshotVersion,
      json(decision.selected), json(decision.candidates), decision.createdAt);
  }

  routingDecisions(limit = 100): RoutingDecision[] {
    return (this.#db.prepare("SELECT * FROM platform_routing_decisions ORDER BY created_at DESC LIMIT ?").all(limit) as Row[]).map(mapRoutingDecision);
  }

  recordNativeCatalog(input: Parameters<typeof captureNativeCatalog>[0]): NativeCatalogSnapshot {
    const snapshot = captureNativeCatalog(input);
    this.#versioned(() => {
      this.#appendEvent("native_catalog_observed", "native-catalog", `${snapshot.accountRefId}:${snapshot.clientVersion}`, null, "native-runtime", {
        accountRefId: snapshot.accountRefId, clientVersion: snapshot.clientVersion, catalogHash: snapshot.hash, etag: snapshot.etag
      });
      this.#db.prepare(
        `INSERT INTO platform_native_catalogs(account_ref_id, client_version, etag, catalog_json, catalog_hash, state, observed_at)
         VALUES (?, ?, ?, ?, ?, 'ready', ?)
         ON CONFLICT(account_ref_id, client_version) DO UPDATE SET etag = excluded.etag, catalog_json = excluded.catalog_json,
           catalog_hash = excluded.catalog_hash, state = excluded.state, observed_at = excluded.observed_at`
      ).run(snapshot.accountRefId, snapshot.clientVersion, snapshot.etag, json(snapshot.catalog), snapshot.hash, snapshot.observedAt);
    });
    return snapshot;
  }

  nativeCatalog(accountRefId: string, clientVersion: string): NativeCatalogSnapshot {
    const row = this.#db.prepare("SELECT * FROM platform_native_catalogs WHERE account_ref_id = ? AND client_version = ?")
      .get(accountRefId, clientVersion) as Row | undefined;
    if (!row) throw new RouterError("not_found", "No native catalog exists for this account and client cohort");
    return {
      accountRefId: String(row.account_ref_id), clientVersion: String(row.client_version), etag: nullableString(row.etag),
      catalog: parse(row.catalog_json), hash: String(row.catalog_hash), observedAt: String(row.observed_at)
    };
  }

  mergeNativeCatalog(accountRefId: string, clientVersion: string, providerSlug = "codex-router") {
    return mergeNativeCatalog(this.nativeCatalog(accountRefId, clientVersion), this.models(), { providerSlug });
  }

  nativeCatalogs() {
    return (this.#db.prepare("SELECT account_ref_id, client_version, etag, catalog_hash, state, observed_at FROM platform_native_catalogs ORDER BY observed_at DESC").all() as Row[])
      .map((row) => ({ accountRefId: String(row.account_ref_id), clientVersion: String(row.client_version), etag: nullableString(row.etag), hash: String(row.catalog_hash), state: String(row.state), observedAt: String(row.observed_at) }));
  }

  recordEvidence(evidence: PlatformEvidence): void {
    this.#versioned(() => {
      this.#appendEvent("platform_evidence_recorded", "capability", evidence.capability, null, "evidence-gate", {
        evidenceId: evidence.id, category: evidence.category, state: evidence.state, headSha: evidence.headSha
      });
      this.#db.prepare(
        `INSERT INTO platform_evidence(id, capability, category, state, provenance_json, observed_at, expires_at, head_sha)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET state = excluded.state, provenance_json = excluded.provenance_json,
           observed_at = excluded.observed_at, expires_at = excluded.expires_at, head_sha = excluded.head_sha`
      ).run(evidence.id, evidence.capability, evidence.category, evidence.state, json(evidence.provenance), evidence.observedAt, evidence.expiresAt, evidence.headSha);
    });
  }

  evidence(): PlatformEvidence[] {
    return (this.#db.prepare("SELECT * FROM platform_evidence ORDER BY observed_at DESC").all() as Row[]).map((row) => ({
      id: String(row.id), capability: String(row.capability), category: row.category as PlatformEvidence["category"],
      state: row.state as PlatformEvidence["state"], provenance: parse(row.provenance_json), observedAt: String(row.observed_at),
      expiresAt: nullableString(row.expires_at), headSha: nullableString(row.head_sha)
    }));
  }

  recordInstallState(manifest: Record<string, unknown>): void {
    const now = new Date().toISOString();
    this.#versioned(() => {
      this.#appendEvent("install_state_observed", "installation", "current", null, "installer", { owner: manifest.owner ?? null, releaseVersion: manifest.releaseVersion ?? null });
      this.#db.prepare(
        `INSERT INTO platform_install_state(id, manifest_json, version, updated_at) VALUES ('current', ?, 1, ?)
         ON CONFLICT(id) DO UPDATE SET manifest_json = excluded.manifest_json, version = platform_install_state.version + 1, updated_at = excluded.updated_at`
      ).run(json(manifest), now);
    });
  }

  installState() {
    const row = this.#db.prepare("SELECT manifest_json, version, updated_at FROM platform_install_state WHERE id = 'current'").get() as Row | undefined;
    return row ? { manifest: parse(row.manifest_json), version: Number(row.version), updatedAt: String(row.updated_at) } : null;
  }

  planInstallation(
    actor: string,
    params: { root: string; version: string; releaseSource: string; entrypoint: string; configPath: string; host?: NodeJS.Platform },
    input: PlatformMutationInput
  ): PlatformOperation {
    const kind: PlatformOperationKind = "install-plan";
    const replay = this.#operationReplay(actor, kind, input.idempotencyKey);
    if (replay) return replay;
    const currentVersion = this.installState()?.version ?? 1;
    if (input.expectedVersion !== currentVersion) throw new RouterError("conflict", "Installation state changed; refresh before planning");
    const operation = this.#createLockedOperation(kind, "installation", "current", actor, input, "installation:current");
    this.#trackOperation(operation, async (signal) => {
      signal.throwIfAborted();
      const plan = await this.#installer.plan(params);
      signal.throwIfAborted();
      this.#completeOperation(operation, plan.checks.some((check) => check.state === "fail")
        ? "Installation plan contains blocking preflight failures."
        : "Installation plan completed without mutating the host.", { plan: safeInstallPlan(plan) });
    });
    return this.operation(operation.id);
  }

  applyInstallation(
    actor: string,
    params: { root: string; version: string; releaseSource: string; entrypoint: string; configPath: string; host?: NodeJS.Platform },
    input: PlatformMutationInput & { consent: boolean }
  ): PlatformOperation {
    if (!input.consent) throw new RouterError("unauthorized", "Installation requires explicit operator consent");
    const state = this.installState();
    const kind: PlatformOperationKind = state ? "update" : "install-apply";
    const replay = this.#operationReplay(actor, kind, input.idempotencyKey);
    if (replay) return replay;
    if (input.expectedVersion !== (state?.version ?? 1)) throw new RouterError("conflict", "Installation state changed; refresh before apply");
    const operation = this.#createLockedOperation(kind, "installation", "current", actor, input, "installation:current");
    this.#trackOperation(operation, async (signal) => {
      const plan = await this.#installer.plan(params);
      const manifest = await this.#installer.install(plan, { consent: true, signal });
      const verification = await this.#installer.verify(plan.manifestFile);
      if (!verification.ready) throw new RouterError("runtime_unavailable", "Installed files failed manifest readback");
      this.#completeInstallOperation(operation, manifest, verification.checks, kind === "update" ? "Update applied and verified; rollback target retained." : "Installation applied and verified.", plan.manifestFile);
    });
    return this.operation(operation.id);
  }

  rollbackInstallation(actor: string, manifestFile: string, input: PlatformMutationInput & { consent: boolean }): PlatformOperation {
    return this.#runExistingInstallOperation("rollback", actor, manifestFile, input, async () => {
      const manifest = await this.#installer.rollback(manifestFile, { consent: true });
      const verification = await this.#installer.verify(manifestFile);
      if (!verification.ready) throw new RouterError("runtime_unavailable", "Rolled-back files failed manifest readback");
      return { manifest, checks: verification.checks, message: "Rollback restored the retained release and verified readiness." };
    });
  }

  disableInstallation(actor: string, manifestFile: string, input: PlatformMutationInput & { consent: boolean }): PlatformOperation {
    return this.#runExistingInstallOperation("disable", actor, manifestFile, input, async () => {
      const manifest = await this.#installer.disable(manifestFile, { consent: true });
      return { manifest, checks: [], message: "Managed installation disabled; retained state remains." };
    });
  }

  uninstallInstallation(
    actor: string,
    manifestFile: string,
    input: PlatformMutationInput & { consent: boolean; removeRetainedReleases?: boolean }
  ): PlatformOperation {
    if (!input.consent) throw new RouterError("unauthorized", "Uninstall requires explicit operator consent");
    const state = this.installState();
    if (input.expectedVersion !== (state?.version ?? 1)) throw new RouterError("conflict", "Installation state changed; refresh before uninstall");
    const kind: PlatformOperationKind = "uninstall";
    const replay = this.#operationReplay(actor, kind, input.idempotencyKey);
    if (replay) return replay;
    const operation = this.#createLockedOperation(kind, "installation", "current", actor, input, "installation:current");
    this.#trackOperation(operation, async () => {
      const result = await this.#installer.uninstall(manifestFile, {
        consent: true,
        removeRetainedReleases: input.removeRetainedReleases ?? false
      });
      this.#completeOperation(operation, "Only manifest-owned installation paths were removed.", result, () => {
        this.#appendEvent("installation_uninstalled", "installation", "current", operation.id, actor, {
          removed: result.removed, retained: result.retained
        });
        this.#db.prepare("DELETE FROM platform_install_state WHERE id = 'current'").run();
      });
    });
    return this.operation(operation.id);
  }

  #runExistingInstallOperation(
    kind: "rollback" | "disable",
    actor: string,
    manifestFile: string,
    input: PlatformMutationInput & { consent: boolean },
    run: () => Promise<{ manifest: InstallManifest; checks: unknown[]; message: string }>
  ): PlatformOperation {
    if (!input.consent) throw new RouterError("unauthorized", `${kind} requires explicit operator consent`);
    const state = this.installState();
    if (input.expectedVersion !== (state?.version ?? 1)) throw new RouterError("conflict", `Installation state changed; refresh before ${kind}`);
    const replay = this.#operationReplay(actor, kind, input.idempotencyKey);
    if (replay) return replay;
    const operation = this.#createLockedOperation(kind, "installation", "current", actor, input, "installation:current");
    this.#trackOperation(operation, async (signal) => {
      signal.throwIfAborted();
      const result = await run();
      signal.throwIfAborted();
      this.#completeInstallOperation(operation, result.manifest, result.checks, result.message, manifestFile);
    });
    return this.operation(operation.id);
  }

  #completeInstallOperation(operation: PlatformOperation, manifest: InstallManifest, checks: unknown[], message: string, manifestFile: string): void {
    const now = new Date().toISOString();
    this.#completeOperation(operation, message, { manifest: safeInstallManifest(manifest, manifestFile), checks }, () => {
      this.#appendEvent("install_state_observed", "installation", "current", operation.id, operation.actor, {
        releaseVersion: manifest.releaseVersion, state: manifest.state, activeRelease: manifest.activeRelease
      });
      this.#db.prepare(
        `INSERT INTO platform_install_state(id, manifest_json, version, updated_at) VALUES ('current', ?, 1, ?)
         ON CONFLICT(id) DO UPDATE SET manifest_json = excluded.manifest_json, version = platform_install_state.version + 1, updated_at = excluded.updated_at`
      ).run(json(safeInstallManifest(manifest, manifestFile)), now);
    });
  }

  #runProviderCliOperation(
    kind: "provider-login" | "provider-logout",
    action: "login" | "logout",
    actor: string,
    providerId: string,
    input: PlatformMutationInput,
    options: { codexHome?: string; inheritTerminal?: boolean }
  ): PlatformOperation {
    const replay = this.#operationReplay(actor, kind, input.idempotencyKey);
    if (replay) return replay;
    const provider = this.provider(providerId);
    if (provider.version !== input.expectedVersion) throw new RouterError("conflict", `Provider ${providerId} has a newer projection`);
    loginLaunch(providerId);
    const operation = this.#createLockedOperation(kind, "provider", providerId, actor, input, `credential:${provider.canonicalProvider}`);
    this.#trackOperation(operation, async (signal) => {
      const result = await runOfficialCli(providerId, action, {
        ...(options.codexHome ? { codexHome: options.codexHome } : {}),
        signal,
        inheritTerminal: options.inheritTerminal ?? false
      });
      if (result.state !== "completed") throw new RouterError("runtime_unavailable", result.message);
      const authentication = await observeAuthentication(this.#provider(providerId)!);
      this.#finishAuthentication(operation, authentication, { action, exitCode: result.exitCode });
    });
    return this.operation(operation.id);
  }

  #finishAuthentication(operation: PlatformOperation, authentication: AuthenticationObservation, result: Record<string, unknown> = {}): void {
    const now = new Date().toISOString();
    this.#completeOperation(operation, `Authentication readback: ${authentication.state}.`, { ...result, authentication }, () => {
      this.#appendEvent("provider_authentication_observed", "provider", operation.targetId, operation.id, operation.actor, {
        state: authentication.state, source: authentication.source, expiresAt: authentication.expiresAt
      });
      this.#db.prepare("UPDATE platform_providers SET authentication_json = ?, version = version + 1, updated_at = ? WHERE id = ?")
        .run(json(authentication), now, operation.targetId);
      if (authentication.state !== "ready") {
        this.#appendEvent("provider_became_ineligible", "provider", operation.targetId, operation.id, operation.actor, { authenticationState: authentication.state });
        this.#db.prepare("UPDATE platform_providers SET enabled = 0 WHERE id = ?").run(operation.targetId);
      }
    });
  }

  #createLockedOperation(
    kind: PlatformOperationKind,
    targetType: string,
    targetId: string,
    actor: string,
    input: PlatformMutationInput,
    lockScope: string
  ): PlatformOperation {
    const operation = newOperation(kind, targetType, targetId, actor, input);
    this.#versioned(() => {
      this.#appendEvent("platform_operation_started", targetType, targetId, operation.id, actor, { kind, lockScope });
      this.#insertOperation(operation);
      this.#acquireOperationLock(lockScope, operation.id);
    });
    return operation;
  }

  #acquireOperationLock(scope: string, operationId: string): number {
    const now = new Date();
    const existing = this.#db.prepare("SELECT operation_id, fencing_token, expires_at FROM platform_operation_locks WHERE scope = ?").get(scope) as Row | undefined;
    if (existing && Date.parse(String(existing.expires_at)) > now.getTime()) {
      throw new RouterError("conflict", `Platform operation scope ${scope} already has an active writer`, {
        operationId: String(existing.operation_id), fencingToken: Number(existing.fencing_token), expiresAt: String(existing.expires_at)
      });
    }
    if (existing) this.#db.prepare("DELETE FROM platform_operation_locks WHERE scope = ?").run(scope);
    const key = `lock-counter:${scope}`;
    const counter = this.#db.prepare("SELECT value_json FROM platform_settings WHERE key = ?").get(key) as Row | undefined;
    const token = Number((counter ? parse<{ token?: number }>(counter.value_json).token : 0) ?? 0) + 1;
    const timestamp = now.toISOString();
    this.#db.prepare(
      `INSERT INTO platform_settings(key, value_json, version, updated_at) VALUES (?, ?, 1, ?)
       ON CONFLICT(key) DO UPDATE SET value_json = excluded.value_json, version = platform_settings.version + 1, updated_at = excluded.updated_at`
    ).run(key, json({ token }), timestamp);
    this.#db.prepare("INSERT INTO platform_operation_locks(scope, operation_id, fencing_token, expires_at, updated_at) VALUES (?, ?, ?, ?, ?)")
      .run(scope, operationId, token, new Date(now.getTime() + 30 * 60 * 1000).toISOString(), timestamp);
    return token;
  }

  #trackOperation(operation: PlatformOperation, run: (signal: AbortSignal) => Promise<void>): void {
    const controller = new AbortController();
    this.#operationControllers.set(operation.id, controller);
    const task = run(controller.signal).catch((error: unknown) => {
      this.#failOperation(operation, error, controller.signal.aborted);
    }).finally(() => {
      this.#operationControllers.delete(operation.id);
      this.#operationTasks.delete(task);
    });
    this.#operationTasks.add(task);
  }

  #progressOperation(operation: PlatformOperation, progress: number | null, message: string, detail: Record<string, unknown> = {}): void {
    const current = this.operation(operation.id);
    if (current.state !== "running" && current.state !== "pending") return;
    const now = new Date().toISOString();
    this.#versioned(() => {
      this.#appendEvent("platform_operation_progress", operation.targetType, operation.targetId, operation.id, operation.actor, {
        progress, message, ...detail
      });
      this.#db.prepare("UPDATE platform_operations SET progress = ?, message = ?, updated_at = ? WHERE id = ?")
        .run(progress === null ? null : Math.min(1, Math.max(0, progress)), message.slice(0, 500), now, operation.id);
      this.#db.prepare("UPDATE platform_operation_locks SET expires_at = ?, updated_at = ? WHERE operation_id = ?")
        .run(new Date(Date.now() + 30 * 60 * 1000).toISOString(), now, operation.id);
    });
  }

  #completeOperation(
    operation: PlatformOperation,
    message: string,
    result: Record<string, unknown>,
    beforeCompletion?: () => void
  ): void {
    const now = new Date().toISOString();
    this.#versioned(() => {
      beforeCompletion?.();
      this.#appendEvent("platform_operation_completed", operation.targetType, operation.targetId, operation.id, operation.actor, result);
      this.#db.prepare(
        "UPDATE platform_operations SET state = 'completed', progress = 1, message = ?, result_json = ?, error_json = NULL, updated_at = ?, completed_at = ? WHERE id = ?"
      ).run(message.slice(0, 500), json(result), now, now, operation.id);
      this.#db.prepare("DELETE FROM platform_operation_locks WHERE operation_id = ?").run(operation.id);
    });
  }

  #failOperation(operation: PlatformOperation, error: unknown, cancelled: boolean): void {
    const current = this.operation(operation.id);
    if (!["pending", "running"].includes(current.state)) return;
    const now = new Date().toISOString();
    const code = cancelled ? "cancelled" : error instanceof RouterError ? error.code : "operation_failed";
    const message = cancelled ? "Operation was cancelled before completion." : safeOperationMessage(error);
    this.#versioned(() => {
      this.#appendEvent(cancelled ? "platform_operation_cancelled" : "platform_operation_failed", operation.targetType, operation.targetId, operation.id, operation.actor, { code });
      this.#db.prepare("UPDATE platform_operations SET state = ?, message = ?, error_json = ?, updated_at = ?, completed_at = ? WHERE id = ?")
        .run(cancelled ? "cancelled" : "failed", message, json({ code, message }), now, now, operation.id);
      this.#db.prepare("DELETE FROM platform_operation_locks WHERE operation_id = ?").run(operation.id);
    });
  }

  #optionalLocalModel(id: string): LocalModelProjection | null {
    const row = this.#db.prepare("SELECT * FROM platform_local_models WHERE id = ?").get(id) as Row | undefined;
    return row ? mapLocalModel(row) : null;
  }

  #setLocalModelState(
    modelId: string,
    state: LocalModelProjection["state"],
    operation: PlatformOperation,
    existing: LocalModelProjection | null
  ): void {
    const now = new Date().toISOString();
    const definition = existing?.definition ?? {
      sizeBytes: null, digest: null, modifiedAt: null, capabilities: [], contextWindow: null, details: {}
    };
    this.#versioned(() => {
      this.#appendEvent("local_model_state_changed", "local-model", modelId, operation.id, operation.actor, { state });
      this.#db.prepare(
        `INSERT INTO platform_local_models(id, runtime_id, state, selected, definition_json, benchmark_json, operation_id, version, updated_at)
         VALUES (?, 'ollama', ?, 0, ?, NULL, ?, 1, ?)
         ON CONFLICT(id) DO UPDATE SET state = excluded.state, operation_id = excluded.operation_id,
           version = platform_local_models.version + 1, updated_at = excluded.updated_at`
      ).run(modelId, state, json(definition), operation.id, now);
    });
  }

  #upsertLocalModel(model: LocalModelRecord, state: LocalModelProjection["state"], operationId: string, updatedAt: string): void {
    const definition: LocalModelProjection["definition"] = {
      sizeBytes: model.sizeBytes,
      digest: model.digest,
      modifiedAt: model.modifiedAt,
      capabilities: model.capabilities,
      contextWindow: model.contextWindow,
      details: model.details
    };
    this.#db.prepare(
      `INSERT INTO platform_local_models(id, runtime_id, state, selected, definition_json, benchmark_json, operation_id, version, updated_at)
       VALUES (?, 'ollama', ?, 0, ?, NULL, ?, 1, ?)
       ON CONFLICT(id) DO UPDATE SET state = excluded.state, definition_json = excluded.definition_json,
         operation_id = excluded.operation_id, version = platform_local_models.version + 1, updated_at = excluded.updated_at`
    ).run(model.id, state, json(definition), operationId, updatedAt);
  }

  #requestCount24h(): number {
    const row = this.#db.prepare("SELECT COUNT(*) count FROM inference_requests WHERE started_at >= datetime('now', '-1 day')").get() as Row;
    return Number(row.count);
  }

  #accountQuota(providerId: string) {
    const row = this.#db.prepare("SELECT value_json FROM platform_settings WHERE key = ?").get(`quota:${providerId}`) as Row | undefined;
    return row ? parse(row.value_json) : { state: "unknown", source: null, freshness: null, windows: [] };
  }

  async #runCatalogRefresh(operation: PlatformOperation, providerId: string, signal: AbortSignal): Promise<void> {
    const provider = this.provider(providerId);
    const configured = this.#configuredProvider(providerId);
    const baseUrl = configured?.baseUrl ?? provider.baseUrl;
    if (!baseUrl) throw new RouterError("runtime_unavailable", "Provider catalog endpoint is runtime-owned and unavailable");
    const url = provider.localOnly
      ? new URL("../api/tags", `${baseUrl.replace(/\/+$/, "")}/`)
      : new URL("models", `${baseUrl.replace(/\/+$/, "")}/`);
    const headers = new Headers({ Accept: "application/json", "User-Agent": "codex-router/0.2" });
    if (!provider.localOnly) {
      const reference = configured?.credentialRef ?? provider.authentication.reference;
      if (!reference?.startsWith("env:")) throw new RouterError("runtime_unavailable", "No resolvable provider credential reference");
      const credential = process.env[reference.slice(4)];
      if (!credential) throw new RouterError("runtime_unavailable", "Provider credential reference is unresolved");
      headers.set("Authorization", `Bearer ${credential}`);
    }
    const response = await fetch(url, { headers, redirect: "manual", signal: AbortSignal.any([signal, AbortSignal.timeout(15_000)]) });
    if (response.status >= 300 && response.status < 400) throw new RouterError("protocol_incompatible", "Provider catalog returned a redirect");
    if (!response.ok) throw new RouterError("runtime_unavailable", `Provider catalog returned status ${response.status}`);
    const payload = await response.json();
    const discovered = discoveredModelIds(payload);
    const now = new Date().toISOString();
    this.#completeOperation(operation, `Discovered ${discovered.length} models; none were auto-published.`, { discovered: discovered.length }, () => {
      this.#appendEvent("provider_catalog_observed", "provider", providerId, operation.id, operation.actor, { count: discovered.length, source: provider.discovery });
      for (const upstreamId of discovered) this.#upsertDiscoveredModel(provider, upstreamId, now);
      this.#db.prepare("UPDATE platform_providers SET catalog_json = ?, version = version + 1, updated_at = ? WHERE id = ?")
        .run(json({ state: "ready", modelCount: discovered.length, refreshedAt: now }), now, providerId);
    });
  }

  #upsertDiscoveredModel(provider: ProviderProjection, upstreamId: string, now: string): void {
    const gatewayId = `${provider.id}/${upstreamId}`;
    const existing = this.#db.prepare("SELECT gateway_id FROM platform_models WHERE gateway_id = ?").get(gatewayId);
    if (existing) return;
    const definition: ModelDefinition = {
      publicSlug: gatewayId,
      gatewayId,
      upstreamId,
      providerVariant: provider.id,
      displayName: upstreamId,
      contextWindow: null,
      maxOutputTokens: null,
      provenance: "provider-discovery",
      publication: "discovered",
      requestProfile: provider.requestProfile,
      compatibilityHash: hash(json({ provider: provider.id, upstreamId, profile: provider.requestProfile })),
      capabilities: {
        input: ["text"], nativeImage: false, derivedImage: false, reasoningEfforts: [],
        defaultReasoningEffort: null, tools: false, forcedToolChoice: false, parallelTools: false,
        structuredOutput: false, standaloneSearch: false, compaction: false, collaboration: false
      },
      pricing: null
    };
    this.#db.prepare(
      `INSERT INTO platform_models(gateway_id, definition_json, definition_hash, enabled, version, compatibility_json, updated_at)
       VALUES (?, ?, ?, 0, 1, ?, ?)`
    ).run(gatewayId, json(definition), hash(json(definition)), json({ mock: "unknown", live: "unknown", checkedAt: null, profileHash: definition.compatibilityHash }), now);
  }

  #reconcileOperations(): void {
    const rows = this.#db.prepare("SELECT id, target_type, target_id, actor FROM platform_operations WHERE state IN ('pending', 'running')").all() as Row[];
    if (rows.length === 0) return;
    const now = new Date().toISOString();
    this.#versioned(() => {
      for (const row of rows) {
        this.#appendEvent("platform_operation_failed", String(row.target_type), String(row.target_id), String(row.id), "startup-reconciliation", {
          code: "interrupted_by_restart",
          previousActor: String(row.actor)
        });
        this.#db.prepare(
          "UPDATE platform_operations SET state = 'failed', message = ?, error_json = ?, updated_at = ?, completed_at = ? WHERE id = ?"
        ).run("Operation was interrupted by router restart; authoritative state must be read back before retry.",
          json({ code: "interrupted_by_restart", message: "The operation owner process restarted." }), now, now, row.id);
        if (String(row.target_type) === "local-model") {
          this.#appendEvent("local_model_reconciliation_required", "local-model", String(row.target_id), String(row.id), "startup-reconciliation", {
            state: "failed"
          });
          this.#db.prepare("UPDATE platform_local_models SET state = 'failed', version = version + 1, updated_at = ? WHERE id = ?")
            .run(now, row.target_id);
        }
        this.#db.prepare("DELETE FROM platform_operation_locks WHERE operation_id = ?").run(row.id);
      }
    });
  }

  #provider(id: string): ProviderDefinition | undefined {
    return this.#providers.find((provider) => provider.id === id);
  }

  #configuredProvider(id: string): InferenceProviderConfig | undefined {
    return this.#config?.providers.find((provider) => provider.id === id);
  }

  #synchronizeRegistry(): void {
    const now = new Date().toISOString();
    const modelCounts = new Map<string, number>();
    for (const model of this.#models) modelCounts.set(model.providerVariant, (modelCounts.get(model.providerVariant) ?? 0) + 1);
    const transaction = this.#db.transaction(() => {
      for (const definition of this.#providers) {
        const configured = this.#configuredProvider(definition.id);
        const definitionJson = json(definition);
        const definitionHash = hash(definitionJson);
        const authentication = authenticationProjection(definition, configured);
        const existing = this.#db.prepare("SELECT definition_hash, enabled, version FROM platform_providers WHERE id = ?").get(definition.id) as Row | undefined;
        const enabled = existing ? Boolean(existing.enabled) : Boolean(configured && configured.enabled !== false && authentication.state === "ready");
        const version = existing && existing.definition_hash !== definitionHash ? Number(existing.version) + 1 : Number(existing?.version ?? 1);
        this.#db.prepare(
          `INSERT INTO platform_providers(
            id, definition_json, definition_hash, enabled, version, authentication_json, entitlement_json,
            health_json, catalog_json, updated_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
          ON CONFLICT(id) DO UPDATE SET definition_json = excluded.definition_json,
            definition_hash = excluded.definition_hash, version = excluded.version,
            authentication_json = excluded.authentication_json, updated_at = excluded.updated_at`
        ).run(definition.id, definitionJson, definitionHash, enabled ? 1 : 0, version, json(authentication),
          json({ ...UNKNOWN_EVIDENCE, message: definition.planNote ?? UNKNOWN_EVIDENCE.message }),
          json(definition.localOnly && authentication.state === "ready" ? { state: "unknown", message: "Local runtime health has not been probed.", checkedAt: null } : UNKNOWN_EVIDENCE),
          json({ state: modelCounts.has(definition.id) ? "ready" : "unknown", modelCount: modelCounts.get(definition.id) ?? 0, refreshedAt: null }), now);
      }
      for (const definition of this.#models) {
        const definitionJson = json(definition);
        const definitionHash = hash(definitionJson);
        const existing = this.#db.prepare("SELECT definition_hash, enabled, version FROM platform_models WHERE gateway_id = ?").get(definition.gatewayId) as Row | undefined;
        const configuredProvider = this.#configuredProvider(definition.providerVariant);
        const configuredModel = this.#config?.models.find((model) => model.id === definition.gatewayId);
        const enabled = existing ? Boolean(existing.enabled) : Boolean(configuredProvider && configuredProvider.enabled !== false && configuredModel?.enabled);
        const version = existing && existing.definition_hash !== definitionHash ? Number(existing.version) + 1 : Number(existing?.version ?? 1);
        this.#db.prepare(
          `INSERT INTO platform_models(gateway_id, definition_json, definition_hash, enabled, version, compatibility_json, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?)
           ON CONFLICT(gateway_id) DO UPDATE SET definition_json = excluded.definition_json,
             definition_hash = excluded.definition_hash, version = excluded.version, updated_at = excluded.updated_at`
        ).run(definition.gatewayId, definitionJson, definitionHash, enabled ? 1 : 0, version,
          json({ mock: "unknown", live: "unknown", checkedAt: null, profileHash: definition.compatibilityHash }), now);
      }
    });
    transaction();
  }

  #versioned(operation: () => void): void {
    let version = 0;
    this.#db.transaction(() => {
      const row = this.#db.prepare("SELECT value FROM meta WHERE key = 'registry_version'").get() as { value: string };
      version = Number(row.value) + 1;
      this.#db.prepare("UPDATE meta SET value = ? WHERE key = 'registry_version'").run(String(version));
      operation();
    })();
    this.#registry.notifyExternalProjection(version);
  }

  #appendEvent(eventType: string, targetType: string, targetId: string, operationId: string | null, actor: string, payload: Record<string, unknown>): void {
    const now = new Date().toISOString();
    this.#db.prepare(
      `INSERT INTO platform_event_journal(event_id, event_type, target_type, target_id, operation_id, actor, payload_json, occurred_at, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(newId("platform-event"), eventType, targetType, targetId, operationId, actor, json(payload), now, now);
  }

  #insertOperation(operation: PlatformOperation): void {
    this.#db.prepare(
      `INSERT INTO platform_operations(
        id, kind, target_type, target_id, state, progress, message, actor, idempotency_key,
        expected_version, result_json, error_json, created_at, updated_at, completed_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(operation.id, operation.kind, operation.targetType, operation.targetId, operation.state, operation.progress,
      operation.message, operation.actor, operation.idempotencyKey, operation.expectedVersion,
      operation.result ? json(operation.result) : null, operation.error ? json(operation.error) : null,
      operation.createdAt, operation.updatedAt, operation.completedAt);
  }

  #operationReplay(actor: string, kind: PlatformOperationKind, idempotencyKey: string): PlatformOperation | null {
    const row = this.#db.prepare("SELECT * FROM platform_operations WHERE actor = ? AND kind = ? AND idempotency_key = ?")
      .get(actor, kind, idempotencyKey) as Row | undefined;
    return row ? mapOperation(row) : null;
  }
}

function effectiveProviders(config: InferenceConfig | undefined): ProviderDefinition[] {
  const providers = builtinProviders();
  if (!config) return providers;
  for (const configured of config.providers) {
    const index = providers.findIndex((provider) => provider.id === configured.id);
    const base = index >= 0 ? providers[index]! : customProvider(configured);
    const merged: ProviderDefinition = {
      ...base,
      displayName: configured.displayName ?? base.displayName,
      canonicalProvider: configured.canonicalProviderId ?? base.canonicalProvider,
      protocol: configured.protocol ?? base.protocol,
      baseUrl: configured.baseUrl,
      requestProfile: configured.requestProfile ?? base.requestProfile,
      credential: {
        ...base.credential,
        mechanism: configured.keyless ? "keyless" : base.credential.mechanism,
        references: configured.credentialRef ? [configured.credentialRef] : base.credential.references
      },
      publication: base.publication === "generally-available" ? "generally-available" : "experimental"
    };
    if (index >= 0) providers[index] = merged;
    else providers.push(merged);
  }
  return providers.sort((left, right) => left.id.localeCompare(right.id, "en"));
}

function customProvider(provider: InferenceProviderConfig): ProviderDefinition {
  return {
    id: provider.id,
    displayName: provider.displayName ?? provider.id,
    owner: provider.id,
    canonicalProvider: provider.canonicalProviderId ?? provider.id,
    kind: provider.keyless ? "keyless-local" : "openai-compatible",
    protocol: provider.protocol ?? "responses",
    baseUrl: provider.baseUrl,
    credential: { mechanism: provider.keyless ? "keyless" : "environment", references: provider.credentialRef ? [provider.credentialRef] : [], interactiveTerminal: false },
    requestProfile: provider.requestProfile ?? "generic-openai",
    discovery: provider.keyless ? "local-runtime" : "not-supported",
    usageAuthority: "rate-limit-headers",
    localOnly: provider.keyless,
    publication: "experimental"
  };
}

function authenticationProjection(definition: ProviderDefinition, configured: InferenceProviderConfig | undefined): ProviderProjection["authentication"] {
  if (definition.credential.mechanism === "keyless") {
    return { state: "ready", source: "loopback-keyless", reference: null, checkedAt: new Date().toISOString() };
  }
  if (definition.credential.mechanism === "native-session" || definition.credential.mechanism === "oauth-cli" || definition.credential.mechanism === "cli-session") {
    return { state: "unknown", source: definition.credential.mechanism, reference: null, checkedAt: null };
  }
  const references = configured?.credentialRef ? [configured.credentialRef] : definition.credential.references;
  const reference = references.find((entry) => entry.startsWith("env:") && Boolean(process.env[entry.slice(4)])) ?? references[0] ?? null;
  return {
    state: reference && reference.startsWith("env:") && Boolean(process.env[reference.slice(4)]) ? "ready" : "unknown",
    source: reference ? "environment" : null,
    reference,
    checkedAt: new Date().toISOString()
  };
}

function newOperation(kind: PlatformOperationKind, targetType: string, targetId: string, actor: string, input: PlatformMutationInput): PlatformOperation {
  const now = new Date().toISOString();
  return {
    id: newId("operation"), kind, targetType, targetId, state: "running", progress: 0,
    message: "Operation accepted and recorded.", actor, idempotencyKey: input.idempotencyKey,
    expectedVersion: input.expectedVersion, result: null, error: null, createdAt: now, updatedAt: now, completedAt: null
  };
}

function mapOperation(row: Row): PlatformOperation {
  return {
    id: String(row.id), kind: row.kind as PlatformOperationKind, targetType: String(row.target_type), targetId: String(row.target_id),
    state: row.state as PlatformOperation["state"], progress: nullableNumber(row.progress), message: String(row.message),
    actor: String(row.actor), idempotencyKey: String(row.idempotency_key), expectedVersion: nullableNumber(row.expected_version),
    result: row.result_json ? parse(row.result_json) : null, error: row.error_json ? parse(row.error_json) : null,
    createdAt: String(row.created_at), updatedAt: String(row.updated_at), completedAt: nullableString(row.completed_at)
  };
}

function mapRequest(row: Row): InferenceRequestRecord {
  return {
    id: String(row.id), attemptId: String(row.attempt_id), callerClass: String(row.caller_class), runtimeId: nullableString(row.runtime_id),
    providerId: String(row.provider_id), accountRefId: nullableString(row.account_ref_id), modelId: String(row.model_id), profileHash: String(row.profile_hash),
    startedAt: String(row.started_at), connectedAt: nullableString(row.connected_at), firstSemanticAt: nullableString(row.first_semantic_at),
    completedAt: nullableString(row.completed_at), status: String(row.status), errorClass: nullableString(row.error_class),
    cancelled: Boolean(row.cancelled), retryCount: Number(row.retry_count), failoverCount: Number(row.failover_count),
    semanticOutputObserved: Boolean(row.semantic_output_seen), usage: parse(row.usage_json), flags: parse(row.flags_json)
  };
}

function mapLocalModel(row: Row): LocalModelProjection {
  return {
    id: String(row.id),
    runtimeId: String(row.runtime_id),
    state: row.state as LocalModelProjection["state"],
    selected: Boolean(row.selected),
    definition: parse(row.definition_json),
    benchmark: row.benchmark_json ? parse(row.benchmark_json) : null,
    operationId: nullableString(row.operation_id),
    version: Number(row.version),
    updatedAt: String(row.updated_at)
  };
}

function mapRoutingDecision(row: Row): RoutingDecision {
  return {
    requestId: String(row.request_id),
    policyVersion: String(row.policy_version),
    catalogVersion: String(row.catalog_version),
    quotaSnapshotVersion: nullableString(row.quota_snapshot_version),
    selected: parse(row.selected_json),
    candidates: parse(row.candidates_json),
    createdAt: String(row.created_at)
  };
}

function modelDefinition(model: ModelProjection): ModelDefinition {
  const { version: _version, enabled: _enabled, compatibility: _compatibility, ...definition } = model;
  return definition;
}

function discoveredModelIds(payload: unknown): string[] {
  const record = payload && typeof payload === "object" && !Array.isArray(payload) ? payload as Record<string, unknown> : {};
  const entries = Array.isArray(record.data) ? record.data : Array.isArray(record.models) ? record.models : [];
  const ids = entries.map((entry) => {
    if (typeof entry === "string") return entry;
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) return null;
    const model = entry as Record<string, unknown>;
    return typeof model.id === "string" ? model.id : typeof model.name === "string" ? model.name : null;
  }).filter((value): value is string => Boolean(value && value.length <= 240 && !value.includes("\0")));
  return [...new Set(ids)].sort((left, right) => left.localeCompare(right, "en"));
}

function normalizedQuota(headers: Headers, status: number, observedAt: string) {
  const remainingRequests = headerNumber(headers, ["x-ratelimit-remaining-requests", "ratelimit-remaining"]);
  const remainingTokens = headerNumber(headers, ["x-ratelimit-remaining-tokens"]);
  const limitRequests = headerNumber(headers, ["x-ratelimit-limit-requests", "ratelimit-limit"]);
  const limitTokens = headerNumber(headers, ["x-ratelimit-limit-tokens"]);
  const reset = ["x-ratelimit-reset-requests", "ratelimit-reset", "retry-after"]
    .map((name) => headers.get(name))
    .find(Boolean) ?? null;
  const observed = [remainingRequests, remainingTokens, limitRequests, limitTokens].some((value) => value !== null) || reset !== null;
  return {
    state: status === 429 ? "restricted" : observed ? "ready" : "unknown",
    source: observed || status === 429 ? "response-headers" : null,
    freshness: observedAt,
    windows: observed ? [{ remainingRequests, remainingTokens, limitRequests, limitTokens, reset }] : []
  };
}

function quotaFraction(value: unknown): number | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const windows = Array.isArray((value as Record<string, unknown>).windows) ? (value as { windows: unknown[] }).windows : [];
  const fractions = windows.flatMap((window) => {
    if (!window || typeof window !== "object" || Array.isArray(window)) return [];
    const record = window as Record<string, unknown>;
    const values: number[] = [];
    for (const [remainingKey, limitKey] of [["remainingRequests", "limitRequests"], ["remainingTokens", "limitTokens"]] as const) {
      const remaining = Number(record[remainingKey]);
      const limit = Number(record[limitKey]);
      if (Number.isFinite(remaining) && Number.isFinite(limit) && limit > 0) values.push(Math.min(1, Math.max(0, remaining / limit)));
    }
    return values;
  });
  return fractions.length ? Math.min(...fractions) : null;
}

function safeOperationMessage(error: unknown): string {
  const fallback = "Platform operation failed before authoritative readback completed.";
  if (!(error instanceof Error)) return fallback;
  const value = error.message
    .split(/\r?\n/)
    .filter((line) => !/(authorization|token|api[-_ ]?key|secret)\s*[:=]/i.test(line))
    .join(" ")
    .trim()
    .slice(0, 500);
  return value || fallback;
}

function safeInstallPlan(plan: InstallPlan): Record<string, unknown> {
  return {
    id: plan.id,
    host: plan.host,
    root: plan.root,
    releaseRoot: plan.releaseRoot,
    previousRelease: plan.previousRelease,
    version: plan.version,
    releaseSource: plan.releaseSource,
    entrypoint: plan.entrypoint,
    configPath: plan.configPath,
    serviceFile: plan.serviceFile,
    manifestFile: plan.manifestFile,
    checks: plan.checks
  };
}

function safeInstallManifest(manifest: InstallManifest, manifestFile?: string): Record<string, unknown> {
  return {
    owner: manifest.owner,
    version: manifest.version,
    host: manifest.host,
    releaseVersion: manifest.releaseVersion,
    activeRelease: manifest.activeRelease,
    previousRelease: manifest.previousRelease,
    executableFile: manifest.executableFile,
    entrypoint: manifest.entrypoint,
    configPath: manifest.configPath,
    serviceFile: manifest.serviceFile,
    ...(manifestFile ? { manifestFile } : {}),
    hashes: manifest.hashes,
    installedAt: manifest.installedAt,
    state: manifest.state
  };
}

function headerNumber(headers: Headers, names: string[]): number | null {
  for (const name of names) {
    const value = headers.get(name);
    if (value === null) continue;
    const number = Number(value);
    if (Number.isFinite(number) && number >= 0) return number;
  }
  return null;
}

function capabilityLedger(): CapabilityLedgerEntry[] {
  return [
    { id: "registry", capability: "Provider and model registry with safe overlays", disposition: "adopted", phase: 0, owner: "platform registry", evidence: "src/platform/builtin-registry.ts; registry tests" },
    { id: "translation", capability: "LiteLLM translation behind the secure Node edge", disposition: "adopted", phase: 1, owner: "inference edge", evidence: "generated config, pinned lock, gateway contracts" },
    { id: "credentials", capability: "Credential-isolating forwarding", disposition: "adopted", phase: 1, owner: "inference edge", evidence: "strict header and canary-secret tests" },
    { id: "oauth", capability: "Official OAuth, CLI-session, and native login ownership", disposition: "adopted", phase: 3, owner: "provider operations", evidence: "official CLI operations and protected readback; per-provider live matrix remains a release gate" },
    { id: "native-catalog", capability: "Native Codex catalog capture and merge", disposition: "adopted", phase: 3, owner: "catalog authority", evidence: "account/client cohort and schema-clone contracts; installed Codex smoke remains" },
    { id: "profiles", capability: "Provider request-profile normalization", disposition: "adopted", phase: 4, owner: "profile engine", evidence: "src/platform/profiles.ts exact-body fixtures" },
    { id: "tools", capability: "Namespaced Codex app-tool relay", disposition: "adopted", phase: 4, owner: "compatibility edge", evidence: "allowlist, ambiguity, JSON, and SSE namespace contracts" },
    { id: "collaboration", capability: "Routed collaboration payload boundary", disposition: "adopted", phase: 4, owner: "compatibility edge", evidence: "native ciphertext preservation and router-plaintext normalization; live spawn remains" },
    { id: "compaction", capability: "Router-owned signed compaction envelopes", disposition: "adopted", phase: 4, owner: "compatibility edge", evidence: "bounded integrity and continuation contracts" },
    { id: "tool-aging", capability: "Tool-result aging", disposition: "adopted", phase: 4, owner: "compatibility edge", evidence: "opt-in receipt policy preserves recent and error evidence" },
    { id: "vision", capability: "Governed vision bridge", disposition: "adopted", phase: 5, owner: "vision service", evidence: "deduplication, provenance, host/byte policy, and image-leak tests; live quota review remains" },
    { id: "local", capability: "Local model lifecycle and measured selection", disposition: "adopted", phase: 5, owner: "local model operations", evidence: "consented download/removal, progress, cancellation, benchmark, and restart contracts; models remain experimental" },
    { id: "routing", capability: "Event-aware pre-output retry and failover", disposition: "superseded", phase: 6, owner: "secure edge", evidence: "semantic boundary disables blind replay" },
    { id: "usage", capability: "Usage, quota, routing evidence, and versioned cost estimates", disposition: "adopted", phase: 6, owner: "platform service", evidence: "provider truth, freshness, and pricing provenance remain distinct" },
    { id: "operations", capability: "Durable platform operations and diagnostics", disposition: "adopted", phase: 7, owner: "platform service", evidence: "event-before-projection journal and versioned mutations" },
    { id: "installer", capability: "Guided install, update, rollback, disable, and uninstall", disposition: "adopted", phase: 7, owner: "installation service", evidence: "transaction, integrity, consent, lock, API, CLI, and Console tests; cross-platform artifact matrix remains" },
    { id: "tray", capability: "Native tray control panel", disposition: "superseded", phase: 7, owner: "Web Console", evidence: "responsive Console remains complete authority" },
    { id: "skill-pack", capability: "Router-managed optional skill pack", disposition: "deferred", phase: 7, owner: "future optional capability", evidence: "not installed implicitly; ownership/collision lifecycle required before shipping" },
    { id: "compatible-clients", capability: "Compatible non-Codex client profiles", disposition: "deferred", phase: 7, owner: "compatibility program", evidence: "each client requires an explicit contract; SDK similarity is insufficient" },
    { id: "homebrew", capability: "Homebrew core publication", disposition: "deferred", phase: 7, owner: "release engineering", evidence: "packaging channel decision remains explicit" },
    { id: "fixed-ports", capability: "Reference fixed ports and source layout", disposition: "rejected", phase: 0, owner: "architecture", evidence: "ephemeral/managed ports and event-sourced architecture are authoritative" }
  ];
}

function emptyUsage(): InferenceRequestRecord["usage"] {
  return { providerInputTokens: null, providerOutputTokens: null, cachedInputTokens: null, reasoningTokens: null, estimatedInputTokens: null };
}

function hash(value: string): string { return createHash("sha256").update(value).digest("hex"); }
function json(value: unknown): string { return JSON.stringify(value); }
function parse<T = Record<string, unknown>>(value: unknown): T { return JSON.parse(String(value)) as T; }
function nullableString(value: unknown): string | null { return value === null || value === undefined ? null : String(value); }
function nullableNumber(value: unknown): number | null { return value === null || value === undefined ? null : Number(value); }
