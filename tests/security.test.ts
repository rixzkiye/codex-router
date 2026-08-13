import { describe, expect, it } from "vitest";
import { SecretRedactor, requestHash, stableStringify } from "../src/security.js";
import { WorktreeInspector } from "../src/worktree.js";
import { homedir } from "node:os";

describe("security primitives", () => {
  it("redacts known credentials, bearer tokens, and secret-bearing fields recursively", () => {
    const redactor = new SecretRedactor();
    redactor.addSecret("super-secret-value");
    const redacted = redactor.redact({
      prompt: "never print super-secret-value or Bearer abc.def.ghi",
      credentialRef: "env:SECRET",
      nested: { apiKey: "sk-abcdefghijklmnop" }
    });
    expect(JSON.stringify(redacted)).not.toContain("super-secret-value");
    expect(JSON.stringify(redacted)).not.toContain("abc.def.ghi");
    expect(JSON.stringify(redacted)).not.toContain("abcdefghijklmnop");
  });

  it("hashes equivalent object payloads identically", () => {
    expect(stableStringify({ b: 2, a: 1 })).toBe(stableStringify({ a: 1, b: 2 }));
    expect(requestHash({ b: 2, a: 1 })).toBe(requestHash({ a: 1, b: 2 }));
  });

  it("rejects a user home directory as an allowed worktree root", async () => {
    await expect(WorktreeInspector.create([homedir()])).rejects.toMatchObject({
      code: "invalid_worktree"
    });
  });
});
