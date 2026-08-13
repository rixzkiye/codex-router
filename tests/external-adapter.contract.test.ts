import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import type { NormalizedRuntimeEvent } from "../src/domain.js";
import { ExternalProcessAdapter } from "../src/runtime/external-process.js";
import { SecretRedactor } from "../src/security.js";
import { silentLogger } from "./helpers.js";

describe("external provider bridge contract", () => {
  it("negotiates capabilities and preserves lifecycle correlation across the JSONL bridge", async () => {
    const worktree = await mkdtemp(path.join(tmpdir(), "external-provider-worktree-"));
    const fixture = fileURLToPath(new URL("./fixtures/fake-external-provider.mjs", import.meta.url));
    const adapter = new ExternalProcessAdapter(
      {
        id: "external-fixture",
        adapter: "external_provider",
        provider: "fixture-provider",
        capabilityTiers: ["worker"],
        allowedModels: ["fixture-model"],
        maxConcurrency: 1,
        policyTags: [],
        enabled: true,
        command: process.execPath,
        args: [fixture],
        capabilities: { steer: true, interrupt: true, resume: true, approvals: true }
      },
      silentLogger,
      new SecretRedactor()
    );
    const events: NormalizedRuntimeEvent[] = [];
    adapter.onEvent((event) => {
      events.push(event);
    });

    try {
      await adapter.connect();
      const started = await adapter.startTask({
        agentId: "agent-external",
        incarnationId: "inc-external",
        idempotencyKey: "external-start",
        task: "fixture task",
        worktreePath: worktree,
        worktreeMode: "write",
        authority: { allowPush: false, allowMerge: false, allowDeploy: false, allowExternalWrites: false },
        model: "fixture-model",
        fencingToken: 41
      });
      expect(started).toMatchObject({ threadId: "external-thread", turnId: "external-turn-1" });
      await waitUntil(() => events.some((event) => event.type === "command_completed"), 500);
      expect(events.find((event) => event.type === "command_completed")).toMatchObject({
        agentId: "agent-external",
        incarnationId: "inc-external",
        threadId: "external-thread"
      });

      const continued = await adapter.continueTurn({
        agentId: "agent-external",
        incarnationId: "inc-external",
        idempotencyKey: "external-continue",
        threadId: started.threadId,
        input: "continue",
        worktreePath: worktree,
        worktreeMode: "write",
        model: "fixture-model",
        fencingToken: 42
      });
      expect(continued.turnId).toBe("external-turn-2");
      await adapter.steer(continued.threadId, continued.turnId, "new constraint", "external-steer");
      await adapter.respond(
        9,
        "item/commandExecution/requestApproval",
        { type: "approval", decision: "deny" },
        { command: "pnpm test" }
      );
      await expect(adapter.reconcile(continued.threadId, continued.turnId)).resolves.toMatchObject({
        state: "active",
        turnId: continued.turnId
      });
      await expect(adapter.findThreadByCorrelation("agent-external", "inc-external", worktree)).resolves.toBe(
        "external-thread"
      );
      await expect(adapter.inspectBackgroundTerminals(continued.threadId)).resolves.toMatchObject({
        clean: true,
        terminals: []
      });

      await adapter.interrupt(continued.threadId, continued.turnId);
      await waitUntil(
        () => events.some((event) => event.type === "turn_completed" && event.turnId === continued.turnId),
        500
      );
    } finally {
      await adapter.close();
    }
  });
});

async function waitUntil(predicate: () => boolean, timeoutMs: number): Promise<void> {
  const started = Date.now();
  while (!predicate()) {
    if (Date.now() - started > timeoutMs) throw new Error("Condition timed out");
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}
