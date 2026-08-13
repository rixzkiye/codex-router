import { describe, expect, it } from "vitest";
import {
  ageToolResults,
  createCompactionEnvelope,
  flattenNamespaceTools,
  normalizePlaintextCollaborationPayload,
  parseCompactionEnvelope,
  restoreNamespaceToolCalls
} from "../src/platform/compatibility.js";

describe("platform compatibility authority", () => {
  it("integrity-checks bounded router compaction envelopes", () => {
    const key = "k".repeat(32);
    const envelope = createCompactionEnvelope("The operator selected model A.", {
      providerId: "provider-a",
      modelId: "model-a",
      profileHash: "profile-a",
      createdAt: "2026-08-13T00:00:00.000Z"
    }, key);
    expect(parseCompactionEnvelope(envelope, key)).toEqual(envelope);
    expect(() => parseCompactionEnvelope({ ...envelope, summary: "tampered" }, key)).toThrow(/integrity/);
  });

  it("ages only old large textual tool results and keeps errors plus recent evidence", () => {
    const large = "a".repeat(2_000);
    const result = ageToolResults([
      { type: "function_call_output", call_id: "1", output: large },
      { type: "function_call_output", call_id: "2", output: `Error: ${large}` },
      { type: "function_call_output", call_id: "3", output: large }
    ], { enabled: true, preserveRecent: 1, minimumBytes: 1_000, headBytes: 32, tailBytes: 32 });
    expect(result.agedResults).toBe(1);
    expect(result.estimatedTokensSaved).toBeGreaterThan(0);
    expect((result.input as Array<{ output: string }>)[0]!.output).toContain("aged tool result");
    expect((result.input as Array<{ output: string }>)[1]!.output).toContain("Error:");
    expect((result.input as Array<{ output: string }>)[2]!.output).toBe(large);
  });

  it("round-trips allowlisted namespaced tools and rejects ambiguous bare names", () => {
    const flattened = flattenNamespaceTools([
      { type: "function", namespace: "calendar", name: "create", parameters: { type: "object" } },
      { type: "function", namespace: "tasks", name: "create", parameters: { type: "object" } }
    ], new Set(["calendar.create", "tasks.create"]));
    expect(flattened.tools.map((tool) => tool.name)).toEqual(["calendar__create", "tasks__create"]);
    expect(restoreNamespaceToolCalls({ type: "function_call", name: "calendar__create", arguments: "{}" }, flattened.map)).toMatchObject({
      namespace: "calendar",
      name: "create"
    });
    expect(() => restoreNamespaceToolCalls({ type: "function_call", name: "create", arguments: "{}" }, flattened.map)).toThrow(/Ambiguous/);
  });

  it("normalizes proven router plaintext without touching native ciphertext", () => {
    expect(normalizePlaintextCollaborationPayload({ encrypted_content: JSON.stringify({ task: "inspect", handoff: "h1" }) })).toEqual({
      task: "inspect",
      handoff: "h1",
      payload_encoding: "router-plaintext-v1"
    });
    const ciphertext = "gAAAA" + "x".repeat(200);
    expect(normalizePlaintextCollaborationPayload({ encrypted_content: ciphertext })).toEqual({ encrypted_content: ciphertext });
  });
});
