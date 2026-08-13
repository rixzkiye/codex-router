import type { InferenceModelConfig, InferenceProviderConfig } from "../config.js";

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
    expiresAt?: string | null;
    message?: string;
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
  | "provider-login"
  | "provider-logout"
  | "credential-set"
  | "provider-refresh"
  | "provider-cli-install"
  | "catalog-refresh"
  | "native-catalog-refresh"
  | "model-enable"
  | "model-disable"
  | "compatibility-probe"
  | "live-compatibility-probe"
  | "doctor"
  | "repair"
  | "support-bundle"
  | "local-model-discover"
  | "local-model-download"
  | "local-model-benchmark"
  | "local-model-select"
  | "local-model-unselect"
  | "local-model-remove"
  | "install-plan"
  | "install-apply"
  | "update"
  | "rollback"
  | "disable"
  | "uninstall"
  | "settings-update";

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

/** Browser-safe input: secret values never cross this boundary. */
export interface ProviderConfigurationInput extends PlatformMutationInput {
  provider: InferenceProviderConfig;
  initialModel?: InferenceModelConfig;
  gateway?: {
    callerTokenRef: string;
    host?: "127.0.0.1" | "::1" | "localhost";
    port?: number;
  };
}

export interface ModelConfigurationInput extends PlatformMutationInput {
  model: InferenceModelConfig;
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

export interface LocalModelProjection {
  id: string;
  runtimeId: string;
  state: "discovered" | "downloading" | "installed" | "validated" | "failed" | "removing";
  selected: boolean;
  definition: {
    sizeBytes: number | null;
    digest: string | null;
    modifiedAt: string | null;
    capabilities: string[];
    contextWindow: number | null;
    details: Record<string, string>;
  };
  benchmark: {
    completed: boolean;
    durationMs: number;
    outputTokens: number | null;
    tokensPerSecond: number | null;
    toolCallObserved: boolean;
  } | null;
  operationId: string | null;
  version: number;
  updatedAt: string;
}

export interface RoutingDecision {
  requestId: string;
  policyVersion: string;
  catalogVersion: string;
  quotaSnapshotVersion: string | null;
  selected: { providerId: string; accountRefId: string | null; modelId: string; score: number };
  candidates: Array<{
    providerId: string;
    accountRefId: string | null;
    modelId: string;
    eligible: boolean;
    score: number;
    reasons: string[];
  }>;
  createdAt: string;
}

export interface PlatformEvidence {
  id: string;
  capability: string;
  category: "local-check" | "hosted-ci" | "security-review" | "accessibility-review" | "package" | "provider-live" | "install" | "deployment" | "live-health";
  state: "pass" | "fail" | "blocked" | "unknown";
  provenance: Record<string, unknown>;
  observedAt: string;
  expiresAt: string | null;
  headSha: string | null;
}
