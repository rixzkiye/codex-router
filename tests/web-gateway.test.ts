import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { RouterApplicationService } from "../src/application.js";
import { CodexRouter } from "../src/router.js";
import { startWebGateway, type WebGateway } from "../src/web/server.js";
import { createGitWorktree, dependencies, MockRuntimeAdapter, testConfig } from "./helpers.js";

const closers: Array<() => Promise<void>> = [];

afterEach(async () => {
  await Promise.allSettled(closers.splice(0).map((close) => close()));
});

describe("Web Console gateway", () => {
  it("exchanges one local bootstrap token, enforces Origin and CSRF, and delegates lifecycle start", async () => {
    const harness = await createHarness();
    const unauthenticated = await fetch(`${harness.gateway.url}/api/v1/bootstrap`);
    expect(unauthenticated.status).toBe(403);

    const sessionResponse = await fetch(`${harness.gateway.url}/api/v1/session`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Origin: harness.gateway.url },
      body: JSON.stringify({ bootstrapToken: "gateway-test-token" })
    });
    expect(sessionResponse.status).toBe(200);
    const cookie = sessionResponse.headers.get("set-cookie")?.split(";", 1)[0];
    const session = await sessionResponse.json() as { csrfToken: string };
    expect(cookie).toContain("codex_router_session=");
    expect(session.csrfToken).toMatch(/^[A-Za-z0-9_-]+$/);

    const replay = await fetch(`${harness.gateway.url}/api/v1/session`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Origin: harness.gateway.url },
      body: JSON.stringify({ bootstrapToken: "gateway-test-token" })
    });
    expect(replay.status).toBe(403);

    const noCsrf = await fetch(`${harness.gateway.url}/api/v1/agents`, {
      method: "POST",
      headers: { Cookie: cookie!, "Content-Type": "application/json", Origin: harness.gateway.url },
      body: JSON.stringify({})
    });
    expect(noCsrf.status).toBe(403);

    const invalid = await fetch(`${harness.gateway.url}/api/v1/agents`, {
      method: "POST",
      headers: {
        Cookie: cookie!,
        "Content-Type": "application/json",
        Origin: harness.gateway.url,
        "X-CSRF-Token": session.csrfToken
      },
      body: JSON.stringify({ task: "missing required fields" })
    });
    expect(invalid.status).toBe(422);
    expect(await invalid.json()).toMatchObject({ error: { code: "invalid_request" } });

    const start = await fetch(`${harness.gateway.url}/api/v1/agents`, {
      method: "POST",
      headers: {
        Cookie: cookie!,
        "Content-Type": "application/json",
        Origin: harness.gateway.url,
        "X-CSRF-Token": session.csrfToken
      },
      body: JSON.stringify({
        idempotencyKey: "web-start-1",
        task: "Inspect the Web Console contract",
        projectKey: "fixture",
        worktree: { path: harness.worktree, mode: "read_only" },
        routing: { capabilityTier: "worker", model: "gpt-test" },
        recoveryPolicy: "manual",
        labels: {}
      })
    });
    expect(start.status).toBe(202);
    const started = await start.json() as { agentId: string; status: string };
    expect(started).toMatchObject({ status: "running" });
    expect(harness.runtime.starts).toHaveLength(1);

    const detail = await fetch(`${harness.gateway.url}/api/v1/agents/${started.agentId}`, {
      headers: { Cookie: cookie! }
    });
    expect(detail.status).toBe(200);
    expect(await detail.json()).toMatchObject({ id: started.agentId, taskSummary: "Inspect the Web Console contract" });

    const logout = await fetch(`${harness.gateway.url}/api/v1/session`, {
      method: "DELETE",
      headers: { Cookie: cookie!, Origin: harness.gateway.url, "X-CSRF-Token": session.csrfToken }
    });
    expect(logout.status).toBe(200);
    const afterLogout = await fetch(`${harness.gateway.url}/api/v1/bootstrap`, { headers: { Cookie: cookie! } });
    expect(afterLogout.status).toBe(403);
  });

  it("serves a strict same-origin shell and emits resumable redacted snapshots", async () => {
    const harness = await createHarness();
    const shell = await fetch(harness.gateway.url);
    expect(shell.status).toBe(200);
    expect(shell.headers.get("content-security-policy")).toContain("default-src 'self'");
    expect(shell.headers.get("x-frame-options")).toBe("DENY");
    expect(await shell.text()).toContain("fixture console");

    const { cookie } = await authenticate(harness.gateway);
    const bootstrap = await fetch(`${harness.gateway.url}/api/v1/bootstrap`, { headers: { Cookie: cookie } });
    const snapshot = await bootstrap.json() as {
      csrfToken: string;
      router: { registryVersion: number };
      runtimes: unknown[];
      platform: { providers: Array<{ credential?: unknown; authBoundary: { mechanism: string; references: string[] } }> };
    };
    expect(bootstrap.headers.get("cache-control")).toBe("no-store");
    expect(snapshot.runtimes).toHaveLength(1);
    expect(snapshot.platform.providers[0]?.credential).toBeUndefined();
    expect(snapshot.platform.providers[0]?.authBoundary).toMatchObject({
      mechanism: expect.any(String),
      references: expect.any(Array)
    });
    expect(JSON.stringify(snapshot.platform.providers)).not.toContain("[REDACTED]");

    const controller = new AbortController();
    const stream = await fetch(`${harness.gateway.url}/api/v1/stream?afterVersion=0`, {
      headers: { Cookie: cookie },
      signal: controller.signal
    });
    expect(stream.status).toBe(200);
    expect(stream.headers.get("content-type")).toContain("text/event-stream");
    const reader = stream.body!.getReader();
    const chunk = await reader.read();
    const text = new TextDecoder().decode(chunk.value);
    expect(text).toContain("event: snapshot");
    expect(text).toContain("registryVersion");
    expect(text).not.toMatch(/sk-[A-Za-z0-9_-]{12,}/);
    controller.abort();
    await reader.cancel().catch(() => undefined);
  });
});

async function createHarness() {
  const { root, worktree } = await createGitWorktree();
  const runtime = new MockRuntimeAdapter("runtime-a");
  const deps = dependencies([runtime]);
  const router = await CodexRouter.create(testConfig(root), deps);
  const assets = await mkdtemp(path.join(tmpdir(), "codex-router-web-"));
  await mkdir(assets, { recursive: true });
  await writeFile(path.join(assets, "index.html"), "<!doctype html><title>fixture console</title>", "utf8");
  const application = new RouterApplicationService(router, deps.redactor);
  const gateway = await startWebGateway(application, deps.redactor, deps.logger, {
    assetRoot: assets,
    bootstrapToken: "gateway-test-token",
    port: 0
  });
  closers.push(async () => {
    await gateway.close();
    await router.close();
  });
  return { root, worktree, runtime, gateway };
}

async function authenticate(gateway: WebGateway): Promise<{ cookie: string; csrfToken: string }> {
  const response = await fetch(`${gateway.url}/api/v1/session`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Origin: gateway.url },
    body: JSON.stringify({ bootstrapToken: gateway.bootstrapToken })
  });
  const cookie = response.headers.get("set-cookie")!.split(";", 1)[0]!;
  const body = await response.json() as { csrfToken: string };
  return { cookie, csrfToken: body.csrfToken };
}
