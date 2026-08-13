import { chmod, mkdtemp, readFile, rm, stat } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { ProtectedCredentialStore } from "../src/platform/credentials.js";

describe("ProtectedCredentialStore", () => {
  it("generates and hydrates an opaque capability from a current-user-only store", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "codex-router-credentials-"));
    const file = path.join(root, "config", "credentials.json");
    const store = new ProtectedCredentialStore(file);
    try {
      const environment: NodeJS.ProcessEnv = {};
      await store.ensureGenerated("env:CODEX_ROUTER_INFERENCE_TOKEN", environment);
      expect(environment.CODEX_ROUTER_INFERENCE_TOKEN).toMatch(/^[A-Za-z0-9_-]{40,}$/);
      expect(await store.hydrate({})).toEqual(["env:CODEX_ROUTER_INFERENCE_TOKEN"]);
      expect((await stat(file)).mode & 0o077).toBe(0);
      expect(JSON.parse(await readFile(file, "utf8"))).toEqual({ CODEX_ROUTER_INFERENCE_TOKEN: environment.CODEX_ROUTER_INFERENCE_TOKEN });
      await chmod(file, 0o644);
      await expect(store.hydrate({})).rejects.toThrow("group or world permissions");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
