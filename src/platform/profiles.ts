import { createHash } from "node:crypto";

export interface ProfileResult {
  body: Record<string, unknown>;
  changes: string[];
  profileHash: string;
}

const REASONING_PROFILES = new Set(["deepseek", "kimi", "qwen", "glm", "gemini", "minimax", "grok", "ollama", "anthropic"]);

export function applyRequestProfile(
  profile: string,
  input: Record<string, unknown>
): ProfileResult {
  const body = structuredClone(input);
  const changes: string[] = [];
  const effort = reasoningEffort(body);

  if (REASONING_PROFILES.has(profile) && effort) {
    remove(body, "temperature", changes, "sampling.temperature_removed");
    remove(body, "top_p", changes, "sampling.top_p_removed");
  }

  if (profile === "deepseek") {
    mapReasoning(body, effort, "thinking", changes, (value) => value === "none" ? { type: "disabled" } : { type: "enabled" });
    downgradeForcedToolChoice(body, changes);
  } else if (profile === "kimi") {
    mapReasoning(body, effort, "thinking", changes, (value) => ({ type: value === "none" ? "disabled" : "enabled" }));
  } else if (profile === "qwen") {
    mapReasoning(body, effort, "enable_thinking", changes, (value) => value !== "none");
    downgradeForcedToolChoice(body, changes);
  } else if (profile === "glm") {
    mapReasoning(body, effort, "thinking", changes, (value) => ({ type: value === "none" ? "disabled" : "enabled" }));
  } else if (profile === "gemini") {
    for (const field of ["service_tier", "store", "truncation", "include"]) {
      remove(body, field, changes, `gemini.${field}_removed`);
    }
    removeNonUserImages(body, changes);
  } else if (profile === "anthropic") {
    if (effort && effort !== "none") {
      body.thinking = { type: "adaptive" };
      body.output_config = { ...(asRecord(body.output_config) ?? {}), effort };
      changes.push("anthropic.adaptive_thinking");
    }
  } else if (profile === "minimax") {
    mapReasoning(body, effort, "reasoning_split", changes, (value) => value !== "none");
    body.input = normalizeToolHistory(body.input, changes);
  } else if (profile === "grok") {
    if (effort && effort !== "none") {
      body.reasoning_effort = effort;
      changes.push("grok.reasoning_effort");
    }
    if (Array.isArray(body.tools)) {
      const filtered = body.tools.filter((tool) => asRecord(tool)?.type !== "web_search_preview");
      if (filtered.length !== body.tools.length) {
        body.tools = filtered;
        changes.push("grok.hosted_search_removed");
      }
    }
  } else if (profile === "ollama" && effort) {
    body.think = effort !== "none";
    changes.push("ollama.think_mapped");
  }

  const profileHash = createHash("sha256")
    .update(JSON.stringify({ profile, changes, body }))
    .digest("hex");
  return { body, changes, profileHash };
}

export function normalizeToolHistory(value: unknown, changes: string[] = []): unknown {
  if (!Array.isArray(value)) return value;
  const normalized: unknown[] = [];
  const knownCalls = new Set<string>();
  const completedCalls = new Set<string>();
  for (const item of value) {
    const record = asRecord(item);
    if (!record) {
      normalized.push(item);
      continue;
    }
    const type = String(record.type ?? "");
    const callId = stringValue(record.call_id) ?? stringValue(record.id);
    if (["function_call", "tool_call"].includes(type) && callId) knownCalls.add(callId);
    if (["function_call_output", "tool_result"].includes(type)) {
      if (!callId || !knownCalls.has(callId)) {
        changes.push("tool_history.orphan_result_discarded");
        continue;
      }
      completedCalls.add(callId);
    }
    const previous = asRecord(normalized.at(-1));
    if (type === "message" && record.role === "assistant" && previous?.type === "message" && previous.role === "assistant") {
      const previousContent = Array.isArray(previous.content) ? previous.content : [previous.content].filter(Boolean);
      const nextContent = Array.isArray(record.content) ? record.content : [record.content].filter(Boolean);
      previous.content = [...previousContent, ...nextContent];
      changes.push("tool_history.assistant_fragments_coalesced");
      continue;
    }
    normalized.push(structuredClone(record));
  }
  for (const callId of knownCalls) {
    if (completedCalls.has(callId)) continue;
    normalized.push({
      type: "function_call_output",
      call_id: callId,
      output: "Tool execution was interrupted before a result was available.",
      router_synthesized: true
    });
    changes.push("tool_history.interrupted_result_synthesized");
  }
  return normalized;
}

