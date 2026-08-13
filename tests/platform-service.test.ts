import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createServer } from "node:http";
import { once } from "node:events";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { inferenceConfigSchema } from "../src/config.js";
import { PlatformService } from "../src/platform/service.js";
import { RouterDatabase } from "../src/store/database.js";
import { Registry } from "../src/store/registry.js";
import type { CredentialStore } from "../src/platform/credentials.js";

describe("PlatformService", () => {
  let database: RouterDatabase;
  let service: PlatformService;
  let credentialStore: CredentialStore;

  beforeEach(() => {
    process.env.PLATFORM_TEST_CALLER = "caller-token-with-at-least-thirty-two-bytes";
    process.env.DEEPSEEK_API_KEY = "provider-secret-canary";
    credentialStore = {
      promptAndStore: vi.fn(async (reference: string) => {
        process.env.DEEPSEEK_API_KEY = "provider-secret-canary";
        return { reference, source: "protected-router-store" as const };
      })
    };
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
    service = new PlatformService(database.connection, registry, inference, { credentialStore });
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

  it("persists a browser-safe provider and model overlay, then reads it back after restart", async () => {
    const localDatabase = new RouterDatabase(":memory:");
    const first = new PlatformService(localDatabase.connection, new Registry(localDatabase), undefined);
    try {
      const deepseek = first.provider("deepseek");
      const operation = first.configureProvider("test-actor", {
        idempotencyKey: "configure-deepseek-from-ui-001",
        expectedVersion: deepseek.version,
        provider: {
          id: "deepseek",
          displayName: "DeepSeek API",
          baseUrl: "https://api.deepseek.com/v1",
          credentialRef: "env:DEEPSEEK_API_KEY",
          keyless: false,
          protocol: "responses",
          requestProfile: "deepseek"
        },
        gateway: { callerTokenRef: "env:PLATFORM_TEST_CALLER" },
        initialModel: {
          id: "deepseek/reasoner",
          providerId: "deepseek",
          upstreamModel: "deepseek-reasoner",
          enabled: false,
          publication: "curated",
          capabilities: {
            input: ["text"], nativeImage: false, derivedImage: false, reasoningEfforts: [], defaultReasoningEffort: null,
            tools: false, forcedToolChoice: false, parallelTools: false, structuredOutput: false,
            standaloneSearch: false, compaction: false, collaboration: false
          },
          pricing: null
        }
      });
      expect(operation.state).toBe("completed");
      expect(first.inferenceConfig()).toMatchObject({
        callerTokenRef: "env:PLATFORM_TEST_CALLER",
        providers: [expect.objectContaining({ id: "deepseek", credentialRef: "env:DEEPSEEK_API_KEY" })],
        models: [expect.objectContaining({ id: "deepseek/reasoner", enabled: false })]
      });
      const persisted = JSON.stringify(localDatabase.connection.prepare("SELECT * FROM platform_settings WHERE key = ?").get("platform:user-configuration-overlay"));
      expect(persisted).toContain("env:DEEPSEEK_API_KEY");
      expect(persisted).not.toContain("provider-secret-canary");
      await first.close();
      const restarted = new PlatformService(localDatabase.connection, new Registry(localDatabase), undefined);
      try {
        expect(restarted.inferenceConfig()?.models).toEqual(expect.arrayContaining([
          expect.objectContaining({ id: "deepseek/reasoner", providerId: "deepseek" })
        ]));
      } finally {
        await restarted.close();
      }
    } finally {
      localDatabase.close();
    }
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

  it("sets an API key through a native credential operation without recording the key", async () => {
    delete process.env.DEEPSEEK_API_KEY;
    const provider = service.provider("deepseek");
    const operation = service.setProviderCredential("test-actor", provider.id, {
      idempotencyKey: "set-deepseek-key-001", expectedVersion: provider.version
    });
    const completed = await service.waitForOperation(operation.id, 2_000);
    expect(completed).toMatchObject({ kind: "credential-set", state: "completed" });
    expect(credentialStore.promptAndStore).toHaveBeenCalledWith("env:DEEPSEEK_API_KEY", "DeepSeek API", expect.any(AbortSignal));
    expect(service.provider("deepseek").authentication).toMatchObject({ state: "ready", source: "environment", reference: "env:DEEPSEEK_API_KEY" });
    const persisted = JSON.stringify({
      events: database.connection.prepare("SELECT * FROM platform_event_journal").all(),
      operations: database.connection.prepare("SELECT * FROM platform_operations").all()
    });
    expect(persisted).not.toContain("provider-secret-canary");
  });

  it("validates authentication through a durable scoped lock with monotonic fencing", async () => {
    const firstProvider = service.provider("deepseek");
    const first = service.validateProvider("test-actor", "deepseek", {
      idempotencyKey: "validate-deepseek-001",
      expectedVersion: firstProvider.version
    });
    expect((await service.waitForOperation(first.id, 2_000)).state).toBe("completed");
    const secondProvider = service.provider("deepseek");
    const second = service.validateProvider("test-actor", "deepseek", {
      idempotencyKey: "validate-deepseek-002",
      expectedVersion: secondProvider.version
    });
    expect((await service.waitForOperation(second.id, 2_000)).state).toBe("completed");
    const counter = database.connection.prepare("SELECT value_json FROM platform_settings WHERE key = ?")
      .get("lock-counter:credential:deepseek") as { value_json: string };
    expect(JSON.parse(counter.value_json)).toEqual({ token: 2 });
    expect(database.connection.prepare("SELECT * FROM platform_operation_locks").all()).toEqual([]);
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

  it("discovers, validates, selects, and explicitly removes a local model through durable operations", async () => {
    let removed = false;
    const server = createServer((request, response) => {
      response.setHeader("Content-Type", "application/json");
      if (request.url === "/api/version") return void response.end(JSON.stringify({ version: "fixture" }));
      if (request.url === "/api/tags") return void response.end(JSON.stringify({ models: [{ name: "qwen-fixture:latest", size: 42, digest: "sha256:fixture" }] }));
      if (request.url === "/api/show") return void response.end(JSON.stringify({ modified_at: "2026-08-13T00:00:00.000Z", capabilities: ["tools"], model_info: { fixture_context_length: 8192 } }));
      if (request.url === "/api/chat") return void response.end(JSON.stringify({ done: true, eval_count: 8, message: { tool_calls: [{ function: { name: "fixture" } }] } }));
      if (request.url === "/api/delete") { removed = true; return void response.end("{}"); }
      response.writeHead(404).end("{}");
    });
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("Missing local runtime fixture address");
    const localDatabase = new RouterDatabase(":memory:");
    const inference = inferenceConfigSchema.parse({
      callerTokenRef: "env:PLATFORM_TEST_CALLER",
      host: "127.0.0.1",
      port: 0,
      localModels: { baseUrl: `http://127.0.0.1:${address.port}` },
      providers: [{ id: "local", baseUrl: `http://127.0.0.1:${address.port}/v1`, keyless: true }],
      models: [{ id: "local/seed", providerId: "local", upstreamModel: "seed" }]
    });
    const localService = new PlatformService(localDatabase.connection, new Registry(localDatabase), inference);
    try {
      const discovery = localService.discoverLocalModels("test-actor", {
        idempotencyKey: "local-discovery-001",
        expectedVersion: localService.localRuntime().version
      });
      expect((await localService.waitForOperation(discovery.id, 2_000)).state).toBe("completed");
      expect(localService.localModel("qwen-fixture:latest")).toMatchObject({ state: "installed", definition: { contextWindow: 8192 } });

      let model = localService.localModel("qwen-fixture:latest");
      const benchmark = localService.benchmarkLocalModel("test-actor", model.id, {
        idempotencyKey: "local-benchmark-001",
        expectedVersion: model.version
      });
      expect((await localService.waitForOperation(benchmark.id, 2_000)).result).toMatchObject({ validated: true });
      model = localService.localModel(model.id);
      localService.setLocalModelSelected("test-actor", model.id, true, {
        idempotencyKey: "local-select-001",
        expectedVersion: model.version
      });
      expect(localService.localModel(model.id).selected).toBe(true);
      model = localService.localModel(model.id);
      localService.setLocalModelSelected("test-actor", model.id, false, {
        idempotencyKey: "local-unselect-001",
        expectedVersion: model.version
      });
      model = localService.localModel(model.id);
      const removal = localService.removeLocalModel("test-actor", model.id, {
        idempotencyKey: "local-remove-001",
        expectedVersion: model.version,
        consent: true
      });
      expect((await localService.waitForOperation(removal.id, 2_000)).state).toBe("completed");
      expect(removed).toBe(true);
      expect(() => localService.localModel(model.id)).toThrow(/not found/);
    } finally {
      await localService.close();
      localDatabase.close();
      server.close();
      await once(server, "close");
    }
  });

  it("serializes installation writers with monotonic fencing and releases the scope", async () => {
    const sandbox = await mkdtemp(path.join(os.tmpdir(), "codex-router-platform-lock-"));
    const releaseSource = path.join(sandbox, "release");
    const configPath = path.join(sandbox, "config.json");
    await mkdir(releaseSource, { recursive: true });
    await writeFile(path.join(releaseSource, "codex-router"), "#!/bin/sh\nexit 0\n", { mode: 0o700 });
    await writeFile(configPath, "{}\n", { mode: 0o600 });
    const target = { root: path.join(sandbox, "managed"), version: "1.0.0", releaseSource, entrypoint: "codex-router", configPath, host: "linux" as const };
    try {
      const first = service.planInstallation("test-actor", target, {
        idempotencyKey: "install-plan-lock-001",
        expectedVersion: 1
      });
      expect(() => service.planInstallation("test-actor", target, {
        idempotencyKey: "install-plan-lock-002",
        expectedVersion: 1
      })).toThrow(/active writer/);
      expect((await service.waitForOperation(first.id, 15_000)).state).toBe("completed");
      const second = service.planInstallation("test-actor", target, {
        idempotencyKey: "install-plan-lock-003",
        expectedVersion: 1
      });
      expect((await service.waitForOperation(second.id, 15_000)).state).toBe("completed");
      const counter = database.connection.prepare("SELECT value_json FROM platform_settings WHERE key = ?")
        .get("lock-counter:installation:current") as { value_json: string };
      expect(JSON.parse(counter.value_json)).toEqual({ token: 2 });
      expect(database.connection.prepare("SELECT * FROM platform_operation_locks WHERE scope = ?").all("installation:current")).toEqual([]);
    } finally {
      await rm(sandbox, { recursive: true, force: true });
    }
  });

  it("applies, updates, rolls back, disables, and uninstalls with event-before-projection readback", async () => {
    const sandbox = await mkdtemp(path.join(os.tmpdir(), "codex-router-platform-install-"));
    const releaseSource = path.join(sandbox, "release");
    const configPath = path.join(sandbox, "config.json");
    const manifestFile = path.join(sandbox, "managed", "install-manifest.json");
    await mkdir(releaseSource, { recursive: true });
    await writeFile(path.join(releaseSource, "codex-router"), "#!/bin/sh\nexit 0\n", { mode: 0o700 });
    await writeFile(configPath, "{}\n", { mode: 0o600 });
    const target = { root: path.join(sandbox, "managed"), version: "1.0.0", releaseSource, entrypoint: "codex-router", configPath, host: "linux" as const };
    try {
      const install = service.applyInstallation("test-actor", target, {
        idempotencyKey: "install-apply-service-001",
        expectedVersion: 1,
        consent: true
      });
      expect((await service.waitForOperation(install.id, 15_000)).state).toBe("completed");
      expect(service.installState()).toMatchObject({ version: 1, manifest: { releaseVersion: "1.0.0", state: "active" } });
      const installEvents = database.connection.prepare(
        "SELECT event_type FROM platform_event_journal WHERE operation_id = ? ORDER BY sequence"
      ).all(install.id) as Array<{ event_type: string }>;
      expect(installEvents.map((entry) => entry.event_type)).toEqual([
        "platform_operation_started", "install_state_observed", "platform_operation_completed"
      ]);

      await writeFile(path.join(releaseSource, "codex-router"), "#!/bin/sh\nexit 1\n", { mode: 0o700 });
      const update = service.applyInstallation("test-actor", { ...target, version: "1.1.0" }, {
        idempotencyKey: "install-update-service-001",
        expectedVersion: service.installState()!.version,
        consent: true
      });
      expect((await service.waitForOperation(update.id, 15_000)).state).toBe("completed");
      expect(service.installState()).toMatchObject({ version: 2, manifest: { releaseVersion: "1.1.0" } });

      const rollback = service.rollbackInstallation("test-actor", manifestFile, {
        idempotencyKey: "install-rollback-service-001",
        expectedVersion: service.installState()!.version,
        consent: true
      });
      expect((await service.waitForOperation(rollback.id, 15_000)).state).toBe("completed");
      expect(service.installState()).toMatchObject({ version: 3, manifest: { releaseVersion: "1.0.0", state: "active" } });

      const disable = service.disableInstallation("test-actor", manifestFile, {
        idempotencyKey: "install-disable-service-001",
        expectedVersion: service.installState()!.version,
        consent: true
      });
      expect((await service.waitForOperation(disable.id, 15_000)).state).toBe("completed");
      expect(service.installState()).toMatchObject({ version: 4, manifest: { state: "disabled" } });

      const uninstall = service.uninstallInstallation("test-actor", manifestFile, {
        idempotencyKey: "install-uninstall-service-001",
        expectedVersion: service.installState()!.version,
        consent: true,
        removeRetainedReleases: true
      });
      expect((await service.waitForOperation(uninstall.id, 15_000)).state).toBe("completed");
      expect(service.installState()).toBeNull();
    } finally {
      await rm(sandbox, { recursive: true, force: true });
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
