import { describe, expect, it } from "vitest";
import { captureNativeCatalog, catalogFresh, mergeNativeCatalog } from "../src/platform/catalog.js";
import type { ModelProjection } from "../src/platform/types.js";

describe("native Codex catalog merge", () => {
  it("preserves complete native objects and clones the current schema for external models", () => {
    const snapshot = captureNativeCatalog({
      accountRefId: "account:native-a",
      clientVersion: "codex-1",
      observedAt: "2026-08-13T00:00:00.000Z",
      catalog: { models: [{ id: "gpt-native", display_name: "Native", owned_by: "openai", context_window: 100, extra_from_client: { retained: true } }], cursor: "native-cursor" }
    });
    const result = mergeNativeCatalog(snapshot, [model()], { providerSlug: "codex-router" });
    const models = result.catalog.models as Array<Record<string, unknown>>;
    expect(models[0]).toEqual({ id: "gpt-native", display_name: "Native", owned_by: "openai", context_window: 100, extra_from_client: { retained: true } });
    expect(models[1]).toMatchObject({ id: "external/model", display_name: "External", owned_by: "codex-router", extra_from_client: { retained: true } });
    expect(result.catalog.cursor).toBe("native-cursor");
  });

  it("keys freshness to account and compatible client version", () => {
    const snapshot = captureNativeCatalog({ accountRefId: "a", clientVersion: "1", observedAt: "2026-08-13T00:00:00.000Z", catalog: { data: [{ id: "native" }] } });
    expect(catalogFresh(snapshot, { accountRefId: "a", clientVersion: "1", maxAgeMs: 1_000, now: Date.parse(snapshot.observedAt) + 500 })).toBe(true);
    expect(catalogFresh(snapshot, { accountRefId: "b", clientVersion: "1", maxAgeMs: 1_000 })).toBe(false);
  });

  it("fails rather than approximating a missing schema or colliding with native identity", () => {
    const empty = captureNativeCatalog({ accountRefId: "a", clientVersion: "1", catalog: { models: [] } });
    expect(() => mergeNativeCatalog(empty, [model()], { providerSlug: "router" })).toThrow(/schema template/);
    const collision = captureNativeCatalog({ accountRefId: "a", clientVersion: "1", catalog: { models: [{ id: "external/model" }] } });
    expect(() => mergeNativeCatalog(collision, [model()], { providerSlug: "router" })).toThrow(/collides/);
  });
});

function model(): ModelProjection {
  return {
    publicSlug: "external/model",
    gatewayId: "external/model",
    upstreamId: "model",
    providerVariant: "external",
    displayName: "External",
    contextWindow: 200,
    maxOutputTokens: 20,
    provenance: "checked-in",
    publication: "listed",
    requestProfile: "generic-openai",
    compatibilityHash: "hash",
    capabilities: { input: ["text"], nativeImage: false, derivedImage: false, reasoningEfforts: ["high"], defaultReasoningEffort: "high", tools: true, forcedToolChoice: true, parallelTools: true, structuredOutput: true, standaloneSearch: false, compaction: true, collaboration: false },
    pricing: null,
    version: 1,
    enabled: true,
    compatibility: { mock: "ready", live: "ready", checkedAt: "now", profileHash: "profile" }
  };
}
