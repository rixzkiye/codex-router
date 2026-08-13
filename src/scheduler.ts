import type {
  AgentRecord,
  AgentStartRequest,
  RoutingDecision,
  RuntimeHealth,
  RuntimeProfile
} from "./domain.js";
import { RouterError } from "./errors.js";
import type { Registry } from "./store/registry.js";

const POLICY_VERSION = "v1";

export class Scheduler {
  constructor(private readonly registry: Registry) {}

  selectForStart(request: AgentStartRequest): RoutingDecision {
    return this.select({
      request,
      projectKey: request.projectKey,
      worktreeMode: request.worktree.mode,
      task: request.task,
      affinityRuntimeId: null,
      excludeRuntimeIds: []
    });
  }

  selectForHandoff(
    agent: AgentRecord,
    targetRuntimeId: string | undefined,
    excludeRuntimeIds: string[]
  ): RoutingDecision {
    const request: AgentStartRequest = {
      idempotencyKey: "handoff-routing",
      task: agent.task,
      projectKey: agent.projectKey,
      worktree: { path: agent.worktreePath, mode: agent.worktreeMode },
      routing: {
        ...agent.routing,
        ...(targetRuntimeId ? { preferredRuntimeId: targetRuntimeId, allowedRuntimeIds: [targetRuntimeId] } : {})
      },
      authority: agent.authority,
      recoveryPolicy: agent.recoveryPolicy,
      labels: agent.labels
    };
    return this.select({
      request,
      projectKey: agent.projectKey,
      worktreeMode: agent.worktreeMode,
      task: agent.task,
      affinityRuntimeId: null,
      excludeRuntimeIds
    });
  }

  selectForContinuation(agent: AgentRecord, runtimeId: string): RoutingDecision {
    const request: AgentStartRequest = {
      idempotencyKey: "continuation-routing",
      task: agent.task,
      projectKey: agent.projectKey,
      worktree: { path: agent.worktreePath, mode: agent.worktreeMode },
      routing: agent.routing,
      authority: agent.authority,
      recoveryPolicy: agent.recoveryPolicy,
      labels: agent.labels
    };
    return this.select({
      request,
      projectKey: agent.projectKey,
      worktreeMode: agent.worktreeMode,
      task: agent.task,
      affinityRuntimeId: runtimeId,
      excludeRuntimeIds: []
    });
  }

  private select(input: {
    request: AgentStartRequest;
    projectKey: string;
    worktreeMode: "write" | "read_only";
    task: string;
    affinityRuntimeId: string | null;
    excludeRuntimeIds: string[];
  }): RoutingDecision {
    const runtimes = this.registry.listRuntimes();
    const requestedTier = input.request.routing?.capabilityTier ?? "worker";
    const requestedModel = input.request.routing?.model;
    const isSmallTask = input.request.labels.task_size === "small" || input.task.length < 300;
    const candidates = runtimes.map(({ profile, health, activeCount }) => {
      const rejectionReasons = eligibleReasons({
        profile,
        health,
        activeCount,
        requestedTier,
        requestedModel,
        provider: input.request.routing?.provider,
        allowedRuntimeIds: input.request.routing?.allowedRuntimeIds,
        projectKey: input.projectKey,
        affinity: profile.id === input.affinityRuntimeId,
        isSmallTask,
        excluded: input.excludeRuntimeIds.includes(profile.id)
      });
      if (rejectionReasons.length > 0) {
        return {
          runtimeId: profile.id,
          eligible: false,
          rejectionReasons,
          score: null,
          scoreReasons: []
        };
      }
      const { score, reasons } = scoreRuntime(
        profile,
        health,
        activeCount,
        profile.id === input.affinityRuntimeId,
        profile.id === input.request.routing?.preferredRuntimeId,
        input.projectKey,
        requestedTier
      );
      return {
        runtimeId: profile.id,
        eligible: true,
        rejectionReasons,
        score,
        scoreReasons: reasons
      };
    });

    const selected = candidates
      .filter((candidate) => candidate.eligible)
      .sort((a, b) => (b.score ?? 0) - (a.score ?? 0) || a.runtimeId.localeCompare(b.runtimeId))[0];
    if (!selected) {
      throw new RouterError("no_eligible_runtime", "No registered runtime satisfies the routing constraints", {
        candidates
      });
    }
    const selectedHealth = runtimes.find((entry) => entry.profile.id === selected.runtimeId)?.health;
    return {
      selectedRuntimeId: selected.runtimeId,
      candidates,
      affinity: selected.runtimeId === input.affinityRuntimeId,
      quotaSnapshotVersion: selectedHealth?.quota?.snapshotVersion ?? null,
      policyVersion: POLICY_VERSION
    };
  }
}

