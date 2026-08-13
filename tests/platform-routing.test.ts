import { describe, expect, it } from "vitest";
import { estimatedCost, evaluateCandidates, hysteresisState, retryAllowed } from "../src/platform/routing.js";
import type { ModelProjection, ProviderProjection } from "../src/platform/types.js";

describe("routing authority", () => {
  it("records deterministic rejection reasons and keeps continuation affinity dominant", () => {
    const first = candidate("a", "model-a", 0.1, 3);
    const second = candidate("b", "model-b", 1, 0);
    const decisions = evaluateCandidates([first, second], {
      continuation: { providerId: "a", accountRefId: "account:a", modelId: "model-a" },
      require: ["tools"]
    });
    expect(decisions[0]).toMatchObject({ providerId: "a", eligible: true });
    expect(decisions[1]!.reasons).toContain("continuation-affinity-mismatch");
  });

  it("fails closed for stale identity, entitlement, capability, and quota", () => {
    const input = candidate("a", "model-a", 0, 0);
    input.provider.authentication.state = "stale";
    input.provider.entitlement.state = "restricted";
    input.model.capabilities.tools = false;
    const [decision] = evaluateCandidates([input], { require: ["tools"] });
    expect(decision).toMatchObject({ eligible: false, score: -1 });
    expect(decision!.reasons).toEqual(expect.arrayContaining(["authentication-stale", "entitlement-restricted", "missing-tools", "quota-exhausted"]));
  });

  it("permits retries only when origin execution is proven absent before commitment", () => {
    expect(retryAllowed({ responseCommitted: false, semanticOutputObserved: false, sideEffectObserved: false, originExecutionProvenAbsent: true, status: null, errorClass: "connect-refused" })).toBe(true);
    expect(retryAllowed({ responseCommitted: false, semanticOutputObserved: true, sideEffectObserved: false, originExecutionProvenAbsent: true, status: null, errorClass: "connect-refused" })).toBe(false);
    expect(retryAllowed({ responseCommitted: false, semanticOutputObserved: false, sideEffectObserved: false, originExecutionProvenAbsent: false, status: 429, errorClass: "provider" })).toBe(false);
  });

  it("uses quota hysteresis and computes only provenance-backed estimates", () => {
    expect(hysteresisState("critical", 0.21, { limited: 0.2, critical: 0.05, recoverMargin: 0.05 })).toBe("critical");
    expect(hysteresisState("critical", 0.26, { limited: 0.2, critical: 0.05, recoverMargin: 0.05 })).toBe("ready");
    const model = candidate("a", "model-a", 1, 0).model;
    model.pricing = { source: "checked", version: "2026-08", inputPerMillion: 2, outputPerMillion: 8 };
    expect(estimatedCost(model, { inputTokens: 1_000_000, outputTokens: 500_000 })).toMatchObject({ amount: 6, estimated: true });
  });
});

function candidate(providerId: string, modelId: string, quotaRemainingFraction: number, activeRequests: number) {
  const provider: ProviderProjection = {
    id: providerId,
    displayName: providerId,
    owner: providerId,
    canonicalProvider: providerId,
    kind: "openai-compatible",
    protocol: "responses",
    baseUrl: "https://example.test",
    credential: { mechanism: "environment", references: [`env:${providerId.toUpperCase()}_KEY`], interactiveTerminal: false },
    requestProfile: "generic-openai",
    discovery: "provider-api",
    usageAuthority: "rate-limit-headers",
    localOnly: false,
    publication: "generally-available",
    version: 1,
    enabled: true,
    authentication: { state: "ready", source: "environment", reference: "env:KEY", checkedAt: "now" },
    entitlement: { state: "ready", message: "ready", checkedAt: "now" },
    health: { state: "ready", message: "ready", checkedAt: "now" },
    catalog: { state: "ready", modelCount: 1, refreshedAt: "now" }
  };
  const model: ModelProjection = {
    publicSlug: modelId,
    gatewayId: modelId,
    upstreamId: modelId,
    providerVariant: providerId,
    displayName: modelId,
    contextWindow: 100,
    maxOutputTokens: 10,
    provenance: "checked-in",
    publication: "listed",
    requestProfile: "generic-openai",
    compatibilityHash: "hash",
    capabilities: { input: ["text"], nativeImage: false, derivedImage: false, reasoningEfforts: [], defaultReasoningEffort: null, tools: true, forcedToolChoice: false, parallelTools: false, structuredOutput: false, standaloneSearch: false, compaction: true, collaboration: false },
    pricing: null,
    version: 1,
    enabled: true,
    compatibility: { mock: "ready", live: "unknown", checkedAt: "now", profileHash: "hash" }
  };
  return { provider, model, accountRefId: `account:${providerId}`, activeRequests, quotaRemainingFraction, lastSelectedAt: null };
}
