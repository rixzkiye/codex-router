import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import { actionAvailability, middleTruncate, relativeTime } from "../web/src/presentation.js";
import type { AgentDetail } from "../web/src/types.js";

describe("Web Console presentation rules", () => {
  it("keeps lifecycle actions aligned with durable state boundaries", () => {
    const running = agent({ status: "running", activeIncarnation: incarnation("turn-1") });
    expect(actionAvailability(running, "steer").available).toBe(true);
    expect(actionAvailability(running, "continue").available).toBe(false);
    expect(actionAvailability(running, "cancel").available).toBe(true);

    const completed = agent({ status: "completed", latestResultVersion: 1, activeIncarnation: incarnation(null) });
    expect(actionAvailability(completed, "continue").available).toBe(true);
    expect(actionAvailability(completed, "steer").available).toBe(false);
    expect(actionAvailability(completed, "view_result").available).toBe(true);
  });

  it("formats scan-friendly relative time and visually bounded identifiers", () => {
    const now = Date.parse("2026-08-13T10:00:00.000Z");
    expect(relativeTime("2026-08-13T09:58:00.000Z", now)).toBe("2m ago");
    expect(middleTruncate("agent_1234567890_abcdefghijklmnopqrstuvwxyz", 20)).toHaveLength(20);
    expect(middleTruncate("short", 20)).toBe("short");
  });

  it("keeps Emil motion anti-patterns out of the production stylesheet", async () => {
    const css = await readFile(new URL("../web/src/styles.css", import.meta.url), "utf8");
    expect(css).not.toMatch(/transition\s*:\s*all\b/);
    expect(css).not.toMatch(/scale\(0\)/);
    expect(css).not.toMatch(/transition[^;]*\bease-in(?:\s|;|,)/);
    expect(css).toContain("prefers-reduced-motion: reduce");
    expect(css).toContain("(hover: hover) and (pointer: fine)");
  });
});

function incarnation(turnId: string | null) {
  return {
    id: "inc-1",
    agentId: "agent-1",
    runtimeId: "runtime-a",
    threadId: "thread-1",
    turnId,
    status: turnId ? "turn_running" : "completed",
    terminalReason: null,
    fencingToken: null,
    createdAt: "2026-08-13T00:00:00.000Z",
    updatedAt: "2026-08-13T00:00:00.000Z"
  };
}

function agent(patch: Partial<AgentDetail>): AgentDetail {
  return {
    id: "agent-1",
    status: "queued",
    task: "fixture",
    taskSummary: "fixture",
    callerScope: "test",
    projectKey: "fixture",
    worktree: { path: "/tmp/fixture", mode: "read_only" },
    routing: {},
    labels: {},
    authority: { allowPush: false, allowMerge: false, allowDeploy: false, allowExternalWrites: false },
    recoveryPolicy: "manual",
    registryVersion: 1,
    semanticOutputObserved: false,
    sideEffectsObserved: false,
    pendingInteractionId: null,
    checkpointQuality: null,
    currentIncarnationId: null,
    activeIncarnation: null,
    incarnations: [],
    runtime: null,
    pendingInteraction: null,
    latestCheckpoint: null,
    routingDecisions: [],
    latestResultVersion: 0,
    createdAt: "2026-08-13T00:00:00.000Z",
    updatedAt: "2026-08-13T00:00:00.000Z",
    ...patch
  };
}
