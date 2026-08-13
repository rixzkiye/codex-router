import { createHash } from "node:crypto";
import type { ModelProjection } from "./types.js";

export interface NativeCatalogSnapshot {
  accountRefId: string;
  clientVersion: string;
  etag: string | null;
  catalog: Record<string, unknown>;
  hash: string;
  observedAt: string;
}

export interface CatalogMergeResult {
  catalog: Record<string, unknown>;
  nativeCount: number;
  externalCount: number;
  hash: string;
}

export function captureNativeCatalog(input: {
  accountRefId: string;
  clientVersion: string;
  etag?: string | null;
  catalog: unknown;
  observedAt?: string;
}): NativeCatalogSnapshot {
  const catalog = validateCatalog(input.catalog);
  return {
    accountRefId: input.accountRefId,
    clientVersion: input.clientVersion,
    etag: input.etag ?? null,
    catalog,
    hash: digest(catalog),
    observedAt: input.observedAt ?? new Date().toISOString()
  };
}

export function mergeNativeCatalog(
  snapshot: NativeCatalogSnapshot,
  externalModels: ModelProjection[],
  options: { providerSlug: string; requireLiveCompatibility?: boolean }
): CatalogMergeResult {
  const native = modelArray(snapshot.catalog);
  if (native.length === 0 && externalModels.length > 0) {
    throw new Error("Cannot merge external models without a native catalog schema template from the supported Codex client");
  }
  const existing = new Set(native.map(modelIdentifier).filter((value): value is string => Boolean(value)));
  const publishable = externalModels.filter((model) =>
    model.enabled &&
    ["mock-compatible", "live-compatible", "listed"].includes(model.publication) &&
    (!options.requireLiveCompatibility || model.compatibility.live === "ready")
  );
  const template = native[0];
  const additions = publishable.map((model) => {
    if (existing.has(model.gatewayId) || existing.has(model.publicSlug)) throw new Error(`External model collides with native catalog identity: ${model.gatewayId}`);
    return cloneExternalModel(template!, model, options.providerSlug);
  });
  const merged = structuredClone(snapshot.catalog);
  setModelArray(merged, [...native.map((entry) => structuredClone(entry)), ...additions]);
  return { catalog: merged, nativeCount: native.length, externalCount: additions.length, hash: digest(merged) };
}

export function catalogFresh(snapshot: NativeCatalogSnapshot, input: { accountRefId: string; clientVersion: string; maxAgeMs: number; now?: number }): boolean {
  if (snapshot.accountRefId !== input.accountRefId || snapshot.clientVersion !== input.clientVersion) return false;
  const observed = Date.parse(snapshot.observedAt);
  return Number.isFinite(observed) && (input.now ?? Date.now()) - observed <= input.maxAgeMs;
}

function cloneExternalModel(template: Record<string, unknown>, model: ModelProjection, providerSlug: string): Record<string, unknown> {
  const entry = structuredClone(template);
  replaceExisting(entry, ["id", "slug", "model", "model_id"], model.gatewayId);
  replaceExisting(entry, ["display_name", "displayName", "name"], model.displayName);
  replaceExisting(entry, ["owned_by", "provider", "provider_id"], providerSlug);
  replaceExisting(entry, ["context_window", "contextWindow"], model.contextWindow);
  replaceExisting(entry, ["max_output_tokens", "maxOutputTokens"], model.maxOutputTokens);
  replaceExisting(entry, ["input_modalities", "inputModalities"], [...model.capabilities.input]);
  replaceExisting(entry, ["supported_reasoning_efforts", "reasoningEfforts"], [...model.capabilities.reasoningEfforts]);
  replaceExisting(entry, ["default_reasoning_effort", "defaultReasoningEffort"], model.capabilities.defaultReasoningEffort);
  entry.codex_router = {
    external: true,
    gateway_id: model.gatewayId,
    upstream_id: model.upstreamId,
    provider_variant: model.providerVariant,
    compatibility_hash: model.compatibilityHash,
    compatibility: structuredClone(model.compatibility),
    capabilities: structuredClone(model.capabilities)
  };
  return entry;
}

function replaceExisting(target: Record<string, unknown>, keys: string[], value: unknown): void {
  const present = keys.find((key) => key in target);
  target[present ?? keys[0]!] = value;
}

function validateCatalog(value: unknown): Record<string, unknown> {
  if (!isRecord(value)) throw new Error("Native Codex catalog must be an object");
  const entries = modelArray(value);
  if (!entries.every(isRecord)) throw new Error("Native Codex catalog model entries must be objects");
  const ids = entries.map(modelIdentifier);
  if (ids.some((id) => !id)) throw new Error("Native Codex catalog contains an entry without a stable model identity");
  if (new Set(ids).size !== ids.length) throw new Error("Native Codex catalog contains duplicate model identities");
  return structuredClone(value);
}

function modelArray(catalog: Record<string, unknown>): Record<string, unknown>[] {
  const value = Array.isArray(catalog.models) ? catalog.models : Array.isArray(catalog.data) ? catalog.data : null;
  if (!value) throw new Error("Unsupported native Codex catalog shape");
  return value as Record<string, unknown>[];
}

function setModelArray(catalog: Record<string, unknown>, models: Record<string, unknown>[]): void {
  if (Array.isArray(catalog.models)) catalog.models = models;
  else if (Array.isArray(catalog.data)) catalog.data = models;
  else throw new Error("Unsupported native Codex catalog shape");
}

function modelIdentifier(model: Record<string, unknown>): string | null {
  for (const key of ["id", "slug", "model", "model_id"]) {
    if (typeof model[key] === "string" && model[key]) return model[key];
  }
  return null;
}

function digest(value: unknown): string {
  return createHash("sha256").update(stableJson(value)).digest("hex");
}

function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (isRecord(value)) return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableJson(value[key])}`).join(",")}}`;
  return JSON.stringify(value);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
