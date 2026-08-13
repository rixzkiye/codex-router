import { createHash } from "node:crypto";
import type Database from "better-sqlite3";
import type { InferenceConfig, InferenceProviderConfig } from "../config.js";
import { RouterError } from "../errors.js";
import { newId } from "../security.js";
import type { Registry } from "../store/registry.js";
import { generatePlatformArtifacts } from "./artifacts.js";
import { builtinProviders, configuredModels, registryHash } from "./builtin-registry.js";
import { applyRequestProfile } from "./profiles.js";
import type {
  CapabilityLedgerEntry,
  DoctorCheck,
  InferenceRequestRecord,
  ModelDefinition,
  ModelProjection,
  PlatformMutationInput,
  PlatformOperation,
  PlatformOperationKind,
  ProviderDefinition,
  ProviderProjection
} from "./types.js";

type Row = Record<string, unknown>;

const UNKNOWN_EVIDENCE = Object.freeze({ state: "unknown" as const, message: "No authoritative observation is available.", checkedAt: null });

export class PlatformService {
  readonly #db: Database.Database;
  readonly #registry: Registry;
  readonly #config: InferenceConfig | undefined;
  readonly #providers: ProviderDefinition[];
  readonly #models: ModelDefinition[];
  readonly #operationControllers = new Set<AbortController>();
  readonly #operationTasks = new Set<Promise<void>>();
  readonly manifest: ReturnType<typeof generatePlatformArtifacts>["manifest"] | null;

