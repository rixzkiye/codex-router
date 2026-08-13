import { chmod, mkdir, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { loginLaunch, observeAuthentication } from "../src/platform/auth.js";
import type { ProviderDefinition } from "../src/platform/types.js";

describe("platform authentication observations", () => {
  it("resolves only declared symbolic environment references", async () => {
    const result = await observeAuthentication(provider("deepseek", "environment", ["env:DEEPSEEK_API_KEY"]), {
      DEEPSEEK_API_KEY: "canary-secret"
    });
    expect(result).toMatchObject({ state: "ready", source: "environment", reference: "env:DEEPSEEK_API_KEY" });
    expect(JSON.stringify(result)).not.toContain("canary-secret");
  });

  it("reads Kimi session metadata without returning OAuth material", async () => {
    const root = await tempDirectory();
    const credentials = path.join(root, "credentials");
    await mkdir(credentials, { recursive: true, mode: 0o700 });
    await writeFile(path.join(credentials, "kimi-code.json"), JSON.stringify({
      access_token: "access-canary",
      refresh_token: "refresh-canary",
      expires_at: Math.floor(Date.now() / 1000) + 600,
      expires_in: 600
    }), { mode: 0o600 });
    await chmod(path.join(credentials, "kimi-code.json"), 0o600);
    const result = await observeAuthentication(provider("kimi-oauth", "oauth-cli", []), { KIMI_CODE_HOME: root });
    expect(result.state).toBe("ready");
    expect(JSON.stringify(result)).not.toMatch(/access-canary|refresh-canary/);
  });

  it("refuses broadly readable official session files", async () => {
    if (process.platform === "win32") return;
    const root = await tempDirectory();
    const credentials = path.join(root, "credentials");
    await mkdir(credentials, { recursive: true, mode: 0o700 });
    const file = path.join(credentials, "kimi-code.json");
    await writeFile(file, JSON.stringify({ access_token: "a", refresh_token: "r" }), { mode: 0o644 });
    await chmod(file, 0o644);
    expect((await observeAuthentication(provider("kimi-oauth", "oauth-cli", []), { KIMI_CODE_HOME: root })).state).toBe("unavailable");
  });

  it("uses official CLI login commands and never puts a credential in arguments", () => {
    expect(loginLaunch("native-codex")).toMatchObject({ executable: "codex", args: ["login", "--device-auth"], requiresTerminal: true });
    expect(loginLaunch("grok-oauth")).toMatchObject({ executable: "grok", args: ["login", "--oauth"] });
  });
});

function provider(id: string, mechanism: ProviderDefinition["credential"]["mechanism"], references: string[]): ProviderDefinition {
  return {
    id,
    displayName: id,
    owner: id,
    canonicalProvider: id,
    kind: mechanism === "oauth-cli" ? "oauth-forwarder" : "openai-compatible",
    protocol: "responses",
    baseUrl: "https://example.test",
    credential: { mechanism, references, interactiveTerminal: mechanism === "oauth-cli" },
    requestProfile: "generic-openai",
    discovery: "provider-api",
    usageAuthority: "rate-limit-headers",
    localOnly: false,
    publication: "catalog-only"
  };
}

async function tempDirectory(): Promise<string> {
  return await import("node:fs/promises").then(({ mkdtemp }) => mkdtemp(path.join(os.tmpdir(), "codex-router-auth-")));
}
