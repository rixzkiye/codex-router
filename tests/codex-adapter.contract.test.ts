import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import type { NormalizedRuntimeEvent } from "../src/domain.js";
import { CodexAppServerAdapter } from "../src/runtime/codex-app-server.js";
import { SecretRedactor } from "../src/security.js";
import { silentLogger } from "./helpers.js";

describe("Codex App Server protocol contract", () => {
  it("initializes, starts a thread/turn, steers, and confirms interrupt via event", async () => {
    const codexHome = await mkdtemp(path.join(tmpdir(), "codex-home-"));
    process.env.CODEX_ROUTER_FAKE_HOME = codexHome;
    const fixture = fileURLToPath(new URL("./fixtures/fake-app-server.mjs", import.meta.url));
    const adapter = new CodexAppServerAdapter(
      {
        id: "codex-fixture",
        adapter: "codex_app_server",
        provider: "openai",
        capabilityTiers: ["worker"],
        allowedModels: ["gpt-test"],
        maxConcurrency: 1,
        codexHomeRef: "env:CODEX_ROUTER_FAKE_HOME",
        policyTags: [],
        enabled: true,
        command: process.execPath,
        args: [fixture],
        protocolVersion: "fixture",
        approvalPolicy: "on-request",
        networkAccess: false
      },
      silentLogger,
      new SecretRedactor()
    );
    const events: string[] = [];
    adapter.onEvent((event) => {
      events.push(event.type);
    });
    try {
      await adapter.connect();
      const started = await adapter.startTask({
        agentId: "agent-1",
        incarnationId: "inc-1",
        idempotencyKey: "start-1",
        task: "fixture",
        worktreePath: codexHome,
        worktreeMode: "read_only",
        authority: { allowPush: false, allowMerge: false, allowDeploy: false, allowExternalWrites: false },
        model: "gpt-test"
      });
      expect(started).toMatchObject({ threadId: "thr_fixture", turnId: "turn_fixture" });
      await adapter.steer(started.threadId, started.turnId, "new invariant", "steer-1");
      await adapter.interrupt(started.threadId, started.turnId);
      await new Promise((resolve) => setTimeout(resolve, 20));
      expect(events).toContain("thread_started");
      expect(events).toContain("turn_started");
      expect(events).toContain("turn_completed");
    } finally {
      await adapter.close();
      delete process.env.CODEX_ROUTER_FAKE_HOME;
    }
  });

  it("round-trips numeric App Server interaction ids without coercion", async () => {
    const codexHome = await mkdtemp(path.join(tmpdir(), "codex-home-"));
    process.env.CODEX_ROUTER_FAKE_HOME = codexHome;
    const fixture = fileURLToPath(new URL("./fixtures/fake-app-server.mjs", import.meta.url));
    const adapter = new CodexAppServerAdapter(
      {
        id: "codex-fixture",
        adapter: "codex_app_server",
        provider: "openai",
        capabilityTiers: ["worker"],
        allowedModels: ["gpt-test"],
        maxConcurrency: 1,
        codexHomeRef: "env:CODEX_ROUTER_FAKE_HOME",
        policyTags: [],
        enabled: true,
        command: process.execPath,
        args: [fixture],
        protocolVersion: "fixture",
        approvalPolicy: "on-request",
        networkAccess: false
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
      await adapter.startTask({
        agentId: "agent-numeric",
        incarnationId: "inc-numeric",
        idempotencyKey: "start-numeric",
        task: "request numeric approval",
        worktreePath: codexHome,
        worktreeMode: "read_only",
        authority: { allowPush: false, allowMerge: false, allowDeploy: false, allowExternalWrites: false },
        model: "gpt-test"
      });
      await waitUntil(() => events.some((event) => event.type === "pending_interaction"), 500);
      const pending = events.find((event) => event.type === "pending_interaction")!;
      expect(pending.payload.backendRequestId).toBe(7);

      await adapter.respond(
        pending.payload.backendRequestId as number,
        String(pending.payload.method),
        { type: "approval", decision: "deny" },
        pending.payload
      );

      await waitUntil(() => events.some((event) => event.type === "turn_completed"), 500);
      expect(events.find((event) => event.type === "turn_completed")?.payload.status).toBe("interrupted");
    } finally {
      await adapter.close();
      delete process.env.CODEX_ROUTER_FAKE_HOME;
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
