import { z } from "zod";

export const capabilityTierSchema = z.enum([
  "architect",
  "principal",
  "senior",
  "worker"
]);
export type CapabilityTier = z.infer<typeof capabilityTierSchema>;

export const agentStatusSchema = z.enum([
  "queued",
  "starting",
  "running",
  "needs_attention",
  "cancelling",
  "handing_off",
  "waiting_for_reset",
  "completed",
  "failed",
  "interrupted"
]);
export type AgentStatus = z.infer<typeof agentStatusSchema>;

export const incarnationStatusSchema = z.enum([
  "allocating",
  "thread_ready",
  "turn_running",
  "quiescing",
  "completed",
  "failed",
  "interrupted",
  "lost"
]);
export type IncarnationStatus = z.infer<typeof incarnationStatusSchema>;

export const runtimeStateSchema = z.enum([
  "ready",
  "busy",
  "draining",
  "limited",
  "degraded",
  "offline"
]);
export type RuntimeState = z.infer<typeof runtimeStateSchema>;

export const failureClassSchema = z.enum([
  "usage_limit",
  "authentication",
  "provider_unavailable",
  "transport_disconnected",
  "context_window",
  "session_budget",
  "permission_denied",
  "approval_timeout",
  "runtime_crash",
  "worktree_conflict",
  "cancelled",
  "unknown"
]);
export type FailureClass = z.infer<typeof failureClassSchema>;

export const authoritySchema = z
  .object({
    allowPush: z.boolean().default(false),
    allowMerge: z.boolean().default(false),
    allowDeploy: z.boolean().default(false),
    allowExternalWrites: z.boolean().default(false)
  });
export type AuthorityEnvelope = z.infer<typeof authoritySchema>;

export const routingRequestSchema = z.object({
  capabilityTier: capabilityTierSchema.optional(),
  preferredRuntimeId: z.string().min(1).optional(),
  allowedRuntimeIds: z.array(z.string().min(1)).min(1).optional(),
  provider: z.string().min(1).optional(),
  model: z.string().min(1).optional()
});
export type RoutingRequest = z.infer<typeof routingRequestSchema>;

export const agentStartRequestSchema = z.object({
  idempotencyKey: z.string().min(1).max(256),
  task: z.string().min(1).max(200_000),
  projectKey: z.string().min(1).max(256),
  worktree: z.object({
    path: z.string().min(1),
    mode: z.enum(["write", "read_only"])
  }),
  routing: routingRequestSchema.optional(),
  authority: authoritySchema.optional(),
  recoveryPolicy: z
    .enum(["manual", "wait_for_reset", "auto_handoff_if_clean"])
    .default("manual"),
  labels: z.record(z.string(), z.string()).default({})
});
export type AgentStartRequest = z.infer<typeof agentStartRequestSchema>;

export const agentStatusRequestSchema = z.object({
  agentId: z.string().min(1),
  includeHistory: z.boolean().default(false)
});

export const agentListRequestSchema = z.object({
  status: agentStatusSchema.optional(),
  projectKey: z.string().optional(),
  worktree: z.string().optional(),
  runtimeId: z.string().optional(),
  capabilityTier: capabilityTierSchema.optional(),
  label: z
    .object({ key: z.string().min(1), value: z.string() })
    .optional(),
  afterVersion: z.number().int().nonnegative().optional(),
  cursor: z.string().optional(),
  limit: z.number().int().min(1).max(100).default(50)
});

export const wakeConditionSchema = z.enum([
  "terminal",
  "needs_attention",
  "handoff",
  "status_change"
]);

export const agentWaitRequestSchema = z.object({
  ids: z.array(z.string().min(1)).min(1).max(100),
  mode: z.enum(["any", "all"]),
  timeoutMs: z.number().int().nonnegative(),
  afterVersion: z.number().int().nonnegative().optional(),
  wakeOn: z.array(wakeConditionSchema).min(1).default(["terminal", "needs_attention"])
});
export type AgentWaitRequest = z.infer<typeof agentWaitRequestSchema>;

const mutatingCommandBase = z.object({
  agentId: z.string().min(1),
  idempotencyKey: z.string().min(1).max(256)
});

export const agentSteerRequestSchema = mutatingCommandBase.extend({
  input: z.string().min(1).max(100_000),
  expectedIncarnationId: z.string().optional(),
  expectedTurnId: z.string().optional()
});
export type AgentSteerRequest = z.infer<typeof agentSteerRequestSchema>;

export const agentContinueRequestSchema = mutatingCommandBase.extend({
  input: z.string().min(1).max(100_000),
  expectedResultVersion: z.number().int().positive().optional()
});
export type AgentContinueRequest = z.infer<typeof agentContinueRequestSchema>;

export const agentCancelRequestSchema = mutatingCommandBase.extend({
  expectedTurnId: z.string().optional(),
  cleanBackgroundTerminals: z.boolean().default(false)
});
export type AgentCancelRequest = z.infer<typeof agentCancelRequestSchema>;

