import { writeFile } from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { RouterError } from "../src/errors.js";
import { CodexRouter } from "../src/router.js";
import { createGitWorktree, dependencies, MockRuntimeAdapter, testConfig } from "./helpers.js";

const routers: CodexRouter[] = [];
afterEach(async () => {
  await Promise.allSettled(routers.splice(0).map((router) => router.close()));
});

describe("Codex Router lifecycle", () => {
  it("starts idempotently, steers, distills evidence, and continues on the same thread", async () => {
    const { root, worktree } = await createGitWorktree();
    const runtime = new MockRuntimeAdapter("runtime-a");
    const router = await CodexRouter.create(testConfig(root), dependencies([runtime]));
    routers.push(router);
    const request = startRequest(worktree, "start-1");
    const first = await router.start("test", request);
    const retry = await router.start("test", request);
    expect(first.agentId).toBe(retry.agentId);
    expect(runtime.starts).toHaveLength(1);
    expect(first.status).toBe("running");

    await router.steer("test", {
      agentId: first.agentId,
      idempotencyKey: "steer-1",
      input: "Preserve the schema",
      expectedTurnId: first.incarnation?.turnId
    });
    expect(runtime.steers).toHaveLength(1);
    await writeFile(path.join(worktree, "changed.txt"), "changed\n", "utf8");
    await runtime.command(first.incarnation!.threadId!, "pnpm test", 0);
    await runtime.finish(
      first.incarnation!.threadId!,
      "completed",
      JSON.stringify({ summary: "implemented", decisions: ["kept schema"], invariants: ["schema stable"] })
    );
    const initialFencingToken = router.registry.getIncarnation(first.incarnation!.id).fencingToken!;
    expect(router.registry.getLeaseForIncarnation(first.incarnation!.id)).toBeNull();
    const result = router.result(first.agentId) as { observed: { changedFiles: string[]; tests: unknown[] }; reported: { decisions: string[] } };
    expect(result.observed.changedFiles).toContain("changed.txt");
    expect(result.observed.tests).toHaveLength(1);
    expect(result.reported.decisions).toEqual(["kept schema"]);

    const continued = await router.continue("test", {
      agentId: first.agentId,
      idempotencyKey: "continue-1",
      input: "Fix the remaining test",
      expectedResultVersion: 1
    });
    if (!("threadId" in continued)) throw new Error("Continuation remained pending");
    expect(continued.threadId).toBe(first.incarnation?.threadId);
    expect(runtime.continuations).toHaveLength(1);
    expect(runtime.continuations[0]?.fencingToken).toBeGreaterThan(initialFencingToken);
    expect(router.registry.getIncarnation(first.incarnation!.id).fencingToken).toBeGreaterThan(initialFencingToken);
  });

  it("retains the writer lease and raises attention when background terminals remain", async () => {
    const { root, worktree } = await createGitWorktree();
    const runtime = new MockRuntimeAdapter("runtime-a");
    runtime.terminalInventory = {
      clean: false,
      terminals: [{ id: "process-1", status: "inProgress", command: "pnpm test" }],
      inspectedAt: new Date().toISOString()
    };
    const router = await CodexRouter.create(testConfig(root), dependencies([runtime]));
    routers.push(router);
    const started = await router.start("test", startRequest(worktree, "background-terminal"));
    const initialLease = router.registry.getLeaseForIncarnation(started.incarnation!.id);

    await runtime.finish(started.incarnation!.threadId!);

    expect(router.status(started.agentId).status).toBe("needs_attention");
    expect(router.registry.getLeaseForIncarnation(started.incarnation!.id)).toMatchObject({
      fencingToken: initialLease!.fencingToken
    });
    expect(
      router.registry.getEvents(started.agentId, 20).some((event) =>
        event.type === "router_command" &&
        (event.payload as Record<string, unknown>).command === "background_terminals_detected"
      )
    ).toBe(true);
  });

  it("does not let an out-of-order terminal event end a newer turn", async () => {
    const { root, worktree } = await createGitWorktree();
    const runtime = new MockRuntimeAdapter("runtime-a");
    const router = await CodexRouter.create(testConfig(root), dependencies([runtime]));
    routers.push(router);
    const started = await router.start("test", startRequest(worktree, "out-of-order", "read_only"));
    const oldBinding = { ...runtime.bindings.get(started.incarnation!.threadId!)! };
    await runtime.finish(started.incarnation!.threadId!);
    await router.continue("test", {
      agentId: started.agentId,
      idempotencyKey: "out-of-order-continue",
      input: "continue",
      expectedResultVersion: 1
    });
    await runtime.emitFor(oldBinding, "turn_completed", {
      status: "completed",
      terminalReason: "delayed-old-event"
    });
    expect(router.status(started.agentId).status).toBe("running");
    expect(router.registry.latestResultVersion(started.agentId)).toBe(1);
  });

  it("redacts secret-like task content before durable persistence or prompting", async () => {
    const { root, worktree } = await createGitWorktree();
    const runtime = new MockRuntimeAdapter("runtime-a");
    const deps = dependencies([runtime]);
    const router = await CodexRouter.create(testConfig(root), deps);
    routers.push(router);
    const request = startRequest(worktree, "redacted-task", "read_only");
    request.task = "Never persist sk-abcdefghijklmnop";
    const started = await router.start("test", request);
    expect(router.registry.getAgent(started.agentId).task).not.toContain("abcdefghijklmnop");
    expect(runtime.starts[0]?.task).not.toContain("abcdefghijklmnop");
    expect(JSON.stringify(router.registry.getEvents(started.agentId, 20))).not.toContain("abcdefghijklmnop");
  });

  it("waits for any and all through registry events without model polling", async () => {
    const { root, worktree } = await createGitWorktree();
    const runtime = new MockRuntimeAdapter("runtime-a");
    const router = await CodexRouter.create(testConfig(root), dependencies([runtime]));
    routers.push(router);
    const a = await router.start("test", startRequest(worktree, "start-a", "read_only"));
    const b = await router.start("test", startRequest(worktree, "start-b", "read_only"));
    const baseline = router.registry.registryVersion;
    const finishA = new Promise<void>((resolve, reject) => {
      setTimeout(() => void runtime.finish(a.incarnation!.threadId!).then(resolve, reject), 10);
    });
    const any = await router.wait({
      ids: [a.agentId, b.agentId],
      mode: "any",
      timeoutMs: 500,
      afterVersion: baseline,
      wakeOn: ["terminal"]
    });
    expect(any.satisfied).toBe(true);
    expect(any.agents.find((agent) => agent.agentId === a.agentId)?.terminal).toBe(true);
    await finishA;
    const finishB = new Promise<void>((resolve, reject) => {
      setTimeout(() => void runtime.finish(b.incarnation!.threadId!).then(resolve, reject), 10);
    });
    const all = await router.wait({
      ids: [a.agentId, b.agentId],
      mode: "all",
      timeoutMs: 500,
      afterVersion: baseline,
      wakeOn: ["terminal"]
    });
    expect(all.satisfied).toBe(true);
    await finishB;
  });

  it("transitions cancellation through cancelling and waits for terminal evidence", async () => {
    const { root, worktree } = await createGitWorktree();
    const runtime = new MockRuntimeAdapter("runtime-a");
    const router = await CodexRouter.create(testConfig(root), dependencies([runtime]));
    routers.push(router);
    const started = await router.start("test", startRequest(worktree, "start-cancel"));
    const cancelled = await router.cancel("test", {
      agentId: started.agentId,
      idempotencyKey: "cancel-1",
      expectedTurnId: started.incarnation?.turnId,
      cleanBackgroundTerminals: true
    });
    if (!("status" in cancelled)) throw new Error("Cancellation remained pending");
    expect(cancelled.status).toBe("cancelling");
    expect(router.status(started.agentId).status).toBe("interrupted");
    expect(
      router.registry.getEvents(started.agentId, 20).some((event) =>
        event.type === "router_command" &&
        (event.payload as Record<string, unknown>).nextStatus === "cancelling"
      )
    ).toBe(true);
  });

  it("hands off through a clean checkpoint and transfers the fenced lease", async () => {
    const { root, worktree } = await createGitWorktree();
    const firstRuntime = new MockRuntimeAdapter("runtime-a");
    const secondRuntime = new MockRuntimeAdapter("runtime-b");
    const router = await CodexRouter.create(
      testConfig(root, ["runtime-a", "runtime-b"]),
      dependencies([firstRuntime, secondRuntime])
    );
    routers.push(router);
    const started = await router.start("test", startRequest(worktree, "start-handoff"));
    const oldBinding = { ...firstRuntime.bindings.get(started.incarnation!.threadId!)! };
    const oldIncarnation = router.registry.getIncarnation(started.incarnation!.id);
    const handoff = await router.handoff("test", {
      agentId: started.agentId,
      idempotencyKey: "handoff-1",
      targetRuntimeId: "runtime-b",
      reason: "operator_request",
      allowUnclean: false
    });
    if (!("incarnation" in handoff)) throw new Error("Handoff remained pending");
    expect(handoff.agentId).toBe(started.agentId);
    expect(handoff.checkpointQuality).toBe("clean");
    expect(handoff.incarnation.runtimeId).toBe("runtime-b");
    const nextIncarnation = router.registry.getIncarnation(handoff.incarnation.id);
    expect(nextIncarnation.fencingToken).toBeGreaterThan(oldIncarnation.fencingToken!);
    expect(router.registry.getIncarnations(started.agentId)).toHaveLength(2);
    expect(secondRuntime.starts[0]?.hydration).toMatchObject({ quality: "clean" });

    const resultVersion = router.registry.latestResultVersion(started.agentId);
    await firstRuntime.emitFor(oldBinding, "turn_started", { turnId: oldBinding.turnId, delayed: true });
    await firstRuntime.emitFor(oldBinding, "turn_completed", {
      status: "completed",
      terminalReason: "delayed-old-incarnation"
    });
    expect(router.status(started.agentId).status).toBe("running");
    expect(router.registry.latestResultVersion(started.agentId)).toBe(resultVersion);
  });

  it("blocks approvals that exceed the original authority envelope", async () => {
    const { root, worktree } = await createGitWorktree();
    const runtime = new MockRuntimeAdapter("runtime-a");
    const router = await CodexRouter.create(testConfig(root), dependencies([runtime]));
    routers.push(router);
    const started = await router.start("test", startRequest(worktree, "start-approval"));
    const interactionId = await runtime.requestApproval(started.incarnation!.threadId!, "git push origin main");
    await expect(
      router.respond("test", {
        agentId: started.agentId,
        interactionId,
        idempotencyKey: "respond-1",
        response: { type: "approval", decision: "approve_once" }
      })
    ).rejects.toMatchObject({ code: "unauthorized" } satisfies Partial<RouterError>);
    expect(runtime.responses).toHaveLength(0);

    await runtime.finish(started.incarnation!.threadId!);
    expect(router.registry.getPendingInteraction(interactionId).state).toBe("expired");
    await expect(
      router.respond("test", {
        agentId: started.agentId,
        interactionId,
        idempotencyKey: "respond-expired",
        response: { type: "approval", decision: "deny" }
      })
    ).rejects.toMatchObject({ code: "conflict" } satisfies Partial<RouterError>);
  });
});

function startRequest(worktree: string, idempotencyKey: string, mode: "write" | "read_only" = "write") {
  return {
    idempotencyKey,
    task: "Implement the bounded fixture task",
    projectKey: "fixture",
    worktree: { path: worktree, mode },
    routing: { capabilityTier: "worker" as const, model: "gpt-test" },
    authority: { allowPush: false, allowMerge: false, allowDeploy: false, allowExternalWrites: false },
    recoveryPolicy: "manual" as const,
    labels: {}
  };
}
