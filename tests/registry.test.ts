import { describe, expect, it } from "vitest";
import { RouterDatabase } from "../src/store/database.js";
import { Registry } from "../src/store/registry.js";
import { createGitWorktree } from "./helpers.js";

describe("durable registry invariants", () => {
  it("merges sparse quota updates without erasing prior fields", async () => {
    const { root } = await createGitWorktree();
    const database = new RouterDatabase(":memory:");
    const registry = new Registry(database);
    registry.registerRuntime({
      id: "runtime-a",
      adapter: "codex_app_server",
      provider: "openai",
      capabilityTiers: ["worker"],
      allowedModels: ["gpt-test"],
      maxConcurrency: 1,
      policyTags: [],
      enabled: true
    });
    registry.updateRuntimeHealth("runtime-a", { initialized: true, state: "ready" });
    registry.mergeRateLimit("runtime-a", {
      primary: { usedPercent: 20, windowDurationMinutes: 300 },
      secondary: { usedPercent: 10 }
    });
    registry.mergeRateLimit("runtime-a", { primary: { usedPercent: 25 } });
    const quota = registry.getRuntime("runtime-a").health.quota;
    expect(quota?.primary).toEqual({ usedPercent: 25, windowDurationMinutes: 300 });
    expect(quota?.secondary).toEqual({ usedPercent: 10 });
    expect(quota?.snapshotVersion).toBe(2);
    database.close();
    expect(root).toBeTruthy();
  });

  it("suppresses duplicate backend events", () => {
    const database = new RouterDatabase(":memory:");
    const registry = new Registry(database);
    registry.registerRuntime({
      id: "runtime-a",
      adapter: "codex_app_server",
      provider: "openai",
      capabilityTiers: ["worker"],
      allowedModels: ["gpt-test"],
      maxConcurrency: 1,
      policyTags: [],
      enabled: true
    });
    const event = {
      eventId: "event-1",
      backendEventKey: "backend-1",
      runtimeId: "runtime-a",
      type: "rate_limits_updated" as const,
      payload: { primary: { usedPercent: 30 } },
      occurredAt: new Date().toISOString()
    };
    expect(registry.appendAndProject(event).inserted).toBe(true);
    expect(registry.appendAndProject({ ...event, eventId: "event-2" }).inserted).toBe(false);
    expect(registry.getRuntime("runtime-a").health.quota?.snapshotVersion).toBe(1);
    database.close();
  });

  it("preserves an early pending interaction across the matching turn-start projection", () => {
    const database = new RouterDatabase(":memory:");
    const registry = new Registry(database);
    registry.registerRuntime({
      id: "runtime-a",
      adapter: "codex_app_server",
      provider: "openai",
      capabilityTiers: ["worker"],
      allowedModels: ["gpt-test"],
      maxConcurrency: 1,
      policyTags: [],
      enabled: true
    });
    const { agent } = registry.createAgent(
      "test",
      {
        idempotencyKey: "early-interaction",
        task: "fixture",
        projectKey: "fixture",
        worktree: { path: "/tmp/fixture", mode: "read_only" },
        routing: { capabilityTier: "worker", model: "gpt-test" },
        authority: { allowPush: false, allowMerge: false, allowDeploy: false, allowExternalWrites: false },
        recoveryPolicy: "manual",
        labels: {}
      },
      "/tmp/fixture",
      60_000
    );
    const incarnation = registry.createIncarnation(agent.id, "runtime-a");
    registry.appendAndProject({
      eventId: "pending-before-start",
      runtimeId: "runtime-a",
      agentId: agent.id,
      incarnationId: incarnation.id,
      threadId: "thread-1",
      turnId: "turn-1",
      type: "pending_interaction",
      payload: {
        interactionId: "interaction-1",
        backendRequestId: 17,
        method: "item/commandExecution/requestApproval",
        kind: "approval",
        params: { command: "pnpm test" }
      },
      occurredAt: new Date().toISOString()
    });
    registry.appendAndProject({
      eventId: "turn-start-after-pending",
      runtimeId: "runtime-a",
      agentId: agent.id,
      incarnationId: incarnation.id,
      threadId: "thread-1",
      turnId: "turn-1",
      type: "turn_started",
      payload: { turnId: "turn-1" },
      occurredAt: new Date().toISOString()
    });

    expect(registry.getAgent(agent.id)).toMatchObject({
      status: "needs_attention",
      pendingInteractionId: "interaction-1"
    });
    expect(registry.getPendingInteraction("interaction-1").backendRequestId).toBe(17);

    registry.appendAndProject({
      eventId: "turn-completed-after-pending",
      runtimeId: "runtime-a",
      agentId: agent.id,
      incarnationId: incarnation.id,
      threadId: "thread-1",
      turnId: "turn-1",
      type: "turn_completed",
      payload: { status: "completed", terminalReason: "completed" },
      occurredAt: new Date().toISOString()
    });
    expect(registry.getPendingInteraction("interaction-1").state).toBe("expired");
    expect(() => registry.resolveInteraction("interaction-1", { decision: "decline" })).toThrow(
      "Interaction is no longer current"
    );
    database.close();
  });
});
