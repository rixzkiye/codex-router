import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { gzipSync } from "node:zlib";
import { once } from "node:events";
import { afterEach, describe, expect, it } from "vitest";
import { inferenceConfigSchema, type InferenceConfig } from "../src/config.js";
import { startInferenceGateway, type InferenceGateway } from "../src/inference/server.js";
import { PlatformService } from "../src/platform/service.js";
import { SecretRedactor, type Logger } from "../src/security.js";
import { RouterDatabase } from "../src/store/database.js";
import { Registry } from "../src/store/registry.js";

const CALLER_TOKEN_ENV = "CODEX_ROUTER_TEST_INFERENCE_CALLER";
const PROVIDER_KEY_ENV = "CODEX_ROUTER_TEST_INFERENCE_PROVIDER";
const TRANSLATION_KEY_ENV = "CODEX_ROUTER_TEST_TRANSLATION";
const callerToken = "caller-token-that-is-long-enough";
const providerKey = "provider-key-that-must-not-leak";

const closers: Array<() => Promise<void>> = [];

afterEach(async () => {
  while (closers.length) await closers.pop()!();
  delete process.env[CALLER_TOKEN_ENV];
  delete process.env[PROVIDER_KEY_ENV];
  delete process.env[TRANSLATION_KEY_ENV];
});

