import { createHash, createHmac, timingSafeEqual } from "node:crypto";

export interface CompactionEnvelope {
  type: "codex-router.compaction";
  version: 1;
  summary: string;
  provenance: {
    providerId: string;
    modelId: string;
    profileHash: string;
    createdAt: string;
  };
  integrity: string;
}

export interface ToolAgingPolicy {
  enabled: boolean;
  preserveRecent: number;
  minimumBytes: number;
  headBytes: number;
  tailBytes: number;
}

export interface ToolAgingResult {
  input: unknown;
  agedResults: number;
  bytesBefore: number;
  bytesAfter: number;
  estimatedTokensSaved: number;
}

export interface NamespaceTool {
  type: "function";
  name: string;
  description?: string;
  parameters?: Record<string, unknown>;
  namespace?: string;
}

export interface NamespaceMap {
  flattenedToQualified: Record<string, string>;
  qualifiedToFlattened: Record<string, string>;
  bareToQualified: Record<string, string | null>;
}

export function createCompactionEnvelope(
  summary: string,
  provenance: Omit<CompactionEnvelope["provenance"], "createdAt"> & { createdAt?: string },
  integrityKey: string,
  maxSummaryBytes = 256 * 1024
): CompactionEnvelope {
  const normalized = summary.trim();
  if (!normalized) throw new Error("Compaction summary cannot be empty");
  if (Buffer.byteLength(normalized, "utf8") > maxSummaryBytes) {
    throw new Error("Compaction summary exceeds the configured byte limit");
  }
  const unsigned = {
    type: "codex-router.compaction" as const,
    version: 1 as const,
    summary: normalized,
    provenance: {
      providerId: provenance.providerId,
      modelId: provenance.modelId,
      profileHash: provenance.profileHash,
      createdAt: provenance.createdAt ?? new Date().toISOString()
    }
  };
  return { ...unsigned, integrity: sign(unsigned, integrityKey) };
}

export function parseCompactionEnvelope(
  value: unknown,
  integrityKey: string,
  maxEnvelopeBytes = 512 * 1024
): CompactionEnvelope {
  if (Buffer.byteLength(JSON.stringify(value), "utf8") > maxEnvelopeBytes) {
    throw new Error("Compaction envelope exceeds the configured byte limit");
  }
  if (!isRecord(value) || value.type !== "codex-router.compaction" || value.version !== 1) {
    throw new Error("Unsupported compaction envelope");
  }
  if (typeof value.summary !== "string" || !isRecord(value.provenance) || typeof value.integrity !== "string") {
    throw new Error("Malformed compaction envelope");
  }
  const provenance = value.provenance;
  if (
    typeof provenance.providerId !== "string" ||
    typeof provenance.modelId !== "string" ||
    typeof provenance.profileHash !== "string" ||
    typeof provenance.createdAt !== "string"
  ) {
    throw new Error("Malformed compaction provenance");
  }
  const envelope: CompactionEnvelope = {
    type: "codex-router.compaction",
    version: 1,
    summary: value.summary,
    provenance: {
      providerId: provenance.providerId,
      modelId: provenance.modelId,
      profileHash: provenance.profileHash,
      createdAt: provenance.createdAt
    },
    integrity: value.integrity
  };
  const unsigned = {
    type: envelope.type,
    version: envelope.version,
    summary: envelope.summary,
    provenance: envelope.provenance
  };
  const expected = Buffer.from(sign(unsigned, integrityKey), "hex");
  const received = Buffer.from(envelope.integrity, "hex");
  if (received.length !== expected.length || !timingSafeEqual(received, expected)) {
    throw new Error("Compaction envelope integrity check failed");
  }
  return envelope;
}

export function ageToolResults(input: unknown, policy: ToolAgingPolicy): ToolAgingResult {
  const before = Buffer.byteLength(JSON.stringify(input), "utf8");
  if (!policy.enabled || !Array.isArray(input)) return unchanged(input, before);
  const resultIndexes = input
    .map((item, index) => isToolResult(item) ? index : -1)
    .filter((index) => index >= 0);
  const protectedIndexes = new Set(resultIndexes.slice(-Math.max(0, policy.preserveRecent)));
  let agedResults = 0;
  const aged = input.map((item, index) => {
    if (!isToolResult(item) || protectedIndexes.has(index)) return clone(item);
    const output = textualToolOutput(item);
    if (output === null || Buffer.byteLength(output, "utf8") < policy.minimumBytes || looksLikeRequiredError(output)) {
      return clone(item);
    }
    agedResults += 1;
    return {
      ...cloneRecord(item),
      output: receipt(output, policy)
    };
  });
  const after = Buffer.byteLength(JSON.stringify(aged), "utf8");
  return {
    input: aged,
    agedResults,
    bytesBefore: before,
    bytesAfter: after,
    estimatedTokensSaved: Math.max(0, Math.ceil((before - after) / 4))
  };
}

