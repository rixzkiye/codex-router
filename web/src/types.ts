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