export function semanticResponseState(payload: unknown): "semantic" | "empty" | "unknown" {
  const record = asRecord(payload);
  if (!record) return "unknown";
  const output = Array.isArray(record.output) ? record.output : [];
  for (const item of output) {
    const entry = asRecord(item);
    if (!entry) continue;
    if (["message", "function_call", "tool_call", "reasoning", "image_generation_call"].includes(String(entry.type))) {
      const content = entry.content;
      if (entry.type !== "message" || (Array.isArray(content) && content.length > 0) || typeof content === "string") {
        return "semantic";
      }
    }
  }
  if (typeof record.output_text === "string" && record.output_text.length > 0) return "semantic";
  if (["completed", "failed", "cancelled", "incomplete"].includes(String(record.status))) return "empty";
  return "unknown";
}

export function semanticSseEvent(eventName: string, data: string): boolean {
  if (/response\.(output_text\.delta|reasoning_summary_text\.delta|function_call_arguments\.delta|output_item\.added)/.test(eventName)) {
    return true;
  }
  if (!data || data === "[DONE]") return false;
  try {
    return semanticResponseState(JSON.parse(data)) === "semantic";
  } catch {
    return false;
  }
}

export function usageFromPayload(payload: unknown) {
  const root = asRecord(payload);
  const usage = asRecord(root?.usage);
  return {
    providerInputTokens: numberValue(usage?.input_tokens) ?? numberValue(usage?.prompt_tokens),
    providerOutputTokens: numberValue(usage?.output_tokens) ?? numberValue(usage?.completion_tokens),
    cachedInputTokens: numberValue(asRecord(usage?.input_tokens_details)?.cached_tokens) ?? numberValue(usage?.cached_tokens),
    reasoningTokens: numberValue(asRecord(usage?.output_tokens_details)?.reasoning_tokens) ?? numberValue(usage?.reasoning_tokens),
    estimatedInputTokens: null
  };
}

function reasoningEffort(body: Record<string, unknown>): string | null {
  const direct = stringValue(body.reasoning_effort);
  if (direct) return direct;
  return stringValue(asRecord(body.reasoning)?.effort) ?? null;
}

function mapReasoning(
  body: Record<string, unknown>,
  effort: string | null,
  field: string,
  changes: string[],
  map: (effort: string) => unknown
) {
  if (!effort) return;
  body[field] = map(effort);
  delete body.reasoning;
  delete body.reasoning_effort;
  changes.push(`${field}.reasoning_mapped`);
}

function downgradeForcedToolChoice(body: Record<string, unknown>, changes: string[]) {
  if (body.tool_choice === "required" || asRecord(body.tool_choice)?.type === "function") {
    body.tool_choice = "auto";
    changes.push("tools.forced_choice_downgraded");
  }
}

function removeNonUserImages(body: Record<string, unknown>, changes: string[]) {
  if (!Array.isArray(body.input)) return;
  let removed = 0;
  body.input = body.input.map((item) => {
    const message = asRecord(item);
    if (!message || message.role === "user" || !Array.isArray(message.content)) return item;
    const content = message.content.filter((part) => {
      const type = String(asRecord(part)?.type ?? "");
      const keep = !["input_image", "image_url", "image"].includes(type);
      if (!keep) removed += 1;
      return keep;
    });
    return { ...message, content };
  });
  if (removed > 0) changes.push("gemini.non_user_images_removed");
}

function remove(body: Record<string, unknown>, field: string, changes: string[], label: string) {
  if (!(field in body)) return;
  delete body[field];
  changes.push(label);
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null;
}

function stringValue(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

function numberValue(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : null;
}
