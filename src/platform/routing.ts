import type { ModelProjection, ProviderProjection } from "./types.js";

export interface RouteConstraints {
  requestedModel?: string;
  continuation?: { providerId: string; accountRefId: string | null; modelId: string };
  require: Array<"tools" | "images" | "structured-output" | "search" | "compaction" | "collaboration">;
  projectAllowedProviders?: string[];
}

export interface CandidateInput {
  provider: ProviderProjection;
  model: ModelProjection;
  accountRefId: string | null;
  activeRequests: number;
  quotaRemainingFraction: number | null;
  lastSelectedAt: string | null;
}

export interface CandidateDecision {
  providerId: string;
  accountRefId: string | null;
  modelId: string;
  eligible: boolean;
  score: number;
  reasons: string[];
}

export interface RetryObservation {
  responseCommitted: boolean;
  semanticOutputObserved: boolean;
  sideEffectObserved: boolean;
  originExecutionProvenAbsent: boolean;
  status: number | null;
  errorClass: string;
}

export function evaluateCandidates(inputs: CandidateInput[], constraints: RouteConstraints): CandidateDecision[] {
  return inputs.map((input) => {
    const reasons: string[] = [];
    const { provider, model } = input;
    if (!provider.enabled) reasons.push("provider-disabled");
    if (!model.enabled) reasons.push("model-disabled");
    if (provider.authentication.state !== "ready" && provider.credential.mechanism !== "keyless") reasons.push(`authentication-${provider.authentication.state}`);
    if (["restricted", "unavailable"].includes(provider.entitlement.state)) reasons.push(`entitlement-${provider.entitlement.state}`);
    if (["restricted", "unavailable"].includes(provider.health.state)) reasons.push(`health-${provider.health.state}`);
    if (constraints.requestedModel && model.gatewayId !== constraints.requestedModel) reasons.push("model-not-requested");
    if (constraints.projectAllowedProviders && !constraints.projectAllowedProviders.includes(provider.id)) reasons.push("project-authority");
    for (const capability of constraints.require) if (!supports(model, capability)) reasons.push(`missing-${capability}`);
    if (input.quotaRemainingFraction !== null && input.quotaRemainingFraction <= 0) reasons.push("quota-exhausted");
    let score = 0;
    if (constraints.continuation) {
      if (constraints.continuation.providerId === provider.id && constraints.continuation.modelId === model.gatewayId && constraints.continuation.accountRefId === input.accountRefId) {
        score += 10_000;
      } else {
        reasons.push("continuation-affinity-mismatch");
      }
    }
    score += Math.round((input.quotaRemainingFraction ?? 0.5) * 1_000);
    score += provider.health.state === "ready" ? 500 : provider.health.state === "degraded" ? 100 : 0;
    score -= input.activeRequests * 25;
    if (input.lastSelectedAt) score += Math.min(100, Math.floor((Date.now() - Date.parse(input.lastSelectedAt)) / 60_000));
    const eligible = reasons.length === 0;
    return { providerId: provider.id, accountRefId: input.accountRefId, modelId: model.gatewayId, eligible, score: eligible ? score : -1, reasons };
  }).sort((left, right) => right.score - left.score || left.modelId.localeCompare(right.modelId, "en"));
}

export function selectCandidate(inputs: CandidateInput[], constraints: RouteConstraints): CandidateDecision {
  const candidates = evaluateCandidates(inputs, constraints);
  const selected = candidates.find((candidate) => candidate.eligible);
  if (!selected) throw new Error(`No eligible route: ${candidates.flatMap((candidate) => candidate.reasons).join(", ") || "empty candidate set"}`);
  return selected;
}

export function retryAllowed(observation: RetryObservation): boolean {
  if (observation.responseCommitted || observation.semanticOutputObserved || observation.sideEffectObserved) return false;
  if (!observation.originExecutionProvenAbsent) return false;
  if ([429, 400, 401, 403, 404, 409, 500].includes(observation.status ?? -1)) return false;
  return ["connect-refused", "dns-not-found", "tls-before-request", "intermediary-502", "intermediary-503", "intermediary-504"].includes(observation.errorClass);
}

export function hysteresisState(
  previous: "ready" | "limited" | "critical" | "exhausted" | "unknown",
  remainingFraction: number | null,
  policy: { limited: number; critical: number; recoverMargin: number }
): "ready" | "limited" | "critical" | "exhausted" | "unknown" {
  if (remainingFraction === null || !Number.isFinite(remainingFraction)) return "unknown";
  if (remainingFraction <= 0) return "exhausted";
  if (previous === "exhausted" && remainingFraction < policy.critical + policy.recoverMargin) return "exhausted";
  if (previous === "critical" && remainingFraction < policy.limited + policy.recoverMargin) return "critical";
  if (previous === "limited" && remainingFraction < policy.limited + policy.recoverMargin) return "limited";
  if (remainingFraction <= policy.critical) return "critical";
  if (remainingFraction <= policy.limited) return "limited";
  return "ready";
}

export function estimatedCost(
  model: ModelProjection,
  usage: { inputTokens: number | null; outputTokens: number | null }
): { amount: number; currency: "USD"; provenance: { source: string; version: string }; estimated: true } | null {
  if (!model.pricing || usage.inputTokens === null || usage.outputTokens === null) return null;
  const amount = usage.inputTokens / 1_000_000 * model.pricing.inputPerMillion + usage.outputTokens / 1_000_000 * model.pricing.outputPerMillion;
  return {
    amount: Number(amount.toFixed(8)),
    currency: "USD",
    provenance: { source: model.pricing.source, version: model.pricing.version },
    estimated: true
  };
}

function supports(model: ModelProjection, capability: RouteConstraints["require"][number]): boolean {
  if (capability === "tools") return model.capabilities.tools;
  if (capability === "images") return model.capabilities.input.includes("image") || model.capabilities.derivedImage;
  if (capability === "structured-output") return model.capabilities.structuredOutput;
  if (capability === "search") return model.capabilities.standaloneSearch;
  if (capability === "compaction") return model.capabilities.compaction;
  return model.capabilities.collaboration;
}
