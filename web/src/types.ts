export type AgentStatus =
  | "queued"
  | "starting"
  | "running"
  | "needs_attention"
  | "cancelling"
  | "handing_off"
  | "waiting_for_reset"
  | "completed"
  | "failed"
  | "interrupted";

export type RuntimeState = "ready" | "busy" | "draining" | "limited" | "degraded" | "offline";
export type ConnectionState = "live" | "reconnecting" | "stale" | "offline";

export interface Incarnation {
  id: string;
  agentId: string;
  runtimeId: string;
  threadId: string | null;
  turnId: string | null;
  status: string;
  terminalReason: string | null;
  fencingToken: number | null;
  createdAt: string;
  updatedAt: string;
}

export interface AgentSummary {
  id: string;
  status: AgentStatus;
  taskSummary: string;
  projectKey: string;
  worktree: { path: string; mode: "write" | "read_only" };
  routing: {
    capabilityTier?: string;
    preferredRuntimeId?: string;
    allowedRuntimeIds?: string[];
    provider?: string;
    model?: string;
  };
  labels: Record<string, string>;
  authority: Authority;
  recoveryPolicy: string;
  registryVersion: number;
  semanticOutputObserved: boolean;
  sideEffectsObserved: boolean;
  pendingInteractionId: string | null;
  checkpointQuality: "clean" | "unclean" | null;
  incarnation: Incarnation | null;
  runtime: { id: string; provider: string; state: RuntimeState; model: string | null } | null;
  createdAt: string;
  updatedAt: string;
}

export interface Authority {
  allowPush: boolean;
  allowMerge: boolean;
  allowDeploy: boolean;
  allowExternalWrites: boolean;
}

export interface QuotaWindow {
  usedPercent?: number;
  windowDurationMinutes?: number;
  resetsAt?: number;
}

export interface RuntimeDto {
  id: string;
  adapter: string;
  provider: string;
  capabilityTiers: string[];
  allowedModels: string[];
  maxConcurrency: number;
  policyTags: string[];
  enabled: boolean;
  activeCount: number;
  health: {
    state: RuntimeState;
    initialized: boolean;
    activeCount: number;
    failureRate: number;
    eventLagMs: number;
    quota: {
      primary?: QuotaWindow;
      secondary?: QuotaWindow;
      credits?: { hasCredits?: boolean; unlimited?: boolean; balance?: string };
      updatedAt: string;
    } | null;
    updatedAt: string;
  };
  modelPolicy: {
    allowedModels: string[];
    defaultModel: string | null;
    defaultReasoningEffort: string | null;
    catalogRequiredForChanges: boolean;
  };
  authentication: {
    type: string;
    status: string;
    storageMode: string;
    accountLabel: string | null;
    reference: string | null;
    resolutionState: string;
    lastCheckedAt: string | null;
    capabilities: {
      browserLogin: boolean;
      deviceLogin: boolean;
      referenceLogin: boolean;
      logout: boolean;
    };
    message: string;
  };
}

export interface Interaction {
  id: string;
  agentId: string;
  incarnationId: string;
  runtimeId: string;
  method: string;
  kind: "approval" | "user_input";
  params: Record<string, unknown>;
  state: "pending" | "resolved" | "expired";
  createdAt: string;
  resolvedAt: string | null;
}

export interface RouterDiagnostics {
  registryVersion: number;
  agentsByStatus: Record<string, number>;
  eventsByType: Record<string, number>;
  counters: Record<string, number>;
  runtimes: Array<Record<string, unknown>>;
  writerLeases: Array<Record<string, unknown>>;
  pendingInteractions: Array<Record<string, unknown>>;
}

export interface BootstrapDto {
  csrfToken: string;
  schemaVersion: number;
  router: {
    version: string;
    registryVersion: number;
    oldestResumableVersion: number;
    generatedAt: string;
  };
  session: { role: "viewer" | "operator" | "administrator" };
  summary: {
    agentsByStatus: Record<string, number>;
    active: number;
    attention: number;
    terminal: number;
    runtimeReady: number;
    runtimeTotal: number;
  };
  agents: AgentSummary[];
  runtimes: RuntimeDto[];
  interactions: Interaction[];
  diagnostics: RouterDiagnostics;
  platform: PlatformSnapshot;
}

export type EvidenceState = "ready" | "degraded" | "restricted" | "unavailable" | "unknown" | "stale";

export interface ProviderDto {
  id: string;
  displayName: string;
  owner: string;
  canonicalProvider: string;
  kind: string;
  protocol: string;
  baseUrl: string | null;
  baseUrlEnvironment?: string;
  authBoundary: {
    mechanism: string;
    references: string[];
    sharedWith: string | null;
    interactiveTerminal: boolean;
  };
  requestProfile: string;
  discovery: string;
  usageAuthority: string;
  planNote?: string;
  localOnly: boolean;
  publication: string;
  version: number;
  enabled: boolean;
  authentication: { state: EvidenceState; source: string | null; reference: string | null; checkedAt: string | null; expiresAt?: string | null; message?: string };
  entitlement: { state: EvidenceState; message: string; checkedAt: string | null };
  health: { state: EvidenceState; message: string; checkedAt: string | null };
  catalog: { state: EvidenceState; modelCount: number; refreshedAt: string | null };
}

export interface ModelDto {
  publicSlug: string;
  gatewayId: string;
  upstreamId: string;
  providerVariant: string;
  displayName: string;
  contextWindow: number | null;
  maxOutputTokens: number | null;
  provenance: string;
  publication: string;
  requestProfile: string;
  compatibilityHash: string;
  capabilities: {
    input: string[];
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
  };
  pricing: { source: string; version: string; inputPerMillion: number; outputPerMillion: number } | null;
  version: number;
  enabled: boolean;
  compatibility: { mock: EvidenceState; live: EvidenceState; checkedAt: string | null; profileHash: string };
}

