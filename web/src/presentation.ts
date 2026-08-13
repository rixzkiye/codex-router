import type { AgentDetail, AgentStatus, ConnectionState } from "./types.js";

export const STATUS_LABELS: Record<AgentStatus, string> = {
  queued: "Queued",
  starting: "Starting",
  running: "Running",
  needs_attention: "Needs attention",
  cancelling: "Cancelling",
  handing_off: "Handing off",
  waiting_for_reset: "Waiting for reset",
  completed: "Completed",
  failed: "Failed",
  interrupted: "Interrupted"
};

export const CONNECTION_LABELS: Record<ConnectionState, string> = {
  live: "Live",
  reconnecting: "Reconnecting",
  stale: "Stale",
  offline: "Offline"
};

export type AgentAction = "steer" | "continue" | "cancel" | "handoff" | "respond" | "view_result";

export interface ActionAvailability {
  available: boolean;
  reason: string;
}

export function actionAvailability(agent: AgentDetail, action: AgentAction): ActionAvailability {
  if (action === "steer") {
    return agent.status === "running" && Boolean(agent.activeIncarnation?.turnId)
      ? { available: true, reason: "Append instruction to the current turn." }
      : { available: false, reason: "Steer requires a running agent with an active turn." };
  }
  if (action === "continue") {
    return agent.status === "completed" || agent.status === "interrupted"
      ? { available: true, reason: "Start a new turn on the same runtime and thread." }
      : { available: false, reason: "Continue is available only at a completed or interrupted boundary." };
  }
  if (action === "cancel") {
    return agent.status === "running" || agent.status === "needs_attention"
      ? { available: true, reason: "Request interruption; terminal state remains event-confirmed." }
      : { available: false, reason: "Cancel requires running work or a current attention request." };
  }
  if (action === "respond") {
    return agent.status === "needs_attention" && Boolean(agent.pendingInteraction)
      ? { available: true, reason: "Resolve the exact current interaction." }
      : { available: false, reason: "There is no current pending interaction." };
  }
  if (action === "view_result") {
    return agent.latestResultVersion > 0
      ? { available: true, reason: "Open the latest versioned result." }
      : { available: false, reason: "No versioned result has been observed." };
  }
  return ["running", "needs_attention", "failed", "interrupted", "waiting_for_reset", "completed"].includes(agent.status)
    ? { available: true, reason: "Checkpoint and start a new runtime incarnation." }
    : { available: false, reason: "Handoff is not valid while this lifecycle transition is in progress." };
}

export function relativeTime(value: string, now = Date.now()): string {
  const delta = new Date(value).getTime() - now;
  const absolute = Math.abs(delta);
  const suffix = delta < 0 ? "ago" : "from now";
  if (absolute < 10_000) return "just now";
  if (absolute < 60_000) return `${Math.round(absolute / 1_000)}s ${suffix}`;
  if (absolute < 3_600_000) return `${Math.round(absolute / 60_000)}m ${suffix}`;
  if (absolute < 86_400_000) return `${Math.round(absolute / 3_600_000)}h ${suffix}`;
  return `${Math.round(absolute / 86_400_000)}d ${suffix}`;
}

export function exactTime(value: string): string {
  return new Intl.DateTimeFormat(undefined, {
    dateStyle: "medium",
    timeStyle: "long"
  }).format(new Date(value));
}

export function middleTruncate(value: string, length = 28): string {
  if (value.length <= length) return value;
  const available = length - 1;
  const start = Math.ceil(available / 2);
  const end = Math.floor(available / 2);
  return `${value.slice(0, start)}…${value.slice(-end)}`;
}

export function stringifyPayload(value: Record<string, unknown>): string {
  return JSON.stringify(value, null, 2);
}
