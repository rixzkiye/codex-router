import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createServer } from "node:http";
import { once } from "node:events";
import { inferenceConfigSchema } from "../src/config.js";
import { PlatformService } from "../src/platform/service.js";
import { RouterDatabase } from "../src/store/database.js";
import { Registry } from "../src/store/registry.js";

describe("PlatformService", () => {
  let database: RouterDatabase;
  let service: PlatformService;

  beforeEach(() => {
    process.env.PLATFORM_TEST_CALLER = "caller-token-with-at-least-thirty-two-bytes";
    process.env.DEEPSEEK_API_KEY = "provider-secret-canary";
    const inference = inferenceConfigSchema.parse({
      callerTokenRef: "env:PLATFORM_TEST_CALLER",
      host: "127.0.0.1",
      port: 0,
      providers: [{
        id: "deepseek",
        baseUrl: "https://api.deepseek.com",
        credentialRef: "env:DEEPSEEK_API_KEY",
        protocol: "responses",
        requestProfile: "deepseek"
      }],
      models: [{ id: "deepseek/reasoner", providerId: "deepseek", upstreamModel: "deepseek-reasoner" }]
    });
    database = new RouterDatabase(":memory:");
    const registry = new Registry(database);
    service = new PlatformService(database.connection, registry, inference);
  });

  afterEach(async () => {
    await service.close();
    database.close();
    delete process.env.PLATFORM_TEST_CALLER;
    delete process.env.DEEPSEEK_API_KEY;
  });

  it("projects the complete provider target without persisting credential values", () => {
    const provider = service.provider("deepseek");
    expect(provider.authentication).toMatchObject({ state: "ready", source: "environment", reference: "env:DEEPSEEK_API_KEY" });
    expect(service.providers().map((entry) => entry.id)).toEqual(expect.arrayContaining([
      "native-codex", "anthropic-api", "kimi-oauth", "github-copilot", "local", "deepseek"
    ]));
    const persisted = JSON.stringify(database.connection.prepare("SELECT * FROM platform_providers").all());
    expect(persisted).not.toContain("provider-secret-canary");
  });

  it("records an event before a versioned provider mutation and replays the operation idempotently", () => {
    const provider = service.provider("deepseek");
    const input = { idempotencyKey: "enable-deepseek-001", expectedVersion: provider.version };
    const completed = service.setProviderEnabled("test-actor", provider.id, true, input);
    const replay = service.setProviderEnabled("test-actor", provider.id, true, input);
    expect(completed.state).toBe("completed");
    expect(replay.id).toBe(completed.id);
    expect(service.provider("deepseek").enabled).toBe(true);
    const events = database.connection.prepare(
      "SELECT event_type FROM platform_event_journal WHERE operation_id = ? ORDER BY sequence"
    ).all(completed.id) as Array<{ event_type: string }>;
    expect(events.map((event) => event.event_type)).toEqual([
      "platform_operation_started", "provider_enablement_changed", "platform_operation_completed"
    ]);
  });

  it("records sanitized request timing and provider usage", () => {
    service.beginRequest({
      id: "request-1", attemptId: "attempt-1", callerClass: "test", runtimeId: null,
      providerId: "deepseek", accountRefId: "account:deepseek", modelId: "deepseek/reasoner",
      profileHash: "hash", startedAt: "2026-08-13T00:00:00.000Z"
    });
    service.markRequestConnected("request-1");
    service.markSemanticOutput("request-1");
    service.completeRequest("request-1", {
      status: "completed",
      usage: {
        providerInputTokens: 10,
        providerOutputTokens: 4,
        cachedInputTokens: 2,
        reasoningTokens: 1,
        estimatedInputTokens: null
      },
      flags: ["thinking.reasoning_mapped"]
    });
    expect(service.requests(1)[0]).toMatchObject({
      id: "request-1", semanticOutputObserved: true, status: "completed", flags: ["thinking.reasoning_mapped"]
    });
    expect(service.usage().totals[0]).toMatchObject({ providerId: "deepseek", inputTokens: 10, outputTokens: 4 });
  });

  it("generates a no-retry, no-cache translator configuration", () => {
    const artifacts = service.artifacts();
    expect(artifacts.litellmConfig).toContain("num_retries: 0");
    expect(artifacts.litellmConfig).toContain("cache: false");
    expect(artifacts.manifest.registryHash).toMatch(/^[a-f0-9]{64}$/);
  });

  it("fails interrupted operations during startup reconciliation with an audit event", async () => {
    await service.close();
    const operationId = "operation-interrupted-by-restart";
    const createdAt = "2026-08-13T00:00:00.000Z";
    database.connection.prepare(
      `INSERT INTO platform_operations(
        id, kind, target_type, target_id, state, progress, message, actor,
        idempotency_key, expected_version, created_at, updated_at
      ) VALUES (?, 'catalog-refresh', 'provider', 'deepseek', 'running', 0.5, ?, ?, ?, 1, ?, ?)`
    ).run(operationId, "Refreshing provider catalog", "test-actor", "restart-reconciliation-001", createdAt, createdAt);

    const restarted = new PlatformService(database.connection, new Registry(database), undefined);
    try {
      expect(restarted.operation(operationId)).toMatchObject({
        state: "failed",
        error: { code: "interrupted_by_restart" }
      });
      const events = database.connection.prepare(
        "SELECT event_type, actor, payload_json FROM platform_event_journal WHERE operation_id = ? ORDER BY sequence"
      ).all(operationId) as Array<{ event_type: string; actor: string; payload_json: string }>;
      expect(events).toHaveLength(1);
      expect(events[0]).toMatchObject({ event_type: "platform_operation_failed", actor: "startup-reconciliation" });
      expect(JSON.parse(events[0]?.payload_json ?? "{}")).toMatchObject({
        code: "interrupted_by_restart",
        previousActor: "test-actor"
      });
    } finally {
      await restarted.close();
    }
  });

  it("discovers local models durably without auto-publishing them", async () => {
    const server = createServer((request, response) => {
      expect(request.url).toBe("/api/tags");
      response.writeHead(200, { "Content-Type": "application/json" });
      response.end(JSON.stringify({ models: [{ name: "qwen-local:latest" }, { name: "glm-local:9b" }] }));
    });
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("Missing fixture address");
    const localDatabase = new RouterDatabase(":memory:");
    try {
      const inference = inferenceConfigSchema.parse({
        callerTokenRef: "env:PLATFORM_TEST_CALLER",
        host: "127.0.0.1",
        port: 0,
        providers: [{ id: "local", baseUrl: `http://127.0.0.1:${address.port}/v1`, keyless: true, protocol: "responses", requestProfile: "ollama" }],
        models: [{ id: "local/seed", providerId: "local", upstreamModel: "seed" }]
      });
      const localService = new PlatformService(localDatabase.connection, new Registry(localDatabase), inference);
      const provider = localService.provider("local");
      const started = localService.refreshProviderCatalog("test-actor", "local", {
        idempotencyKey: "discover-local-001",
        expectedVersion: provider.version
      });
      expect(started.state).toBe("running");
      await waitForOperation(localService, started.id);
      expect(localService.operation(started.id)).toMatchObject({ state: "completed", result: { discovered: 2 } });
      expect(localService.models()).toEqual(expect.arrayContaining([
        expect.objectContaining({ gatewayId: "local/qwen-local:latest", publication: "discovered", enabled: false }),
        expect.objectContaining({ gatewayId: "local/glm-local:9b", publication: "discovered", enabled: false })
      ]));
    } finally {
      localDatabase.close();
      server.close();
      await once(server, "close");
    }
  });
});

async function waitForOperation(service: PlatformService, id: string): Promise<void> {
  for (let attempt = 0; attempt < 50; attempt += 1) {
    if (!["pending", "running"].includes(service.operation(id).state)) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(`Operation ${id} did not become terminal`);
}
