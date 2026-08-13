import { mkdtemp, readFile, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import type { GeneratedPlatformArtifacts } from "../src/platform/artifacts.js";
import { installGeneratedArtifacts, writeSupportBundle } from "../src/platform/files.js";

const artifacts: GeneratedPlatformArtifacts = {
  manifest: {
    version: 1,
    generatedAt: "2026-08-13T00:00:00.000Z",
    registryHash: "registry-hash",
    routesHash: "routes-hash",
    litellmHash: "litellm-hash"
  },
  litellmConfig: "model_list: []\nrouter_settings:\n  num_retries: 0\n",
  routes: []
};

describe("platform-owned files", () => {
  it("writes and independently reads back an owned generation manifest", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "codex-router-artifacts-"));
    const result = await installGeneratedArtifacts(root, artifacts);
    expect(result.manifest).toMatchObject({ owner: "codex-router-platform", generated: { registryHash: "registry-hash" } });
    expect(await readFile(path.join(root, "litellm.yaml"), "utf8")).toContain("num_retries: 0");
    expect((await stat(path.join(root, "manifest.json"))).mode & 0o077).toBe(0);
  });

  it("refuses to replace a foreign artifact root", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "codex-router-foreign-"));
    await writeFile(path.join(root, "manifest.json"), JSON.stringify({ owner: "another-router" }));
    await expect(installGeneratedArtifacts(root, artifacts)).rejects.toThrow(/belongs to another installation/);
  });

  it("refuses to overwrite unmanaged artifact paths without an ownership manifest", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "codex-router-unmanaged-"));
    await writeFile(path.join(root, "litellm.yaml"), "owned by another process\n");
    await expect(installGeneratedArtifacts(root, artifacts)).rejects.toThrow(/not owned by Codex Router/);
    expect(await readFile(path.join(root, "litellm.yaml"), "utf8")).toBe("owned by another process\n");
  });

  it("creates a local-only support bundle without references, capabilities, or secret values", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "codex-router-support-"));
    const target = path.join(root, "support.json");
    await writeSupportBundle(target, {
      router: { version: "0.2.0" },
      platform: {
        registry: { hash: "hash" },
        summary: {},
        diagnostics: [],
        providers: [{
          id: "fixture",
          enabled: true,
          credential: { references: ["env:PROVIDER_SECRET"] },
          authentication: { state: "ready", reference: "env:PROVIDER_SECRET" },
          health: {},
          catalog: {}
        }],
        operations: [{ id: "op", actor: "private-session", idempotencyKey: "secret-key", kind: "doctor", state: "completed" }]
      },
      seededSecret: "provider-secret-canary"
    });
    const bundle = await readFile(target, "utf8");
    expect(bundle).not.toContain("PROVIDER_SECRET");
    expect(bundle).not.toContain("provider-secret-canary");
    expect(bundle).not.toContain("private-session");
    expect(bundle).not.toContain("secret-key");
    expect(bundle).toContain('"uploaded": false');
  });
});
