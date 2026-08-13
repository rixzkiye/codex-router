import { createHash } from "node:crypto";

export interface VisionEngine {
  id: string;
  source: "native" | "registry" | "local";
  modelId: string;
  describe(input: { image: string; question: string; signal?: AbortSignal }): Promise<string>;
}

export interface VisionBridgePolicy {
  enabled: boolean;
  maxDataUrlBytes: number;
  allowedRemoteHosts: string[];
  fallback: boolean;
  cacheEntries: number;
}

export interface VisionBridgeResult {
  input: unknown;
  imagesObserved: number;
  imagesBridged: number;
  deduplicated: number;
  engineId: string | null;
  engineSource: VisionEngine["source"] | null;
  fallbackCount: number;
  flags: string[];
}

interface ImageReference {
  source: string;
  question: string;
  path: Array<string | number>;
}

export class VisionBridge {
  readonly #policy: VisionBridgePolicy;
  readonly #engines: VisionEngine[];
  readonly #cache = new Map<string, string>();
  readonly #inFlight = new Map<string, Promise<string>>();

  constructor(policy: VisionBridgePolicy, engines: VisionEngine[]) {
    this.#policy = policy;
    this.#engines = [...engines];
  }

  available(): boolean {
    return this.#policy.enabled && this.#engines.length > 0;
  }

  async apply(input: unknown, signal?: AbortSignal): Promise<VisionBridgeResult> {
    const references = collectImages(input);
    if (references.length === 0) return unchanged(input);
    if (!this.available()) throw new Error("Image input requires a configured vision bridge engine");
    const clone = structuredClone(input);
    const requestCache = new Map<string, string>();
    let deduplicated = 0;
    let fallbackCount = 0;
    let selected: VisionEngine | null = null;
    for (const reference of references) {
      validateImageReference(reference.source, this.#policy);
      const key = cacheKey(reference, this.#engines);
      let transcript = requestCache.get(key) ?? this.#cache.get(key);
      if (transcript) {
        deduplicated += 1;
      } else {
        let lastError: unknown;
        for (const [index, engine] of this.#engines.entries()) {
          if (index > 0 && !this.#policy.fallback) break;
          try {
            transcript = await this.#once(key, () => engine.describe({ image: reference.source, question: reference.question, ...(signal ? { signal } : {}) }));
            selected = engine;
            if (index > 0) fallbackCount += 1;
            break;
          } catch (error) {
            lastError = error;
          }
        }
        if (!transcript) throw lastError instanceof Error ? lastError : new Error("Every configured vision engine failed");
        this.#remember(key, transcript);
      }
      requestCache.set(key, transcript);
      replaceImage(clone, reference.path, transcript);
    }
    return {
      input: clone,
      imagesObserved: references.length,
      imagesBridged: references.length,
      deduplicated,
      engineId: selected?.id ?? null,
      engineSource: selected?.source ?? null,
      fallbackCount,
      flags: ["vision-bridge", ...(deduplicated ? ["vision-deduplicated"] : []), ...(fallbackCount ? ["vision-fallback"] : [])]
    };
  }

  async #once(key: string, run: () => Promise<string>): Promise<string> {
    const existing = this.#inFlight.get(key);
    if (existing) return existing;
    const pending = run().then((value) => {
      const normalized = value.trim();
      if (!normalized) throw new Error("Vision engine returned an empty transcript");
      return normalized;
    }).finally(() => this.#inFlight.delete(key));
    this.#inFlight.set(key, pending);
    return pending;
  }

  #remember(key: string, transcript: string): void {
    this.#cache.delete(key);
    this.#cache.set(key, transcript);
    while (this.#cache.size > this.#policy.cacheEntries) {
      const oldest = this.#cache.keys().next().value as string | undefined;
      if (!oldest) break;
      this.#cache.delete(oldest);
    }
  }
}

function collectImages(input: unknown): ImageReference[] {
  const references: ImageReference[] = [];
  walk(input, [], "Describe the image faithfully for a text-only coding model.", references);
  return references;
}

function walk(value: unknown, path: Array<string | number>, question: string, output: ImageReference[]): void {
  if (Array.isArray(value)) {
    for (const [index, child] of value.entries()) walk(child, [...path, index], question, output);
    return;
  }
  if (!isRecord(value)) return;
  const localQuestion = typeof value.text === "string" && value.text.trim() ? value.text.slice(0, 4_000) : question;
  if (value.type === "input_image" || value.type === "image_url") {
    const source = typeof value.image_url === "string"
      ? value.image_url
      : isRecord(value.image_url) && typeof value.image_url.url === "string"
        ? value.image_url.url
        : typeof value.url === "string"
          ? value.url
          : null;
    if (source) output.push({ source, question: localQuestion, path });
  }
  for (const [key, child] of Object.entries(value)) walk(child, [...path, key], localQuestion, output);
}

function validateImageReference(source: string, policy: VisionBridgePolicy): void {
  if (source.startsWith("data:")) {
    const match = /^data:image\/(?:png|jpeg|webp|gif);base64,([A-Za-z0-9+/=]+)$/.exec(source);
    if (!match) throw new Error("Vision bridge accepts only bounded base64 image data URLs");
    const encoded = match[1]!;
    const bytes = Math.floor(encoded.length * 3 / 4);
    if (bytes > policy.maxDataUrlBytes) throw new Error("Vision bridge image exceeds the configured byte limit");
    return;
  }
  const url = new URL(source);
  if (url.protocol !== "https:" || url.username || url.password || url.port) throw new Error("Vision bridge remote images require an allowlisted HTTPS origin");
  if (!policy.allowedRemoteHosts.includes(url.hostname)) throw new Error(`Vision bridge image host is not allowlisted: ${url.hostname}`);
}

function replaceImage(root: unknown, path: Array<string | number>, transcript: string): void {
  if (path.length === 0) throw new Error("A root image item cannot be replaced without a surrounding request object");
  let parent: unknown = root;
  for (const key of path.slice(0, -1)) {
    if (Array.isArray(parent) && typeof key === "number") parent = parent[key];
    else if (isRecord(parent) && typeof key === "string") parent = parent[key];
    else throw new Error("Vision bridge request shape changed during transformation");
  }
  const replacement = { type: "input_text", text: `[Image transcript via vision bridge]\n${transcript}` };
  const key = path.at(-1)!;
  if (Array.isArray(parent) && typeof key === "number") parent[key] = replacement;
  else if (isRecord(parent) && typeof key === "string") parent[key] = replacement;
  else throw new Error("Vision bridge request shape changed during transformation");
}

function cacheKey(reference: ImageReference, engines: VisionEngine[]): string {
  return createHash("sha256").update(reference.source).update("\0").update(reference.question).update("\0").update(engines.map((engine) => engine.id).join(",")).digest("hex");
}

function unchanged(input: unknown): VisionBridgeResult {
  return { input: structuredClone(input), imagesObserved: 0, imagesBridged: 0, deduplicated: 0, engineId: null, engineSource: null, fallbackCount: 0, flags: [] };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