function eligibleReasons(input: {
  profile: RuntimeProfile;
  health: RuntimeHealth;
  activeCount: number;
  requestedTier: string;
  requestedModel?: string | undefined;
  provider?: string | undefined;
  allowedRuntimeIds?: string[] | undefined;
  projectKey: string;
  affinity: boolean;
  isSmallTask: boolean;
  excluded: boolean;
}): string[] {
  const reasons: string[] = [];
  if (input.excluded) reasons.push("excluded_runtime");
  if (!input.profile.enabled) reasons.push("disabled");
  if (!input.health.initialized) reasons.push("not_initialized");
  if (["limited", "offline"].includes(input.health.state)) reasons.push(input.health.state);
  if (input.health.state === "degraded" && !input.affinity) reasons.push("degraded_for_new_work");
  if (input.health.state === "draining" && !input.affinity && !input.isSmallTask) reasons.push("draining_long_task");
  if (input.activeCount >= input.profile.maxConcurrency) reasons.push("at_capacity");
  if (!input.profile.capabilityTiers.includes(input.requestedTier as never)) reasons.push("capability_tier_mismatch");
  if (input.requestedModel && !input.profile.allowedModels.includes(input.requestedModel)) reasons.push("model_mismatch");
  if (input.provider && input.profile.provider !== input.provider) reasons.push("provider_mismatch");
  if (input.allowedRuntimeIds && !input.allowedRuntimeIds.includes(input.profile.id)) reasons.push("not_in_allowed_runtime_ids");
  const projectTags = input.profile.policyTags.filter((tag) => tag.startsWith("project:"));
  if (projectTags.length > 0 && !projectTags.includes(`project:${input.projectKey}`)) reasons.push("project_not_authorized");
  return reasons;
}

function scoreRuntime(
  profile: RuntimeProfile,
  health: RuntimeHealth,
  activeCount: number,
  affinity: boolean,
  preferred: boolean,
  projectKey: string,
  requestedTier: string
): { score: number; reasons: string[] } {
  let score = 0;
  const reasons: string[] = [];
  if (affinity) {
    score += 10_000;
    reasons.push("existing_thread_affinity:+10000");
  }
  if (preferred) {
    score += 1_000;
    reasons.push("preferred_runtime:+1000");
  }
  if (profile.policyTags.includes(`project:${projectKey}`)) {
    score += 500;
    reasons.push("project_affinity:+500");
  }
  const quotaHeadroom = 100 - (health.quota?.primary?.usedPercent ?? 0);
  score += quotaHeadroom * 2;
  reasons.push(`quota_headroom:+${quotaHeadroom * 2}`);
  const freeSlots = Math.max(0, profile.maxConcurrency - activeCount);
  score += freeSlots * 50;
  reasons.push(`free_slots:+${freeSlots * 50}`);
  const reliability = Math.round((1 - Math.min(1, health.failureRate)) * 100);
  score += reliability;
  reasons.push(`reliability:+${reliability}`);
  const tierIndex = profile.capabilityTiers.indexOf(requestedTier as never);
  const fit = Math.max(0, 40 - tierIndex * 5);
  score += fit;
  reasons.push(`capability_fit:+${fit}`);
  if (health.state === "busy") {
    score -= 25;
    reasons.push("busy:-25");
  }
  if (health.state === "draining") {
    score -= 100;
    reasons.push("draining:-100");
  }
  return { score, reasons };
}
