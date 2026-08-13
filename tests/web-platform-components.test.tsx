// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { render, screen } from "@testing-library/react";
import axe from "axe-core";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { RouterApplicationService } from "../src/application.js";
import { CodexRouter } from "../src/router.js";
import { SecretRedactor } from "../src/security.js";
import { ConsoleApi } from "../web/src/api";
import { ProvidersPage } from "../web/src/platform-pages";
import type { BootstrapDto } from "../web/src/types";
import { MockRuntimeAdapter, silentLogger, testConfig } from "./helpers.js";

describe("platform Console pages", () => {
  let router: CodexRouter;
  let data: BootstrapDto;

  beforeAll(async () => {
    const root = await mkdtemp(path.join(tmpdir(), "codex-router-platform-web-"));
    const redactor = new SecretRedactor();
    const adapter = new MockRuntimeAdapter("runtime-a");
    router = await CodexRouter.create(testConfig(root), {
      logger: silentLogger,
      redactor,
      adapters: new Map([[adapter.id, adapter]])
    });
    data = {
      ...new RouterApplicationService(router, redactor).bootstrap(),
      csrfToken: "fixture-csrf"
    } as unknown as BootstrapDto;
  });

  afterAll(async () => router.close());

  it("renders truthful provider states and passes an automated accessibility scan", async () => {
    const { container } = render(<ProvidersPage
      api={new ConsoleApi()}
      data={data}
      connection="live"
      navigate={vi.fn()}
      refresh={vi.fn(async () => undefined)}
    />);
    expect(screen.getByRole("heading", { level: 1, name: "Providers" })).toBeVisible();
    expect(screen.getByRole("button", { name: /Codex \/ ChatGPT/ })).toHaveTextContent("unknown");
    expect(screen.getByText(/Catalog presence is not a readiness claim/)).toBeVisible();
    const result = await axe.run(container, {
      rules: { region: { enabled: false }, "color-contrast": { enabled: false } }
    });
    expect(result.violations).toEqual([]);
  });

  it("renders provider onboarding from the safe browser auth boundary", () => {
    render(<ProvidersPage
      api={new ConsoleApi()}
      data={data}
      connection="live"
      navigate={vi.fn()}
      providerId="local"
      refresh={vi.fn(async () => undefined)}
    />);
    expect(screen.getByRole("heading", { level: 1, name: "Local Ollama" })).toBeVisible();
    expect(screen.getByRole("list", { name: "Provider onboarding progress" })).toHaveTextContent("keyless");
  });
});