export interface AccountDto {
  id: string;
  providerId: string;
  canonicalProvider: string;
  label: string;
  authentication: ProviderDto["authentication"];
  entitlement: ProviderDto["entitlement"];
  quota: { state: string; source: string | null; freshness: string | null; windows: unknown[] };
  affinity: { activeRequests: number; continuations: number };
  operations: PlatformOperationDto[];
}

export interface PlatformOperationDto {
  id: string;
  kind: string;
  targetType: string;
  targetId: string;
  state: "pending" | "running" | "completed" | "failed" | "cancelled";
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

export interface InferenceRequestDto {
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

export interface DoctorCheckDto {
  id: string;
  label: string;
  state: "pass" | "warning" | "fail" | "unknown";
  message: string;
  repairable: boolean;
}

export interface LocalModelDto {
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

export interface RoutingDecisionDto {
  requestId: string;
  policyVersion: string;
  catalogVersion: string;
  quotaSnapshotVersion: string | null;
  selected: { providerId: string; accountRefId: string | null; modelId: string; score: number };
  candidates: Array<{ providerId: string; accountRefId: string | null; modelId: string; eligible: boolean; score: number; reasons: string[] }>;
  createdAt: string;
}

export interface PlatformEvidenceDto {
  id: string;
  capability: string;
  category: string;
  state: "pass" | "fail" | "blocked" | "unknown";
  provenance: Record<string, unknown>;
  observedAt: string;
  expiresAt: string | null;
  headSha: string | null;
}

export interface PlatformSnapshot {
  registry: {
    hash: string;
    manifest: { version: number; generatedAt: string; registryHash: string; routesHash: string; litellmHash: string } | null;
    providerCount: number;
    modelCount: number;
  };
  summary: {
    enabledProviders: number;
    readyProviders: number;
    listedModels: number;
    requests24h: number;
    operationsInFlight: number;
    diagnosticsAttention: number;
  };
  providers: ProviderDto[];
  models: ModelDto[];
  accounts: AccountDto[];
  requests: InferenceRequestDto[];
  usage: {
    provenance: string;
    estimatedCostUsd: number | null;
    totals: Array<{
      providerId: string;
      modelId: string;
      requests: number;
      inputTokens: number | null;
      outputTokens: number | null;
      cachedInputTokens: number | null;
      reasoningTokens: number | null;
      estimatedInputTokens: number | null;
      estimatedCost: { amount: number; currency: "USD"; provenance: { source: string; version: string }; estimated: true } | null;
      updatedAt: string;
    }>;
  };
  operations: PlatformOperationDto[];
  diagnostics: DoctorCheckDto[];
  localRuntime: { runtimeId: string; state: string; baseUrl: string; version: number; updatedAt: string | null; checkedAt?: string };
  localModels: LocalModelDto[];
  routingDecisions: RoutingDecisionDto[];
  nativeCatalogs: Array<{ accountRefId: string; clientVersion: string; etag: string | null; hash: string; state: string; observedAt: string }>;
  evidence: PlatformEvidenceDto[];
  installState: { manifest: Record<string, unknown>; version: number; updatedAt: string } | null;
  capabilityLedger: Array<{
    id: string;
    capability: string;
    disposition: "adopted" | "superseded" | "deferred" | "rejected";
    phase: number;
    owner: string;
    evidence: string;
  }>;
}

export interface AgentDetail extends Omit<AgentSummary, "incarnation" | "runtime"> {
  task: string;
  callerScope: string;
  currentIncarnationId: string | null;
  activeIncarnation: Incarnation | null;
  incarnations: Incarnation[];
  runtime: (RuntimeDto & { agents?: AgentSummary[] }) | null;
  pendingInteraction: Interaction | null;
  latestCheckpoint: {
    id: string;
    incarnationId: string;
    quality: "clean" | "unclean";
    payload: Record<string, unknown>;
  } | null;
  routingDecisions: Array<{ decision: Record<string, unknown>; createdAt: string }>;
  latestResultVersion: number;
}

export interface RouterEvent {
  sequence: number;
  eventId: string;
  type: string;
  runtimeId: string | null;
  agentId: string | null;
  incarnationId: string | null;
  threadId: string | null;
  turnId: string | null;
  payload: Record<string, unknown>;
  occurredAt: string;
}

export interface AgentResult {
  agentId: string;
  resultVersion: number;
  status: "completed" | "failed" | "interrupted" | "partial";
  reported: {
    summary: string;
    decisions: string[];
    invariants: string[];
    risks: string[];
    pending: string[];
  };
  observed: {
    runtimeId: string;
    model?: string;
    headSha?: string;
    baseSha?: string;
    changedFiles: string[];
    worktreeStatus: string;
    tests: Array<{
      command: string;
      exitCode: number | null;
      outcome: "passed" | "failed" | "interrupted" | "unknown";
      summary?: string;
    }>;
    terminalError?: { class: string; message: string };
  };
  unverified: string[];
  incarnationHistory: Array<{ incarnationId: string; runtimeId: string; terminalReason?: string }>;
}

export interface WorktreeDto {
  canonicalPath: string;
  repositoryId: string | null;
  headSha: string | null;
  baseSha: string | null;
  dirtyAtRegistration: boolean;
  registrationStatus: string;
  fencingCounter: number;
  updatedAt: string;
  lease: {
    agentId: string;
    incarnationId: string;
    fencingToken: number;
    expiresAt: string;
    acquiredAt: string;
    updatedAt: string;
  } | null;
}

export interface ApiErrorBody {
  error: {
    code: string;
    message: string;
    details?: Record<string, unknown>;
    operationId: string;
    retryable: boolean;
  };
}