  constructor(database: Database.Database, registry: Registry, config: InferenceConfig | undefined) {
    this.#db = database;
    this.#registry = registry;
    this.#config = config;
    this.#providers = effectiveProviders(config);
    this.#models = configuredModels(config);
    const hash = registryHash(this.#providers, this.#models);
    this.manifest = config ? generatePlatformArtifacts(config, hash).manifest : null;
    this.#synchronizeRegistry();
    this.#reconcileOperations();
  }

  async close(): Promise<void> {
    for (const controller of this.#operationControllers) controller.abort();
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
      localModels: models.filter((model) => this.#provider(model.providerVariant)?.localOnly),
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
    const definition = this.#provider(providerId)!;
    const authentication = authenticationProjection(definition, this.#configuredProvider(providerId));
    const operation = newOperation(kind, "provider", providerId, actor, input);
    const now = new Date().toISOString();
    this.#versioned(() => {
      this.#appendEvent("platform_operation_started", "provider", providerId, operation.id, actor, { kind });
      this.#insertOperation(operation);
      this.#appendEvent("provider_authentication_observed", "provider", providerId, operation.id, actor, { state: authentication.state, source: authentication.source });
      this.#db.prepare("UPDATE platform_providers SET authentication_json = ?, version = version + 1, updated_at = ? WHERE id = ?")
        .run(json(authentication), now, providerId);
      this.#appendEvent("platform_operation_completed", "provider", providerId, operation.id, actor, { authenticationState: authentication.state });
      this.#db.prepare("UPDATE platform_operations SET state = 'completed', progress = 1, message = ?, result_json = ?, updated_at = ?, completed_at = ? WHERE id = ?")
        .run(`Authentication readback: ${authentication.state}.`, json({ authentication }), now, now, operation.id);
    });
    return this.operation(operation.id);
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
    const operation = newOperation(kind, "provider", providerId, actor, input);
    this.#versioned(() => {
      this.#appendEvent("platform_operation_started", "provider", providerId, operation.id, actor, { kind });
      this.#insertOperation(operation);
    });
    const controller = new AbortController();
    this.#operationControllers.add(controller);
    const task = this.#runCatalogRefresh(operation.id, providerId, actor, controller.signal).finally(() => {
      this.#operationControllers.delete(controller);
      this.#operationTasks.delete(task);
    });
    this.#operationTasks.add(task);
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
    return {
      provenance: "provider-reported and separately labeled estimates",
      totals: totals.map((row) => ({
        providerId: String(row.provider_id), modelId: String(row.model_id), requests: Number(row.request_count),
        inputTokens: nullableNumber(row.input_tokens), outputTokens: nullableNumber(row.output_tokens),
        cachedInputTokens: nullableNumber(row.cached_input_tokens), reasoningTokens: nullableNumber(row.reasoning_tokens),
        estimatedInputTokens: nullableNumber(row.estimated_input_tokens), updatedAt: String(row.updated_at)
      }))
    };
  }

  beginRequest(input: Omit<InferenceRequestRecord, "connectedAt" | "firstSemanticAt" | "completedAt" | "status" | "errorClass" | "cancelled" | "retryCount" | "failoverCount" | "semanticOutputObserved" | "usage" | "flags">): void {
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

  #requestCount24h(): number {
    const row = this.#db.prepare("SELECT COUNT(*) count FROM inference_requests WHERE started_at >= datetime('now', '-1 day')").get() as Row;
    return Number(row.count);
  }

  #accountQuota(providerId: string) {
    const row = this.#db.prepare("SELECT value_json FROM platform_settings WHERE key = ?").get(`quota:${providerId}`) as Row | undefined;
    return row ? parse(row.value_json) : { state: "unknown", source: null, freshness: null, windows: [] };
  }

  async #runCatalogRefresh(operationId: string, providerId: string, actor: string, signal: AbortSignal): Promise<void> {
    const provider = this.provider(providerId);
    try {
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
      this.#versioned(() => {
        this.#appendEvent("provider_catalog_observed", "provider", providerId, operationId, actor, { count: discovered.length, source: provider.discovery });
        for (const upstreamId of discovered) this.#upsertDiscoveredModel(provider, upstreamId, now);
        this.#db.prepare("UPDATE platform_providers SET catalog_json = ?, version = version + 1, updated_at = ? WHERE id = ?")
          .run(json({ state: "ready", modelCount: discovered.length, refreshedAt: now }), now, providerId);
        this.#appendEvent("platform_operation_completed", "provider", providerId, operationId, actor, { discovered: discovered.length });
        this.#db.prepare("UPDATE platform_operations SET state = 'completed', progress = 1, message = ?, result_json = ?, updated_at = ?, completed_at = ? WHERE id = ?")
          .run(`Discovered ${discovered.length} models; none were auto-published.`, json({ discovered: discovered.length }), now, now, operationId);
      });
    } catch (error) {
      const now = new Date().toISOString();
      const message = error instanceof RouterError ? error.message : "Provider catalog request failed";
      this.#versioned(() => {
        this.#appendEvent("platform_operation_failed", "provider", providerId, operationId, actor, { code: "catalog_refresh_failed" });
        this.#db.prepare("UPDATE platform_providers SET catalog_json = ?, version = version + 1, updated_at = ? WHERE id = ?")
          .run(json({ state: "degraded", modelCount: provider.catalog.modelCount, refreshedAt: provider.catalog.refreshedAt }), now, providerId);
        this.#db.prepare("UPDATE platform_operations SET state = 'failed', message = ?, error_json = ?, updated_at = ?, completed_at = ? WHERE id = ?")
          .run(message, json({ code: "catalog_refresh_failed", message }), now, now, operationId);
      });
    }
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
        const enabled = existing ? Boolean(existing.enabled) : Boolean(configuredProvider && configuredProvider.enabled !== false);
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
      publication: "generally-available"
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
    publication: "generally-available"
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
    { id: "oauth", capability: "Official OAuth and CLI-session ownership", disposition: "deferred", phase: 3, owner: "provider operations", evidence: "requires official CLI live matrix before GA" },
    { id: "profiles", capability: "Provider request-profile normalization", disposition: "adopted", phase: 4, owner: "profile engine", evidence: "src/platform/profiles.ts exact-body fixtures" },
    { id: "vision", capability: "Governed vision bridge", disposition: "deferred", phase: 5, owner: "vision service", evidence: "blocked from GA until quota and transcript-dedup E2E" },
    { id: "local", capability: "Local model discovery and validation", disposition: "deferred", phase: 5, owner: "local model operations", evidence: "experimental registry boundary only; live runtime checks remain" },
    { id: "routing", capability: "Event-aware pre-output retry and failover", disposition: "superseded", phase: 6, owner: "secure edge", evidence: "semantic boundary disables blind replay" },
    { id: "operations", capability: "Durable platform operations and diagnostics", disposition: "adopted", phase: 7, owner: "platform service", evidence: "event-before-projection journal and versioned mutations" },
    { id: "tray", capability: "Native tray control panel", disposition: "superseded", phase: 7, owner: "Web Console", evidence: "responsive Console remains complete authority" },
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
