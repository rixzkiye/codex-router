import { performance } from "node:perf_hooks";

export interface LocalModelRecord {
  id: string;
  runtime: "ollama";
  installed: boolean;
  sizeBytes: number | null;
  digest: string | null;
  modifiedAt: string | null;
  capabilities: string[];
  contextWindow: number | null;
  details: Record<string, string>;
}

export interface LocalDownloadProgress {
  status: string;
  digest: string | null;
  completed: number | null;
  total: number | null;
  fraction: number | null;
}

export interface LocalBenchmarkResult {
  model: string;
  completed: boolean;
  durationMs: number;
  outputTokens: number | null;
  tokensPerSecond: number | null;
  toolCallObserved: boolean;
}

export class OllamaClient {
  readonly #baseUrl: URL;

  constructor(baseUrl = "http://127.0.0.1:11434") {
    const url = new URL(baseUrl);
    if (url.protocol !== "http:" || !["127.0.0.1", "::1", "localhost"].includes(url.hostname)) {
      throw new Error("The local-model runtime must be a loopback HTTP endpoint");
    }
    if (url.username || url.password || url.search || url.hash) throw new Error("The local-model endpoint cannot contain credentials or query data");
    this.#baseUrl = url;
  }

  async health(signal?: AbortSignal): Promise<boolean> {
    try {
      const response = await fetch(new URL("/api/version", this.#baseUrl), { ...signalOption(signal), redirect: "error" });
      return response.ok;
    } catch {
      return false;
    }
  }

  async list(signal?: AbortSignal): Promise<LocalModelRecord[]> {
    const payload = await this.#json("/api/tags", { method: "GET", ...signalOption(signal) });
    const models = Array.isArray(payload.models) ? payload.models : [];
    return models.filter(isRecord).map((model) => ({
      id: stringValue(model.name) ?? stringValue(model.model) ?? "unknown",
      runtime: "ollama",
      installed: true,
      sizeBytes: numberValue(model.size),
      digest: stringValue(model.digest),
      modifiedAt: stringValue(model.modified_at),
      capabilities: [],
      contextWindow: null,
      details: stringRecord(model.details)
    }));
  }

  async inspect(model: string, signal?: AbortSignal): Promise<LocalModelRecord> {
    const payload = await this.#json("/api/show", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ model }),
      ...signalOption(signal)
    });
    const details = stringRecord(payload.details);
    const info = isRecord(payload.model_info) ? payload.model_info : {};
    return {
      id: model,
      runtime: "ollama",
      installed: true,
      sizeBytes: null,
      digest: null,
      modifiedAt: stringValue(payload.modified_at),
      capabilities: Array.isArray(payload.capabilities) ? payload.capabilities.filter((entry): entry is string => typeof entry === "string") : [],
      contextWindow: contextWindow(info),
      details
    };
  }

  async pull(
    model: string,
    options: { consent: boolean; signal?: AbortSignal; onProgress?: (progress: LocalDownloadProgress) => void }
  ): Promise<LocalModelRecord> {
    if (!options.consent) throw new Error("Local model download requires explicit operator consent");
    const response = await fetch(new URL("/api/pull", this.#baseUrl), {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ model, stream: true }),
      ...signalOption(options.signal),
      redirect: "error"
    });
    if (!response.ok || !response.body) throw new Error(`Ollama pull failed with status ${response.status}`);
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffered = "";
    while (true) {
      const { done, value } = await reader.read();
      buffered += decoder.decode(value, { stream: !done });
      const lines = buffered.split("\n");
      buffered = done ? "" : lines.pop() ?? "";
      for (const line of lines) {
        if (!line.trim()) continue;
        const event: unknown = JSON.parse(line);
        if (!isRecord(event)) continue;
        if (typeof event.error === "string") throw new Error(`Ollama pull failed: ${event.error}`);
        options.onProgress?.(progress(event));
      }
      if (done) break;
    }
    return this.inspect(model, options.signal);
  }

  async remove(model: string, options: { consent: boolean; signal?: AbortSignal }): Promise<void> {
    if (!options.consent) throw new Error("Local model deletion requires explicit operator consent");
    const response = await fetch(new URL("/api/delete", this.#baseUrl), {
      method: "DELETE",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ model }),
      ...signalOption(options.signal),
      redirect: "error"
    });
    if (!response.ok) throw new Error(`Ollama delete failed with status ${response.status}`);
  }

  async benchmark(model: string, signal?: AbortSignal): Promise<LocalBenchmarkResult> {
    const started = performance.now();
    const payload = await this.#json("/api/chat", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        model,
        stream: false,
        messages: [{ role: "user", content: "Reply with the single word ready." }],
        tools: [{ type: "function", function: { name: "fixture", description: "Compatibility fixture", parameters: { type: "object", properties: {} } } }]
      }),
      ...signalOption(signal)
    });
    const durationMs = Math.round(performance.now() - started);
    const evalCount = numberValue(payload.eval_count);
    const toolCalls = isRecord(payload.message) && Array.isArray(payload.message.tool_calls) ? payload.message.tool_calls.length > 0 : false;
    return {
      model,
      completed: Boolean(payload.done),
      durationMs,
      outputTokens: evalCount,
      tokensPerSecond: evalCount === null || durationMs <= 0 ? null : Number((evalCount / (durationMs / 1000)).toFixed(2)),
      toolCallObserved: toolCalls
    };
  }

  async #json(pathname: string, init: RequestInit): Promise<Record<string, unknown>> {
    const response = await fetch(new URL(pathname, this.#baseUrl), { ...init, redirect: "error" });
    if (!response.ok) throw new Error(`Ollama request failed with status ${response.status}`);
    const payload: unknown = await response.json();
    if (!isRecord(payload)) throw new Error("Ollama returned an invalid JSON object");
    return payload;
  }
}

function progress(value: Record<string, unknown>): LocalDownloadProgress {
  const completed = numberValue(value.completed);
  const total = numberValue(value.total);
  return {
    status: stringValue(value.status) ?? "working",
    digest: stringValue(value.digest),
    completed,
    total,
    fraction: completed === null || total === null || total <= 0 ? null : Math.min(1, completed / total)
  };
}

function contextWindow(info: Record<string, unknown>): number | null {
  for (const [key, value] of Object.entries(info)) {
    if (/context_length$/i.test(key)) return numberValue(value);
  }
  return null;
}

function stringRecord(value: unknown): Record<string, string> {
  if (!isRecord(value)) return {};
  return Object.fromEntries(Object.entries(value).filter((entry): entry is [string, string] => typeof entry[1] === "string"));
}

function stringValue(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value : null;
}

function numberValue(value: unknown): number | null {
  const number = Number(value);
  return Number.isFinite(number) && number >= 0 ? number : null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function signalOption(signal: AbortSignal | undefined): { signal: AbortSignal } | Record<string, never> {
  return signal ? { signal } : {};
}
