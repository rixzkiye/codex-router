// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import axe from "axe-core";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { RouterApplicationService } from "../src/application.js";
import { CodexRouter } from "../src/router.js";
import { SecretRedactor } from "../src/security.js";
import { ConsoleApi } from "../web/src/api";
import { LocalModelsPage, PlatformDiagnosticsPage, ProvidersPage, RoutingPage } from "../web/src/platform-pages";
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
  afterEach(() => cleanup());

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
  }, 45_000);

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

  it("keeps local-model download distinct from discovery and explicit selection", () => {
    render(<LocalModelsPage
      api={new ConsoleApi()}
      data={data}
      connection="live"
      navigate={vi.fn()}
      refresh={vi.fn(async () => undefined)}
    />);
    expect(screen.getByRole("heading", { level: 1, name: "Local Models" })).toBeVisible();
    const download = screen.getByRole("button", { name: /Download with consent/ });
    expect(download).toBeDisabled();
    fireEvent.change(screen.getByLabelText("Exact Ollama model"), { target: { value: "qwen3-coder:30b" } });
    expect(download).toBeEnabled();
    expect(screen.getByRole("button", { name: /Discover installed/ })).toBeEnabled();
  });

  it("renders routing rejection evidence without inventing a successful decision", () => {
    render(<RoutingPage
      api={new ConsoleApi()}
      data={data}
      connection="live"
      navigate={vi.fn()}
      refresh={vi.fn(async () => undefined)}
    />);
    expect(screen.getByRole("heading", { level: 1, name: "Routing" })).toBeVisible();
    expect(screen.getByText(/Once text, reasoning, a tool call/)).toBeVisible();
    expect(screen.getByText("No inference decisions recorded")).toBeVisible();
  });

  it("requires complete paths and explicit consent before installation mutation", async () => {
    const { container } = render(<PlatformDiagnosticsPage
      api={new ConsoleApi()}
      data={data}
      connection="live"
      navigate={vi.fn()}
      refresh={vi.fn(async () => undefined)}
    />);
    const plan = screen.getByRole("button", { name: /Plan without changes/ });
    const apply = screen.getByRole("button", { name: /Install release/ });
    expect(plan).toBeDisabled();
    expect(apply).toBeDisabled();
    fireEvent.change(screen.getByLabelText("Managed root"), { target: { value: "/tmp/codex-router-managed" } });
    fireEvent.change(screen.getByLabelText("Release version"), { target: { value: "0.2.0" } });
    fireEvent.change(screen.getByLabelText("Release source"), { target: { value: "/tmp/codex-router-release" } });
    fireEvent.change(screen.getByLabelText("Entrypoint inside release"), { target: { value: "dist/index.js" } });
    fireEvent.change(screen.getByLabelText("Router config path"), { target: { value: "/tmp/router.config.json" } });
    expect(plan).toBeEnabled();
    expect(apply).toBeDisabled();
    fireEvent.click(screen.getByRole("checkbox", { name: /I authorize the exact managed paths/ }));
    expect(apply).toBeEnabled();
    const result = await axe.run(container, {
      rules: { region: { enabled: false }, "color-contrast": { enabled: false } }
    });
    expect(result.violations).toEqual([]);
  }, 20_000);

  it("shows truthful managed-service, login, MCP, and path readback with explicit controls", async () => {
    const api = new ConsoleApi();
    const get = vi.spyOn(api, "get").mockResolvedValue({
      configured: true,
      background: true,
      startAtLogin: false,
      service: { state: "running", installed: true, running: true, startAtLogin: false, message: "The current-user service is running." },
      mcp: { state: "owned", message: "Codex readback matches the owned entry." },
      url: "http://127.0.0.1:4178",
      paths: {
        configFile: "/home/user/.config/codex-router/config.json",
        stateRoot: "/home/user/.local/state/codex-router",
        manifestFile: "/home/user/.local/state/codex-router/setup-manifest.json",
        mcpManifestFile: "/home/user/.local/state/codex-router/mcp-manifest.json",
        serviceFile: "/home/user/.config/systemd/user/codex-router.service",
        logFile: "/home/user/.local/state/codex-router/logs/router.log"
      }
    });
    const mutate = vi.spyOn(api, "mutate").mockResolvedValue({ accepted: true });
    const { container } = render(<PlatformDiagnosticsPage api={api} data={data} connection="live" navigate={vi.fn()} refresh={vi.fn(async () => undefined)} />);
    expect(await screen.findByRole("heading", { level: 2, name: "Router service" })).toBeVisible();
    expect(screen.getByText("Codex Router is running")).toBeVisible();
    expect(screen.getByText(/Codex readback matches the owned entry/)).toBeVisible();
    expect(screen.getByText("/home/user/.config/systemd/user/codex-router.service")).toBeVisible();
    fireEvent.click(screen.getByRole("button", { name: /Restart & reconnect/ }));
    expect(mutate).toHaveBeenCalledWith("/api/v1/management/restart", "POST", {});
    await waitFor(() => expect(screen.getByRole("checkbox", { name: /Run in background/ })).toBeEnabled());
    fireEvent.click(screen.getByRole("checkbox", { name: /Run in background/ }));
    expect(mutate).toHaveBeenCalledWith("/api/v1/management/background", "POST", { enabled: false, startAtLogin: false });
    const accessibility = await axe.run(container, { rules: { region: { enabled: false }, "color-contrast": { enabled: false } } });
    expect(accessibility.violations).toEqual([]);
    expect(get).toHaveBeenCalledWith("/api/v1/management");
  }, 20_000);
});
