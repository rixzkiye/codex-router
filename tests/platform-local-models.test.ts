import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import { OllamaClient } from "../src/platform/local-models.js";

const closers: Array<() => Promise<void>> = [];

afterEach(async () => {
  await Promise.all(closers.splice(0).map((close) => close()));
});

describe("local model lifecycle", () => {
  it("discovers, inspects, pulls, benchmarks, and removes through loopback only", async () => {
    const requests: Array<{ url: string; method: string; body: unknown }> = [];
    const server = createServer(async (request, response) => {
      let raw = "";
      for await (const chunk of request) raw += chunk.toString();
      requests.push({ url: request.url ?? "", method: request.method ?? "", body: raw ? JSON.parse(raw) : null });
      response.setHeader("content-type", request.url === "/api/pull" ? "application/x-ndjson" : "application/json");
      if (request.url === "/api/version") response.end(JSON.stringify({ version: "1" }));
      else if (request.url === "/api/tags") response.end(JSON.stringify({ models: [{ name: "qwen:test", size: 12, digest: "sha", modified_at: "now", details: { family: "qwen" } }] }));
      else if (request.url === "/api/show") response.end(JSON.stringify({ capabilities: ["tools"], model_info: { "qwen.context_length": 32_768 }, details: { family: "qwen" } }));
      else if (request.url === "/api/pull") response.end('{"status":"pulling","completed":5,"total":10}\n{"status":"success","completed":10,"total":10}\n');
      else if (request.url === "/api/chat") response.end(JSON.stringify({ done: true, eval_count: 20, message: { content: "ready", tool_calls: [{ function: { name: "fixture" } }] } }));
      else if (request.url === "/api/delete") response.end(JSON.stringify({ status: "success" }));
      else { response.statusCode = 404; response.end("{}"); }
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    closers.push(() => new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve())));
    const port = (server.address() as AddressInfo).port;
    const client = new OllamaClient(`http://127.0.0.1:${port}`);
    expect(await client.health()).toBe(true);
    expect(await client.list()).toHaveLength(1);
    expect((await client.inspect("qwen:test")).contextWindow).toBe(32_768);
    const progress: number[] = [];
    await client.pull("qwen:test", { consent: true, onProgress: (event) => { if (event.fraction !== null) progress.push(event.fraction); } });
    expect(progress).toEqual([0.5, 1]);
    expect((await client.benchmark("qwen:test")).toolCallObserved).toBe(true);
    await client.remove("qwen:test", { consent: true });
    expect(requests.map((entry) => entry.url)).toEqual(["/api/version", "/api/tags", "/api/show", "/api/pull", "/api/show", "/api/chat", "/api/delete"]);
  });

  it("requires consent for material local changes and rejects remote keyless hosts", async () => {
    expect(() => new OllamaClient("https://example.com")).toThrow(/loopback/);
    const client = new OllamaClient();
    await expect(client.pull("large", { consent: false })).rejects.toThrow(/consent/);
    await expect(client.remove("large", { consent: false })).rejects.toThrow(/consent/);
  });
});
