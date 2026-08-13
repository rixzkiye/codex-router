/**
 * Minimal adapter boundary from Codex App Server generated protocol types.
 * Validated against openai/codex commit 363427b5e3fe1b6d7499e6bc47651f62a5a3b1d2
 * and codex-cli 0.147.0. Keep this deliberately smaller than the full 650-file
 * generated schema and fail closed for capabilities outside this surface.
 */

export type JsonRpcId = string | number;

export type CodexClientMessage =
  | { id: JsonRpcId; method: string; params?: unknown }
  | { method: string; params?: unknown }
  | { id: JsonRpcId; result?: unknown; error?: CodexRpcError };

export interface CodexRpcError {
  code: number;
  message: string;
  data?: unknown;
}

export interface CodexServerMessage {
  id?: JsonRpcId;
  method?: string;
  params?: Record<string, unknown>;
  result?: unknown;
  error?: CodexRpcError;
}

export type AskForApproval = "untrusted" | "on-request" | "never";
export type SandboxMode = "read-only" | "workspace-write" | "danger-full-access";
export type SandboxPolicy =
  | { type: "readOnly"; networkAccess: boolean }
  | {
      type: "workspaceWrite";
      writableRoots: string[];
      networkAccess: boolean;
      excludeTmpdirEnvVar: boolean;
      excludeSlashTmp: boolean;
    };

export interface InitializeParams {
  clientInfo: { name: string; title: string; version: string };
  capabilities: { experimentalApi: boolean };
}

export interface ThreadStartParams {
  model?: string;
  cwd: string;
  approvalPolicy: AskForApproval;
  sandbox: SandboxMode;
  serviceName: string;
  developerInstructions: string;
  threadSource: string;
}

export interface ThreadResumeParams {
  threadId: string;
  cwd?: string;
  model?: string;
  approvalPolicy?: AskForApproval;
  sandbox?: SandboxMode;
}

export interface TurnStartParams {
  threadId: string;
  clientUserMessageId: string;
  input: Array<{ type: "text"; text: string }>;
  cwd?: string;
  model?: string;
  sandboxPolicy?: SandboxPolicy;
}

export interface TurnSteerParams {
  threadId: string;
  clientUserMessageId: string;
  input: Array<{ type: "text"; text: string }>;
  expectedTurnId: string;
}

export interface TurnInterruptParams {
  threadId: string;
  turnId: string;
}

export function objectResult(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  return value as Record<string, unknown>;
}

export function nestedString(value: unknown, ...path: string[]): string | undefined {
  let current: unknown = value;
  for (const segment of path) {
    if (!current || typeof current !== "object" || Array.isArray(current)) return undefined;
    current = (current as Record<string, unknown>)[segment];
  }
  return typeof current === "string" ? current : undefined;
}