describe("model inference gateway", () => {
  it("authenticates before routing and exposes only an authenticated model catalog", async () => {
    const upstream = await startUpstream((_request, response) => {
      response.writeHead(500).end();
    });
    const { gateway } = await startHarness(upstream.url);

    const health = await fetch(`${gateway.url}/health`);
    expect(health.status).toBe(200);
    expect(await health.json()).toEqual({ status: "ok", providers: 1, models: 1 });

    const anonymousModels = await fetch(`${gateway.url}/v1/models`);
    expect(anonymousModels.status).toBe(401);

    const models = await fetch(`${gateway.url}/v1/models`, { headers: authHeaders() });
    expect(models.status).toBe(200);
    expect(await models.json()).toEqual({
      object: "list",
      data: [{ id: "public/model", object: "model", created: 0, owned_by: "fixture" }]
    });
    expect(upstream.requests).toHaveLength(0);
  });

  it("uses durable provider and model eligibility for catalog and dispatch", async () => {
    const upstream = await startUpstream((_request, response) => {
      response.writeHead(200, { "Content-Type": "application/json" });
      response.end(JSON.stringify({ status: "completed", output: [{ type: "message", content: [{ type: "output_text", text: "ok" }] }] }));
    });
    process.env[CALLER_TOKEN_ENV] = callerToken;
    process.env[PROVIDER_KEY_ENV] = providerKey;
    const config = inferenceConfigSchema.parse(inferenceConfig(upstream.url));
    const database = new RouterDatabase(":memory:");
    const platform = new PlatformService(database.connection, new Registry(database), config);
    const gateway = await startInferenceGateway(config, new SecretRedactor(), new CapturingLogger(), { port: 0, platform });
    closers.push(async () => {
      await gateway.close();
      await platform.close();
      database.close();
    });

    const provider = platform.provider("fixture");
    platform.setProviderEnabled("test", provider.id, false, {
      idempotencyKey: "disable-provider-route",
      expectedVersion: provider.version
    });
    expect(await gatewayModels(gateway)).toEqual([]);
    const disabledProvider = await post(gateway, { model: "public/model", input: "blocked" });
    expect(disabledProvider.status).toBe(409);
    expect(await disabledProvider.json()).toMatchObject({ error: { code: "provider_not_enabled" } });

    const nextProvider = platform.provider("fixture");
    platform.setProviderEnabled("test", nextProvider.id, true, {
      idempotencyKey: "enable-provider-route",
      expectedVersion: nextProvider.version
    });
    const model = platform.model("public/model");
    platform.setModelEnabled("test", model.gatewayId, false, {
      idempotencyKey: "disable-model-route",
      expectedVersion: model.version
    });
    expect(await gatewayModels(gateway)).toEqual([]);
    const disabledModel = await post(gateway, { model: "public/model", input: "blocked" });
    expect(disabledModel.status).toBe(409);
    expect(await disabledModel.json()).toMatchObject({ error: { code: "model_not_enabled" } });
    expect(upstream.requests).toHaveLength(0);
  });

  it("rewrites the configured model, isolates credentials, and streams the response", async () => {
    const upstream = await startUpstream(async (request, response) => {
      const body = await readJson(request);
      response.writeHead(200, { "Content-Type": "text/event-stream", "X-Request-Id": "upstream-request" });
      response.write(`event: response.output_text.delta\ndata: {"delta":"hel"}\n\n`);
      setTimeout(() => response.end(`event: response.completed\ndata: {"response":{"status":"completed"}}\n\n`), 5);
      expect(body).toEqual({ model: "upstream-model", input: "hello", stream: true });
    });
    const { gateway } = await startHarness(upstream.url);

    const response = await fetch(`${gateway.url}/v1/responses`, {
      method: "POST",
      headers: {
        ...authHeaders(),
        "Content-Type": "application/json",
        "X-Codex-Leak": "must-not-forward"
      },
      body: JSON.stringify({
        model: "public/model",
        input: "hello",
        stream: true,
        client_metadata: { thread_id: "private" }
      })
    });

    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toContain("text/event-stream");
    expect(response.headers.get("x-request-id")).toBe("upstream-request");
    expect(response.headers.get("x-codex-router-request-id")).toMatch(/^inference_/);
    expect(await response.text()).toContain("response.completed");
    expect(upstream.requests).toHaveLength(1);
    expect(upstream.requests[0]!.url).toBe("/v1/responses");
    expect(upstream.requests[0]!.headers.authorization).toBe(`Bearer ${providerKey}`);
    expect(upstream.requests[0]!.headers["x-codex-leak"]).toBeUndefined();
  });

  it("routes Responses compaction without translating its contract", async () => {
    const upstream = await startUpstream(async (request, response) => {
      const body = await readJson(request);
      response.writeHead(200, { "Content-Type": "application/json" });
      response.end(JSON.stringify({ object: "response.compaction", model: (body as { model: string }).model }));
    });
    const { gateway } = await startHarness(upstream.url);

    const response = await fetch(`${gateway.url}/v1/responses/compact`, {
      method: "POST",
      headers: { ...authHeaders(), "Content-Type": "application/json" },
      body: JSON.stringify({ model: "public/model", input: [{ role: "user", content: "compact me" }] })
    });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ object: "response.compaction", model: "upstream-model" });
    expect(upstream.requests[0]!.url).toBe("/v1/responses/compact");
  });

  it("fails closed for unknown models, oversized bodies, browser traffic, and upstream errors", async () => {
    const upstream = await startUpstream(async (_request, response) => {
      response.writeHead(401, { "Content-Type": "application/json" });
      response.end(JSON.stringify({ error: `bad ${providerKey}` }));
    });
    const logger = new CapturingLogger();
    const { gateway } = await startHarness(upstream.url, logger, { maxBodyBytes: 64 });

    const unknown = await post(gateway, { model: "missing", input: "hello" });
    expect(unknown.status).toBe(400);
    expect(upstream.requests).toHaveLength(0);

    const browser = await fetch(`${gateway.url}/v1/responses`, {
      method: "POST",
      headers: { ...authHeaders(), "Content-Type": "application/json", Origin: "https://example.test" },
      body: JSON.stringify({ model: "public/model", input: "hello" })
    });
    expect(browser.status).toBe(403);
    expect(upstream.requests).toHaveLength(0);

    const oversized = await post(gateway, { model: "public/model", input: "x".repeat(100) });
    expect(oversized.status).toBe(413);
    expect(upstream.requests).toHaveLength(0);

    const rejected = await post(gateway, { model: "public/model", input: "hello" });
    expect(rejected.status).toBe(401);
    const rejectionText = await rejected.text();
    const rejection = JSON.parse(rejectionText) as { error: { request_id: string; code: string } };
    expect(rejection.error.code).toBe("provider_error");
    expect(rejected.headers.get("x-codex-router-request-id")).toBe(rejection.error.request_id);
    expect(rejectionText).not.toContain(providerKey);
    expect(JSON.stringify(logger.entries)).not.toContain(providerKey);
    expect(upstream.requests).toHaveLength(1);
  });

  it("never replays a request when a streamed caller disconnects", async () => {
    let upstreamClosed = false;
    const upstream = await startUpstream((_request, response) => {
      response.writeHead(200, { "Content-Type": "text/event-stream" });
      response.write(`event: response.output_text.delta\ndata: {"delta":"first"}\n\n`);
      response.once("close", () => {
        upstreamClosed = true;
      });
    });
    const { gateway } = await startHarness(upstream.url);
    const controller = new AbortController();
    const response = await fetch(`${gateway.url}/v1/responses`, {
      method: "POST",
      headers: { ...authHeaders(), "Content-Type": "application/json" },
      body: JSON.stringify({ model: "public/model", input: "hello", stream: true }),
      signal: controller.signal
    });
    const reader = response.body!.getReader();
    expect(new TextDecoder().decode((await reader.read()).value)).toContain("first");
    controller.abort();
    await reader.cancel().catch(() => undefined);
    await waitFor(() => upstreamClosed);
    expect(upstream.requests).toHaveLength(1);
  });

  it("rejects an empty terminal SSE completion before committing response bytes", async () => {
    const upstream = await startUpstream((_request, response) => {
      response.writeHead(200, { "Content-Type": "text/event-stream" });
      response.end(`event: response.completed\ndata: {"response":{"status":"completed","output":[]}}\n\n`);
    });
    const { gateway } = await startHarness(upstream.url);
    const response = await post(gateway, { model: "public/model", input: "hello", stream: true });
    expect(response.status).toBe(502);
    expect(await response.text()).toContain("empty_completion");
    expect(upstream.requests).toHaveLength(1);
  });

  it("uses an independent internal capability for LiteLLM translation", async () => {
    const translationCapability = "translation-capability-with-at-least-thirty-two-bytes";
    process.env[TRANSLATION_KEY_ENV] = translationCapability;
    const translator = await startUpstream(async (request, response) => {
      const body = await readJson(request);
      expect(body).toMatchObject({ model: "public/model", input: "translate" });
      response.writeHead(200, { "Content-Type": "application/json" });
      response.end(JSON.stringify({ status: "completed", output: [{ type: "message", content: [{ type: "output_text", text: "ok" }] }] }));
    });
    const { gateway } = await startHarness("https://provider.example.invalid/v1", new CapturingLogger(), {
      translation: {
        baseUrl: translator.url,
        capabilityRef: `env:${TRANSLATION_KEY_ENV}`,
        healthPath: "/health/liveliness",
        requestTimeoutMs: 5_000
      },
      providers: [{
        id: "fixture",
        baseUrl: "https://provider.example.invalid/v1",
        credentialRef: `env:${PROVIDER_KEY_ENV}`,
        keyless: false,
        protocol: "chat-completions",
        requestProfile: "generic-openai"
      }]
    });
    const response = await post(gateway, { model: "public/model", input: "translate" });
    expect(response.status).toBe(200);
    expect(translator.requests[0]!.headers.authorization).toBe(`Bearer ${translationCapability}`);
    expect(translator.requests[0]!.headers.authorization).not.toContain(providerKey);
    expect(translator.requests[0]!.headers["x-codex-router-provider"]).toBe("fixture");
  });

  it("does not follow provider redirects with the selected credential", async () => {
    const redirectTarget = await startUpstream((_request, response) => {
      response.writeHead(200, { "Content-Type": "application/json" }).end("{}");
    });
    const upstream = await startUpstream((_request, response) => {
      response.writeHead(307, { Location: `${redirectTarget.url}/responses` }).end();
    });
    const { gateway } = await startHarness(upstream.url);

    const response = await post(gateway, { model: "public/model", input: "hello" });
    expect(response.status).toBe(502);
    expect(await response.text()).toContain("upstream_redirect");
    expect(upstream.requests).toHaveLength(1);
    expect(redirectTarget.requests).toHaveLength(0);
  });

  it("validates provider transport, keyless scope, registry uniqueness, and references", () => {
    const base = inferenceConfig("https://api.example.test/v1");
    expect(() =>
      inferenceConfigSchema.parse({
        ...base,
        providers: [{ id: "fixture", baseUrl: "http://api.example.test/v1", credentialRef: `env:${PROVIDER_KEY_ENV}` }]
      })
    ).toThrow(/HTTPS/);
    expect(() =>
      inferenceConfigSchema.parse({
        ...base,
        providers: [{ id: "fixture", baseUrl: "https://api.example.test/v1", keyless: true }]
      })
    ).toThrow(/loopback/);
    expect(() =>
      inferenceConfigSchema.parse({
        ...base,
        providers: [
          {
            id: "fixture",
            baseUrl: "https://user:password@api.example.test/v1?token=secret",
            credentialRef: `env:${PROVIDER_KEY_ENV}`
          }
        ]
      })
    ).toThrow(/cannot contain credentials|query strings/);
    expect(() =>
      inferenceConfigSchema.parse({
        ...base,
        models: [
          { id: "duplicate", providerId: "fixture", upstreamModel: "a" },
          { id: "duplicate", providerId: "missing", upstreamModel: "b" }
        ]
      })
    ).toThrow(/Duplicate inference model ID|Unknown inference provider/);
  });

  it("refuses a weak caller token before opening a listener", async () => {
    process.env[CALLER_TOKEN_ENV] = "short";
    process.env[PROVIDER_KEY_ENV] = providerKey;
    const config = inferenceConfigSchema.parse(inferenceConfig("https://api.example.test/v1"));
    await expect(startInferenceGateway(config, new SecretRedactor(), new CapturingLogger(), { port: 0 })).rejects.toThrow(
      /at least 32 bytes/
    );
  });

  it("decodes bounded gzip bodies only after caller authentication", async () => {
    const upstream = await startUpstream(async (request, response) => {
      const chunks: Buffer[] = [];
      for await (const chunk of request) chunks.push(Buffer.from(chunk));
      expect(JSON.parse(Buffer.concat(chunks).toString("utf8"))).toMatchObject({ model: "upstream-model", input: "compressed" });
      response.writeHead(200, { "Content-Type": "application/json" });
      response.end(JSON.stringify({ status: "completed", output: [{ type: "message", content: [{ type: "output_text", text: "ok" }] }] }));
    });
    const { gateway } = await startHarness(upstream.url);
    const body = gzipSync(JSON.stringify({ model: "public/model", input: "compressed" }));
    const response = await fetch(`${gateway.url}/v1/responses`, {
      method: "POST",
      headers: { ...authHeaders(), "Content-Type": "application/json", "Content-Encoding": "gzip" },
      body
    });
    expect(response.status).toBe(200);
  });
});

