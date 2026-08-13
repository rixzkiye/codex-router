import { afterEach, describe, expect, it } from "vitest";
import { CodexRouter } from "../src/router.js";
import { createGitWorktree, dependencies, MockRuntimeAdapter, testConfig } from "./helpers.js";

const routers: CodexRouter[] = [];
afterEach(async () => {
  await Promise.allSettled(routers.splice(0).map((router) => router.close()));
});

describe("recovery and fencing", () => {
  it("does not duplicate an active turn while reconciling after router restart", async () => {
    const { root, worktree } = await createGitWorktree();
    const firstRuntime = new MockRuntimeAdapter("runtime-a");
    const firstRouter = await CodexRouter.create(testConfig(root), dependencies([firstRuntime]));
    const started = await firstRouter.start("test", startRequest(worktree, "restart-start"));
    expect(firstRuntime.starts).toHaveLength(1);
    await firstRouter.close();

    const secondRuntime = new MockRuntimeAdapter("runtime-a");
    secondRuntime.reconcileResult = {
      state: "terminal",
      threadId: started.incarnation!.threadId!,
      turnId: started.incarnation!.turnId!,
      turnStatus: "completed",
      evidence: { source: "fixture-reconciliation" }
    };
    const secondRouter = await CodexRouter.create(testConfig(root), dependencies([secondRuntime]));
    routers.push(secondRouter);
    expect(secondRuntime.starts).toHaveLength(0);
    expect(secondRouter.status(started.agentId).status).toBe("completed");
    expect(secondRouter.result(started.agentId)).toMatchObject({ status: "completed" });
  });

  it("rebinds the recovered runtime so later terminal events reach the durable agent", async () => {
    const { root, worktree } = await createGitWorktree();
    const firstRuntime = new MockRuntimeAdapter("runtime-a");
    const firstRouter = await CodexRouter.create(testConfig(root), dependencies([firstRuntime]));
    const started = await firstRouter.start("test", startRequest(worktree, "restart-rebind", "read_only"));
    await firstRouter.close();

    const secondRuntime = new MockRuntimeAdapter("runtime-a");
    secondRuntime.reconcileResult = {
      state: "active",
      threadId: started.incarnation!.threadId!,
      turnId: started.incarnation!.turnId!,
      evidence: { source: "fixture-reconciliation" }
    };
    const secondRouter = await CodexRouter.create(testConfig(root), dependencies([secondRuntime]));
    routers.push(secondRouter);
    expect(secondRouter.status(started.agentId).status).toBe("running");

    await secondRuntime.finish(started.incarnation!.threadId!);

    expect(secondRouter.status(started.agentId).status).toBe("completed");
    expect(secondRouter.result(started.agentId)).toMatchObject({ status: "completed" });
  });

  it("discovers a correlated thread when the start response was lost before projection", async () => {
    const { root, worktree } = await createGitWorktree();
    const firstRuntime = new MockRuntimeAdapter("runtime-a");
    const firstRouter = await CodexRouter.create(testConfig(root), dependencies([firstRuntime]));
    const request = startRequest(worktree, "lost-response-start");
    firstRouter.registry.registerWorktree({
      canonicalPath: worktree,
      repositoryId: worktree,
      headSha: null,
      baseSha: null,
      dirty: false,
      status: "clean"
    });
    const created = firstRouter.registry.createAgent("test", request, worktree, 60_000);
    const incarnation = firstRouter.registry.createIncarnation(created.agent.id, "runtime-a");
    firstRouter.registry.acquireWriteLease(worktree, created.agent.id, incarnation.id, 60_000);
    await firstRouter.close();

    const secondRuntime = new MockRuntimeAdapter("runtime-a");
    secondRuntime.correlatedThreadId = "thread-recovered";
    secondRuntime.reconcileResult = {
      state: "active",
      threadId: "thread-recovered",
      turnId: "turn-recovered",
      evidence: { source: "threadSource" }
    };
    const secondRouter = await CodexRouter.create(testConfig(root), dependencies([secondRuntime]));
    routers.push(secondRouter);
    expect(secondRuntime.starts).toHaveLength(0);
    expect(secondRouter.status(created.agent.id).status).toBe("running");
    expect(secondRouter.registry.getIncarnation(incarnation.id)).toMatchObject({
      threadId: "thread-recovered",
      turnId: "turn-recovered"
    });
  });

  it("allows only one live writer lease for a worktree", async () => {
    const { root, worktree } = await createGitWorktree();
    const runtime = new MockRuntimeAdapter("runtime-a");
    const router = await CodexRouter.create(testConfig(root), dependencies([runtime]));
    routers.push(router);
    const first = await router.start("test", startRequest(worktree, "writer-1"));
    const second = await router.start("test", startRequest(worktree, "writer-2"));
    expect(first.status).toBe("running");
    expect(second.status).toBe("needs_attention");
    expect(runtime.starts).toHaveLength(1);
  });

  it("renews a writer lease for work that outlives the initial TTL", async () => {
    const { root, worktree } = await createGitWorktree();
    const runtime = new MockRuntimeAdapter("runtime-a");
    const config = testConfig(root);
    config.leaseTtlMs = 60;
    const router = await CodexRouter.create(config, dependencies([runtime]));
    routers.push(router);
    await router.start("test", startRequest(worktree, "long-writer-1"));
    await new Promise((resolve) => setTimeout(resolve, 180));
    const second = await router.start("test", startRequest(worktree, "long-writer-2"));
    expect(second.status).toBe("needs_attention");
    expect(runtime.starts).toHaveLength(1);
  });

  it("rejects conflicting payloads that reuse a start idempotency key", async () => {
    const { root, worktree } = await createGitWorktree();
    const runtime = new MockRuntimeAdapter("runtime-a");
    const router = await CodexRouter.create(testConfig(root), dependencies([runtime]));
    routers.push(router);
    await router.start("test", startRequest(worktree, "same-key", "read_only"));
    await expect(
      router.start("test", {
        ...startRequest(worktree, "same-key", "read_only"),
        task: "A conflicting objective"
      })
    ).rejects.toMatchObject({ code: "idempotency_conflict" });
    expect(runtime.starts).toHaveLength(1);
  });

  it("blocks an unclean handoff unless explicitly authorized", async () => {
    const { root, worktree } = await createGitWorktree();
    const runtimeA = new MockRuntimeAdapter("runtime-a");
    const runtimeB = new MockRuntimeAdapter("runtime-b");
    runtimeA.terminalInventory = {
      clean: false,
      terminals: [{ id: "process-1", status: "inProgress", command: "pnpm test" }],
      inspectedAt: new Date().toISOString()
    };
    const router = await CodexRouter.create(
      testConfig(root, ["runtime-a", "runtime-b"]),
      dependencies([runtimeA, runtimeB])
    );
    routers.push(router);
    const started = await router.start("test", startRequest(worktree, "unclean-start"));
    await expect(
      router.handoff("test", {
        agentId: started.agentId,
        idempotencyKey: "unclean-handoff",
        targetRuntimeId: "runtime-b",
        reason: "runtime_failure",
        allowUnclean: false
      })
    ).rejects.toMatchObject({ code: "conflict" });
    expect(router.status(started.agentId).status).toBe("needs_attention");
    expect(runtimeB.starts).toHaveLength(0);
  });

  it("performs policy-gated clean handoff after a structured usage limit", async () => {
    const { root, worktree } = await createGitWorktree();
    const runtimeA = new MockRuntimeAdapter("runtime-a");
    const runtimeB = new MockRuntimeAdapter("runtime-b");
    const router = await CodexRouter.create(
      testConfig(root, ["runtime-a", "runtime-b"]),
      dependencies([runtimeA, runtimeB])
    );
    routers.push(router);
    const started = await router.start("test", {
      ...startRequest(worktree, "quota-start"),
      recoveryPolicy: "auto_handoff_if_clean"
    });
    const binding = runtimeA.bindings.get(started.incarnation!.threadId!)!;
    await runtimeA.emitFor(binding, "runtime_error", {
      class: "usage_limit",
      message: "limit reached"
    });
    await runtimeA.finish(started.incarnation!.threadId!, "failed", "partial work preserved");
    await waitUntil(() => runtimeB.starts.length === 1, 1_000);
    expect(runtimeB.starts).toHaveLength(1);
    expect(router.registry.getIncarnations(started.agentId)).toHaveLength(2);
    expect(runtimeB.starts[0]?.hydration).toMatchObject({ quality: "clean" });
  });
});

function startRequest(worktree: string, idempotencyKey: string, mode: "write" | "read_only" = "write") {
  return {
    idempotencyKey,
    task: "Implement the recovery fixture",
    projectKey: "fixture",
    worktree: { path: worktree, mode },
    routing: { capabilityTier: "worker" as const, model: "gpt-test" },
    authority: { allowPush: false, allowMerge: false, allowDeploy: false, allowExternalWrites: false },
    recoveryPolicy: "manual" as const,
    labels: {}
  };
}

async function waitUntil(predicate: () => boolean, timeoutMs: number): Promise<void> {
  const started = Date.now();
  while (!predicate()) {
    if (Date.now() - started > timeoutMs) throw new Error("Condition timed out");
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}
