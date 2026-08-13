import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import {
  agentCancelRequestSchema,
  agentContinueRequestSchema,
  agentHandoffRequestSchema,
  agentListRequestSchema,
  agentRespondRequestSchema,
  agentResultRequestSchema,
  agentStartRequestSchema,
  agentStatusRequestSchema,
  agentSteerRequestSchema,
  agentWaitRequestSchema
} from "./domain.js";
import { asRouterError } from "./errors.js";
import type { RouterApplicationService } from "./application.js";
import type { SecretRedactor } from "./security.js";

type ApplicationCommands = Pick<
  RouterApplicationService,
  "start" | "status" | "list" | "wait" | "steer" | "continue" | "cancel" | "handoff" | "result" | "respond" | "diagnostics"
>;

export function createMcpServer(router: ApplicationCommands, redactor: SecretRedactor): McpServer {
  const server = new McpServer({ name: "codex-router", version: "0.1.0" });
  const callerScope = process.env.CODEX_ROUTER_CALLER_SCOPE ?? "local:stdio";

  server.registerTool(
    "agent_start",
    {
      description:
        "Create a durable logical coding agent and return after its turn is accepted or durably queued. Never waits for completion.",
      inputSchema: agentStartRequestSchema.shape,
      annotations: { destructiveHint: true, idempotentHint: true, openWorldHint: false }
    },
    async (input) => toolResult(() => router.start(callerScope, agentStartRequestSchema.parse(input)), redactor)
  );

  server.registerTool(
    "agent_status",
    {
      description: "Read the current durable projection, active identifiers, attention state, and quota summary.",
      inputSchema: agentStatusRequestSchema.shape,
      annotations: { readOnlyHint: true, openWorldHint: false }
    },
    async (input) =>
      toolResult(async () => {
        const parsed = agentStatusRequestSchema.parse(input);
        return router.status(parsed.agentId, parsed.includeHistory);
      }, redactor)
  );

  server.registerTool(
    "agent_list",
    {
      description: "List visible logical agents with filters and cursor pagination; transcripts are excluded.",
      inputSchema: agentListRequestSchema.shape,
      annotations: { readOnlyHint: true, openWorldHint: false }
    },
    async (input) => toolResult(async () => router.list(agentListRequestSchema.parse(input)), redactor)
  );

  server.registerTool(
    "agent_wait",
    {
      description:
        "Wait on durable registry events for any/all requested agents. Timeout returns current projections rather than an error.",
      inputSchema: agentWaitRequestSchema.shape,
      annotations: { readOnlyHint: true, openWorldHint: false }
    },
    async (input) => toolResult(() => router.wait(agentWaitRequestSchema.parse(input)), redactor)
  );

  server.registerTool(
    "agent_steer",
    {
      description: "Append instructions to the active regular turn with optional incarnation and turn preconditions.",
      inputSchema: agentSteerRequestSchema.shape,
      annotations: { destructiveHint: true, idempotentHint: true, openWorldHint: false }
    },
    async (input) => toolResult(() => router.steer(callerScope, agentSteerRequestSchema.parse(input)), redactor)
  );

  server.registerTool(
    "agent_continue",
    {
      description: "Start a follow-up turn on the same logical agent, runtime, and thread.",
      inputSchema: agentContinueRequestSchema.shape,
      annotations: { destructiveHint: true, idempotentHint: true, openWorldHint: false }
    },
    async (input) => toolResult(() => router.continue(callerScope, agentContinueRequestSchema.parse(input)), redactor)
  );

  server.registerTool(
    "agent_cancel",
    {
      description:
        "Request interruption of the active turn. Acceptance transitions to cancelling; terminal state remains event-confirmed.",
      inputSchema: agentCancelRequestSchema.shape,
      annotations: { destructiveHint: true, idempotentHint: true, openWorldHint: false }
    },
    async (input) => toolResult(() => router.cancel(callerScope, agentCancelRequestSchema.parse(input)), redactor)
  );

  server.registerTool(
    "agent_handoff",
    {
      description:
        "Checkpoint and move a logical agent to a new runtime incarnation without claiming cross-runtime conversation migration.",
      inputSchema: agentHandoffRequestSchema.shape,
      annotations: { destructiveHint: true, idempotentHint: true, openWorldHint: false }
    },
    async (input) => toolResult(() => router.handoff(callerScope, agentHandoffRequestSchema.parse(input)), redactor)
  );

  server.registerTool(
    "agent_result",
    {
      description: "Return a compact versioned result with reported claims separated from observed evidence.",
      inputSchema: agentResultRequestSchema.shape,
      annotations: { readOnlyHint: true, openWorldHint: false }
    },
    async (input) =>
      toolResult(async () => {
        const parsed = agentResultRequestSchema.parse(input);
        return router.result(parsed.agentId, parsed.version, parsed.detail);
      }, redactor)
  );

  server.registerTool(
    "agent_respond",
    {
      description:
        "Respond to one pending approval or user-input request. Approval is constrained by the original authority envelope.",
      inputSchema: agentRespondRequestSchema.shape,
      annotations: { destructiveHint: true, idempotentHint: true, openWorldHint: false }
    },
    async (input) => toolResult(() => router.respond(callerScope, agentRespondRequestSchema.parse(input)), redactor)
  );

  server.registerTool(
    "router_diagnostics",
    {
      description:
        "Read operator diagnostics for runtime health, agent counts, pending interactions, writer leases, events, and suppression counters.",
      inputSchema: {},
      annotations: { readOnlyHint: true, openWorldHint: false }
    },
    async () => toolResult(async () => router.diagnostics(), redactor)
  );

  return server;
}

async function toolResult(operation: () => Promise<unknown>, redactor: SecretRedactor): Promise<CallToolResult> {
  try {
    const value = redactor.redact(await operation());
    const structured = asStructured(value);
    return {
      content: [{ type: "text", text: JSON.stringify(value) }],
      structuredContent: structured
    };
  } catch (error) {
    const normalized = asRouterError(error);
    const payload = redactor.redact({
      error: {
        code: normalized.code,
        message: normalized.message,
        details: normalized.details
      }
    });
    return {
      content: [{ type: "text", text: JSON.stringify(payload) }],
      structuredContent: payload,
      isError: true
    };
  }
}

function asStructured(value: unknown): Record<string, unknown> {
  if (value && typeof value === "object" && !Array.isArray(value)) return value as Record<string, unknown>;
  return { value };
}