async function startHarness(
  upstreamUrl: string,
  logger: Logger = new CapturingLogger(),
  override: Partial<InferenceConfig> = {}
) {
  process.env[CALLER_TOKEN_ENV] = callerToken;
  process.env[PROVIDER_KEY_ENV] = providerKey;
  const config = inferenceConfigSchema.parse({ ...inferenceConfig(upstreamUrl), ...override });
  const gateway = await startInferenceGateway(config, new SecretRedactor(), logger, { port: 0 });
  closers.push(() => gateway.close());
  return { gateway };
}

function inferenceConfig(baseUrl: string) {
  return {
    callerTokenRef: `env:${CALLER_TOKEN_ENV}`,
    host: "127.0.0.1" as const,
    port: 0,
    maxBodyBytes: 1024,
    requestTimeoutMs: 5_000,
    providers: [{ id: "fixture", baseUrl, credentialRef: `env:${PROVIDER_KEY_ENV}` }],
    models: [{ id: "public/model", providerId: "fixture", upstreamModel: "upstream-model" }]
  };
}

async function post(gateway: InferenceGateway, body: unknown) {
  return fetch(`${gateway.url}/v1/responses`, {
    method: "POST",
    headers: { ...authHeaders(), "Content-Type": "application/json" },
    body: JSON.stringify(body)
  });
}

