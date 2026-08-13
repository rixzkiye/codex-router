import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { describe, expect, it } from "vitest";
import { createMcpServer } from "../src/mcp.js";
import { CodexRouter } from "../src/router.js";
import { createGitWorktree, dependencies, MockRuntimeAdapter, testConfig } from "./helpers.js";

describe("MCP control-plane contract", () => {
  it("advertises the lifecycle surface and returns structured non-blocking start output", async () => {
    const { root, worktree } = await createGitWorktree();
    const runtime = new MockRuntimeAdapter("runtime-a");
    const deps = dependencies([runtime]);
    const router = await CodexRouter.create(testConfig(root), deps);
    const server = createMcpServer(router, deps.redactor);
    const client = new Client({ name: "router-contract-test", version: "1.0.0" });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    try {
      await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
      const tools = await client.listTools();
      expect(tools.tools.map((tool) => tool.name).sort()).toEqual(
        [
          "agent_cancel",
          "agent_continue",
          "agent_handoff",
          "agent_list",
          "agent_respond",
          "agent_result",
          "agent_start",
          "agent_status",
          "agent_steer",
          "agent_wait",
          "router_diagnostics"
        ].sort()
      );
      const result = await client.callTool({
        name: "agent_start",
        arguments: {
          idempotencyKey: "mcp-start-1",
          task: "Run the MCP contract fixture",
          projectKey: "fixture",
          worktree: { path: worktree, mode: "read_only" },
          routing: { capabilityTier: "worker", model: "gpt-test" }
        }
      });
      expect(result.isError).not.toBe(true);
      expect(result.structuredContent).toMatchObject({ status: "running" });
      expect(runtime.starts).toHaveLength(1);
    } finally {
      await client.close();
      await server.close();
      await router.close();
    }
  });
});
