import type { AgentResult, AgentStatus, ObservedTest } from "./domain.js";
import type { Registry } from "./store/registry.js";
import type { WorktreeInspector } from "./worktree.js";

export class ResultDistiller {
  constructor(
    private readonly registry: Registry,
    private readonly worktrees: WorktreeInspector
  ) {}

  async distill(agentId: string): Promise<AgentResult> {
    const agent = this.registry.getAgent(agentId);
    const incarnations = this.registry.getIncarnations(agentId);
    const active = incarnations.find((item) => item.id === agent.currentIncarnationId) ?? incarnations.at(-1);
    if (!active) throw new Error(`Cannot distill agent ${agentId} without an incarnation`);
    const worktree = await this.worktrees.inspect(agent.worktreePath);
    const events = this.registry.getEvents(agentId, 500).reverse();
    const turnCompleted = events.findLast((event) => event.type === "turn_completed");
    const runtimeError = events.findLast((event) => event.type === "runtime_error");
    const reported = normalizeReported(asRecord(asRecord(turnCompleted?.payload).reported));
    const tests = extractTests(events);
    const terminalError = extractTerminalError(turnCompleted, runtimeError);
    const status = resultStatus(agent.status, reported.pending.length > 0);
    const unverified: string[] = [];
    if (reported.summary && tests.length === 0) {
      unverified.push("Worker summary has no matching observed command/test evidence");
    }
    if (worktree.status === "not_git") {
      unverified.push("Git evidence is unavailable because the registered worktree is not a Git checkout");
    }
    const observed: AgentResult["observed"] = {
      runtimeId: active.runtimeId,
      ...(agent.routing.model ? { model: agent.routing.model } : {}),
      ...(worktree.headSha ? { headSha: worktree.headSha } : {}),
      ...(worktree.baseSha ? { baseSha: worktree.baseSha } : {}),
      changedFiles: worktree.changedFiles,
      worktreeStatus: worktree.statusText || worktree.status,
      tests,
      ...(terminalError ? { terminalError } : {})
    };
    return {
      agentId,
      resultVersion: 0,
      status,
      reported,
      observed,
      unverified,
      incarnationHistory: incarnations.map((incarnation) => ({
        incarnationId: incarnation.id,
        runtimeId: incarnation.runtimeId,
        ...(incarnation.terminalReason ? { terminalReason: incarnation.terminalReason } : {})
      }))
    };
  }
}

function normalizeReported(value: Record<string, unknown>): AgentResult["reported"] {
  const summary = typeof value.summary === "string" ? value.summary : "";
  const structured = parseStructuredSummary(summary);
  return {
    summary: typeof structured?.summary === "string" ? structured.summary : summary,
    decisions: stringArray(structured?.decisions ?? value.decisions),
    invariants: stringArray(structured?.invariants ?? value.invariants),
    risks: stringArray(structured?.risks ?? value.risks),
    pending: stringArray(structured?.pending ?? value.pending)
  };
}

function parseStructuredSummary(summary: string): Record<string, unknown> | null {
  const trimmed = summary.trim();
  if (!trimmed.startsWith("{")) return null;
  try {
    const parsed = JSON.parse(trimmed) as unknown;
    return asRecord(parsed);
  } catch {
    return null;
  }
}

function extractTests(events: Array<Record<string, unknown>>): ObservedTest[] {
  const tests: ObservedTest[] = [];
  for (const event of events) {
    if (event.type !== "command_completed") continue;
    const payload = asRecord(event.payload);
    const command = commandText(payload.command);
    if (!command || !/(^|\s)(test|check|build|lint|typecheck|verify)(:|\s|$)|vitest|jest|pytest|cargo test|go test/i.test(command)) {
      continue;
    }
    const rawExit = payload.exitCode;
    const exitCode = typeof rawExit === "number" ? rawExit : null;
    const status = String(payload.status ?? "");
    const outcome: ObservedTest["outcome"] =
      exitCode === 0 ? "passed" : exitCode !== null ? "failed" : /interrupt/i.test(status) ? "interrupted" : "unknown";
    tests.push({
      command,
      exitCode,
      outcome,
      ...(typeof payload.output === "string" && payload.output ? { summary: payload.output.slice(-1_000) } : {})
    });
  }
  return tests;
}

function extractTerminalError(
  turn: Record<string, unknown> | undefined,
  runtime: Record<string, unknown> | undefined
): { class: string; message: string } | undefined {
  const turnPayload = asRecord(turn?.payload);
  const error = asRecord(turnPayload.error);
  const runtimePayload = asRecord(runtime?.payload);
  const message =
    (typeof error.message === "string" && error.message) ||
    (typeof runtimePayload.message === "string" && runtimePayload.message) ||
    "";
  if (!message) return undefined;
  return {
    class:
      (typeof runtimePayload.class === "string" && runtimePayload.class) ||
      (typeof turnPayload.terminalReason === "string" && turnPayload.terminalReason) ||
      "unknown",
    message
  };
}

function resultStatus(status: AgentStatus, hasPending: boolean): AgentResult["status"] {
  if (hasPending) return "partial";
  if (status === "completed") return "completed";
  if (status === "interrupted") return "interrupted";
  if (status === "failed") return "failed";
  return "partial";
}

function commandText(value: unknown): string {
  if (typeof value === "string") return value;
  if (Array.isArray(value)) return value.map(String).join(" ");
  return "";
}

function stringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}