function authHeaders() {
  return { Authorization: `Bearer ${callerToken}` };
}

async function gatewayModels(gateway: InferenceGateway) {
  const response = await fetch(`${gateway.url}/v1/models`, { headers: authHeaders() });
  expect(response.status).toBe(200);
  return (await response.json() as { data: unknown[] }).data;
}

interface UpstreamHarness {
  url: string;
  requests: Array<{ url: string; headers: IncomingMessage["headers"] }>;
}

async function startUpstream(
  handler: (request: IncomingMessage, response: ServerResponse) => void | Promise<void>
): Promise<UpstreamHarness> {
  const requests: UpstreamHarness["requests"] = [];
  const server = createServer((request, response) => {
    requests.push({ url: request.url ?? "", headers: request.headers });
    void Promise.resolve(handler(request, response));
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Fixture server has no address");
  closers.push(async () => {
    server.closeAllConnections();
    server.close();
    await once(server, "close");
  });
  return { url: `http://127.0.0.1:${address.port}/v1`, requests };
}

async function readJson(request: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  for await (const chunk of request) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}

async function waitFor(predicate: () => boolean): Promise<void> {
  const deadline = Date.now() + 2_000;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error("Timed out waiting for fixture state");
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

class CapturingLogger implements Logger {
  readonly entries: unknown[] = [];
  info(fields: Record<string, unknown>, message: string): void {
    this.entries.push({ level: "info", fields, message });
  }
  warn(fields: Record<string, unknown>, message: string): void {
    this.entries.push({ level: "warn", fields, message });
  }
  error(fields: Record<string, unknown>, message: string): void {
    this.entries.push({ level: "error", fields, message });
  }
}