export function flattenNamespaceTools(tools: NamespaceTool[], allowlistedQualifiedNames?: ReadonlySet<string>): {
  tools: NamespaceTool[];
  map: NamespaceMap;
} {
  const flattenedToQualified: Record<string, string> = {};
  const qualifiedToFlattened: Record<string, string> = {};
  const bareOwners = new Map<string, string[]>();
  const flattened = tools.map((tool) => {
    const qualified = tool.namespace ? `${tool.namespace}.${tool.name}` : tool.name;
    if (allowlistedQualifiedNames && !allowlistedQualifiedNames.has(qualified)) {
      throw new Error(`Tool ${qualified} is not allowed for this client compatibility cohort`);
    }
    const bare = tool.name;
    bareOwners.set(bare, [...(bareOwners.get(bare) ?? []), qualified]);
    const name = uniqueFlattenedName(qualified, flattenedToQualified);
    flattenedToQualified[name] = qualified;
    qualifiedToFlattened[qualified] = name;
    const { namespace: _namespace, ...copy } = tool;
    return { ...copy, name };
  });
  const bareToQualified = Object.fromEntries(
    [...bareOwners].map(([bare, owners]) => [bare, owners.length === 1 ? owners[0]! : null])
  );
  return { tools: flattened, map: { flattenedToQualified, qualifiedToFlattened, bareToQualified } };
}

export function restoreNamespaceToolCalls(value: unknown, map: NamespaceMap): unknown {
  if (Array.isArray(value)) return value.map((entry) => restoreNamespaceToolCalls(entry, map));
  if (!isRecord(value)) return value;
  const copy: Record<string, unknown> = {};
  for (const [key, nested] of Object.entries(value)) copy[key] = restoreNamespaceToolCalls(nested, map);
  if (typeof copy.name === "string" && isToolCallLike(copy)) {
    const qualified = map.flattenedToQualified[copy.name] ?? map.bareToQualified[copy.name];
    if (qualified === null) throw new Error(`Ambiguous bare tool name: ${copy.name}`);
    if (!qualified) throw new Error(`Unknown tool name returned by provider: ${copy.name}`);
    const split = qualified.lastIndexOf(".");
    if (split >= 0) {
      copy.namespace = qualified.slice(0, split);
      copy.name = qualified.slice(split + 1);
    } else {
      copy.name = qualified;
    }
  }
  return copy;
}

export function normalizePlaintextCollaborationPayload(value: unknown): unknown {
  if (!isRecord(value) || typeof value.encrypted_content !== "string") return value;
  const encoded = value.encrypted_content;
  if (looksLikeNativeCiphertext(encoded)) return value;
  let decoded: unknown;
  try {
    decoded = JSON.parse(encoded);
  } catch {
    return value;
  }
  if (!isRecord(decoded) || typeof decoded.task !== "string") return value;
  const { encrypted_content: _encryptedContent, ...rest } = value;
  return { ...rest, task: decoded.task, handoff: decoded.handoff ?? null, payload_encoding: "router-plaintext-v1" };
}

function sign(value: unknown, key: string): string {
  if (Buffer.byteLength(key, "utf8") < 32) throw new Error("Compaction integrity key must contain at least 32 bytes");
  return createHmac("sha256", key).update(stableJson(value)).digest("hex");
}

function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (isRecord(value)) {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableJson(value[key])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isToolResult(value: unknown): value is Record<string, unknown> {
  return isRecord(value) && ["function_call_output", "tool_result"].includes(String(value.type));
}

function textualToolOutput(value: Record<string, unknown>): string | null {
  if (typeof value.output === "string") return value.output;
  if (typeof value.content === "string") return value.content;
  return null;
}

function looksLikeRequiredError(value: string): boolean {
  return /(?:error|failed|exception|denied|invalid|not found)/i.test(value.slice(0, 1024));
}

function receipt(value: string, policy: ToolAgingPolicy): string {
  const bytes = Buffer.byteLength(value, "utf8");
  const head = Buffer.from(value, "utf8").subarray(0, policy.headBytes).toString("utf8");
  const tailBuffer = Buffer.from(value, "utf8");
  const tail = tailBuffer.subarray(Math.max(0, tailBuffer.length - policy.tailBytes)).toString("utf8");
  const digest = createHash("sha256").update(value).digest("hex");
  return `[codex-router aged tool result: ${bytes} bytes, sha256:${digest}]\n${head}\n…\n${tail}`;
}

function clone<T>(value: T): T {
  return structuredClone(value);
}

function cloneRecord(value: Record<string, unknown>): Record<string, unknown> {
  return clone(value);
}

function unchanged(input: unknown, bytes: number): ToolAgingResult {
  return { input: clone(input), agedResults: 0, bytesBefore: bytes, bytesAfter: bytes, estimatedTokensSaved: 0 };
}

function uniqueFlattenedName(qualified: string, existing: Record<string, string>): string {
  const normalized = qualified.replace(/[^a-zA-Z0-9_-]/g, "__").slice(0, 58);
  if (!existing[normalized]) return normalized;
  return `${normalized.slice(0, 49)}__${createHash("sha256").update(qualified).digest("hex").slice(0, 7)}`;
}

function isToolCallLike(value: Record<string, unknown>): boolean {
  return ["function_call", "tool_call", "function"].includes(String(value.type)) || "arguments" in value;
}

function looksLikeNativeCiphertext(value: string): boolean {
  if (value.startsWith("gAAAA") || value.startsWith("eyJ2ZXJzaW9u")) return true;
  return value.length > 96 && /^[A-Za-z0-9+/_=-]+$/.test(value) && !value.trimStart().startsWith("{");
}
