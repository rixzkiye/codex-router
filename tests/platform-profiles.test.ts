import { describe, expect, it } from "vitest";
import {
  applyRequestProfile,
  normalizeToolHistory,
  semanticResponseState,
  semanticSseEvent,
  usageFromPayload
} from "../src/platform/profiles.js";

describe("platform request profiles", () => {
  it("maps DeepSeek reasoning and downgrades unsupported forced tool choice", () => {
    const result = applyRequestProfile("deepseek", {
      model: "deepseek-reasoner",
      reasoning: { effort: "high" },
      temperature: 0.7,
      top_p: 0.9,
      tool_choice: "required"
    });
    expect(result.body).toMatchObject({
      model: "deepseek-reasoner",
      thinking: { type: "enabled" },
      tool_choice: "auto"
    });
    expect(result.body).not.toHaveProperty("temperature");
    expect(result.body).not.toHaveProperty("top_p");
    expect(result.changes).toContain("tools.forced_choice_downgraded");
    expect(result.profileHash).toMatch(/^[a-f0-9]{64}$/);
  });

  it("repairs only invalid tool history and preserves known outputs", () => {
    const changes: string[] = [];
    expect(normalizeToolHistory([
      { type: "function_call", id: "call-1", name: "read" },
      { type: "function_call_output", call_id: "call-1", output: "ok" },
      { type: "function_call_output", call_id: "orphan", output: "drop" },
      { type: "function_call", id: "call-2", name: "write" }
    ], changes)).toEqual([
      { type: "function_call", id: "call-1", name: "read" },
      { type: "function_call_output", call_id: "call-1", output: "ok" },
      { type: "function_call", id: "call-2", name: "write" },
      {
        type: "function_call_output",
        call_id: "call-2",
        output: "Tool execution was interrupted before a result was available.",
        router_synthesized: true
      }
    ]);
    expect(changes).toEqual([
      "tool_history.orphan_result_discarded",
      "tool_history.interrupted_result_synthesized"
    ]);
  });

  it("classifies semantic output without retaining its content", () => {
    expect(semanticResponseState({ status: "completed", output: [{ type: "message", content: [{ type: "output_text", text: "private" }] }] })).toBe("semantic");
    expect(semanticResponseState({ status: "completed", output: [] })).toBe("empty");
    expect(semanticSseEvent("response.output_text.delta", JSON.stringify({ delta: "private" }))).toBe(true);
    expect(semanticSseEvent("response.created", JSON.stringify({ id: "response" }))).toBe(false);
  });

  it("keeps provider usage distinct from estimates", () => {
    expect(usageFromPayload({ usage: { input_tokens: 0, output_tokens: 12, input_tokens_details: { cached_tokens: 5 } } })).toEqual({
      providerInputTokens: 0,
      providerOutputTokens: 12,
      cachedInputTokens: 5,
      reasoningTokens: null,
      estimatedInputTokens: null
    });
  });
});
