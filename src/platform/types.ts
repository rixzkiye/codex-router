export type ProviderKind =
  | "native"
  | "openai-compatible"
  | "oauth-forwarder"
  | "cli-session"
  | "keyless-local";

export type ProviderProtocol =
  | "responses"
  | "chat-completions"
  | "anthropic-messages"
  | "narrow-adapter";

export type PublicationState =
  | "catalog-only"
  | "experimental"
  | "generally-available"
  | "hidden";

export type EvidenceState = "ready" | "degraded" | "restricted" | "unavailable" | "unknown" | "stale";

export interface ProviderDefinition {
  id: string;
  displayName: string;
  owner: string;
  canonicalProvider: string;
  kind: ProviderKind;
  protocol: ProviderProtocol;
  baseUrl: string | null;
  baseUrlEnvironment?: string;
  credential: {
    mechanism: "native-session" | "environment" | "oauth-cli" | "cli-session" | "keyless";
    references: string[];
    sharedWith?: string;
    interactiveTerminal: boolean;
  };
  requestProfile: string;
  discovery: "provider-api" | "native-catalog" | "local-runtime" | "not-supported";
  usageAuthority: "provider-api" | "rate-limit-headers" | "native-account" | "not-supported";
  planNote?: string;
  localOnly: boolean;
  publication: PublicationState;
}

export interface ModelCapabilities {
  input: Array<"text" | "image">;
  nativeImage: boolean;
  derivedImage: boolean;
  reasoningEfforts: string[];
  defaultReasoningEffort: string | null;
  tools: boolean;
  forcedToolChoice: boolean;
  parallelTools: boolean;
  structuredOutput: boolean;
  standaloneSearch: boolean;
  compaction: boolean;
  collaboration: boolean;
}

export interface ModelDefinition {
  publicSlug: string;
  gatewayId: string;
  upstreamId: string;
  providerVariant: string;
  displayName: string;
  contextWindow: number | null;
  maxOutputTokens: number | null;
  provenance: "checked-in" | "provider-discovery" | "native-catalog" | "user-overlay";
  publication: "discovered" | "curated" | "mock-compatible" | "live-compatible" | "experimental" | "listed" | "deprecated" | "retired";
  requestProfile: string;
  compatibilityHash: string;
  capabilities: ModelCapabilities;
  pricing: { source: string; version: string; inputPerMillion: number; outputPerMillion: number } | null;
}

export interface ProviderProjection extends ProviderDefinition {
  version: number;
  enabled: boolean;
  authentication: {
    state: EvidenceState;
    source: string | null;
    reference: string | null;
    checkedAt: string | null;
  };
  entitlement: { state: EvidenceState; message: string; checkedAt: string | null };
  health: { state: EvidenceState; message: string; checkedAt: string | null };
  catalog: { state: EvidenceState; modelCount: number; refreshedAt: string | null };
}

export interface ModelProjection extends ModelDefinition {
  version: number;
  enabled: boolean;
  compatibility: {
    mock: EvidenceState;
    live: EvidenceState;
    checkedAt: string | null;
    profileHash: string;
  };
}

export type PlatformOperationKind =
  | "provider-enable"
  | "provider-disable"
  | "provider-validate"
  | "catalog-refresh"
  | "model-enable"
  | "model-disable"
  | "compatibility-probe"
  | "doctor"
  | "repair"
  | "support-bundle"
  | "local-model";

export type PlatformOperationState = "pending" | "running" | "completed" | "failed" | "cancelled";

export interface PlatformOperation {
  id: string;
  kind: PlatformOperationKind;
  targetType: string;
  targetId: string;
  state: PlatformOperationState;
  progress: number | null;
  message: string;
  actor: string;
  idempotencyKey: string;
  expectedVersion: number | null;
  result: Record<string, unknown> | null;
  error: { code: string; message: string } | null;
  createdAt: string;
  updatedAt: string;
  completedAt: string | null;
}

export interface InferenceRequestRecord {
  id: string;
  attemptId: string;
  callerClass: string;
  runtimeId: string | null;
  providerId: string;
  accountRefId: string | null;
  modelId: string;
  profileHash: string;
  startedAt: string;
  connectedAt: string | null;
  firstSemanticAt: string | null;
  completedAt: string | null;
  status: string;
  errorClass: string | null;
  cancelled: boolean;
  retryCount: number;
  failoverCount: number;
  semanticOutputObserved: boolean;
  usage: {
    providerInputTokens: number | null;
    providerOutputTokens: number | null;
    cachedInputTokens: number | null;
    reasoningTokens: number | null;
    estimatedInputTokens: number | null;
  };
  flags: string[];
}

export interface PlatformMutationInput {
  idempotencyKey: string;
  expectedVersion: number;
}

export interface DoctorCheck {
  id: string;
  label: string;
  state: "pass" | "warning" | "fail" | "unknown";
  message: string;
  repairable: boolean;
}

export interface CapabilityLedgerEntry {
  id: string;
  capability: string;
  disposition: "adopted" | "superseded" | "deferred" | "rejected";
  phase: number;
  owner: string;
  evidence: string;
}