export const agentHandoffRequestSchema = mutatingCommandBase.extend({
  targetRuntimeId: z.string().optional(),
  reason: z.enum(["planned", "quota", "runtime_failure", "operator_request"]),
  additionalInstruction: z.string().max(100_000).optional(),
  allowUnclean: z.boolean().default(false)
});
export type AgentHandoffRequest = z.infer<typeof agentHandoffRequestSchema>;

export const agentResultRequestSchema = z.object({
  agentId: z.string().min(1),
  version: z.number().int().positive().optional(),
  detail: z.enum(["summary", "evidence", "debug"]).default("summary")
});

export const agentRespondRequestSchema = mutatingCommandBase.extend({
  interactionId: z.string().min(1),
  response: z.discriminatedUnion("type", [
    z.object({
      type: z.literal("approval"),
      decision: z.enum(["approve_once", "deny"])
    }),
    z.object({ type: z.literal("user_input"), input: z.string().max(100_000) })
  ])
});
export type AgentRespondRequest = z.infer<typeof agentRespondRequestSchema>;

export type CheckpointQuality = "clean" | "unclean";
export type RecoveryPolicy = AgentStartRequest["recoveryPolicy"];

export interface RuntimeProfile {
  id: string;
  adapter: "codex_app_server" | "external_provider";
  provider: string;
  capabilityTiers: CapabilityTier[];
  allowedModels: string[];
  maxConcurrency: number;
  policyTags: string[];
  enabled: boolean;
}

export interface RuntimeHealth {
  state: RuntimeState;
  initialized: boolean;
  activeCount: number;
  failureRate: number;
  eventLagMs: number;
  quota: RateLimitSnapshot | null;
  updatedAt: string;
}

export interface RateLimitWindow {
  usedPercent?: number;
  windowDurationMinutes?: number;
  resetsAt?: number;
}

export interface RateLimitSnapshot {
  primary?: RateLimitWindow;
  secondary?: RateLimitWindow;
  credits?: { hasCredits?: boolean; unlimited?: boolean; balance?: string };
  limitId?: string;
  limitName?: string;
  planType?: string;
  snapshotVersion: number;
  updatedAt: string;
}

export interface AgentRecord {
  id: string;
  callerScope: string;
  task: string;
  projectKey: string;
  worktreePath: string;
  worktreeMode: "write" | "read_only";
  routing: RoutingRequest;
  authority: AuthorityEnvelope;
  recoveryPolicy: RecoveryPolicy;
  labels: Record<string, string>;
  status: AgentStatus;
  registryVersion: number;
  currentIncarnationId: string | null;
  semanticOutputSeen: boolean;
  sideEffectsSeen: boolean;
  pendingInteractionId: string | null;
  checkpointQuality: CheckpointQuality | null;
  lastEventSequence: number | null;
  createdAt: string;
  updatedAt: string;
}

export interface IncarnationRecord {
  id: string;
  agentId: string;
  runtimeId: string;
  threadId: string | null;
  turnId: string | null;
  status: IncarnationStatus;
  terminalReason: string | null;
  fencingToken: number | null;
  createdAt: string;
  updatedAt: string;
}

export interface PendingInteraction {
  id: string;
  agentId: string;
  incarnationId: string;
  runtimeId: string;
  backendRequestId: string | number;
  method: string;
  kind: "approval" | "user_input";
  params: Record<string, unknown>;
  state: "pending" | "resolved" | "expired";
  createdAt: string;
  resolvedAt: string | null;
}

export interface RoutingDecision {
  selectedRuntimeId: string;
  candidates: Array<{
    runtimeId: string;
    eligible: boolean;
    rejectionReasons: string[];
    score: number | null;
    scoreReasons: string[];
  }>;
  affinity: boolean;
  quotaSnapshotVersion: number | null;
  policyVersion: string;
}

export interface ObservedTest {
  command: string;
  exitCode: number | null;
  outcome: "passed" | "failed" | "interrupted" | "unknown";
  summary?: string;
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
    tests: ObservedTest[];
    terminalError?: { class: string; message: string };
  };
  unverified: string[];
  incarnationHistory: Array<{
    incarnationId: string;
    runtimeId: string;
    terminalReason?: string;
  }>;
}

export interface NormalizedRuntimeEvent {
  eventId: string;
  backendEventKey?: string;
  runtimeId: string;
  agentId?: string;
  incarnationId?: string;
  threadId?: string;
  turnId?: string;
  type:
    | "thread_started"
    | "thread_status_changed"
    | "turn_started"
    | "semantic_output"
    | "command_started"
    | "command_completed"
    | "file_change"
    | "turn_diff_updated"
    | "pending_interaction"
    | "interaction_resolved"
    | "turn_completed"
    | "runtime_error"
    | "runtime_disconnected"
    | "account_updated"
    | "rate_limits_updated"
    | "router_command"
    | "routing_decision"
    | "checkpoint_created"
    | "reconciliation";
  payload: Record<string, unknown>;
  occurredAt: string;
}

export const TERMINAL_AGENT_STATUSES = new Set<AgentStatus>([
  "completed",
  "failed",
  "interrupted"
]);

export function isTerminalStatus(status: AgentStatus): boolean {
  return TERMINAL_AGENT_STATUSES.has(status);
}
