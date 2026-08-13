import type {
  AgentRespondRequest,
  AuthorityEnvelope,
  NormalizedRuntimeEvent,
  RuntimeState
} from "../domain.js";

export interface RuntimeCapabilities {
  steer: boolean;
  interrupt: boolean;
  resume: boolean;
  approvals: boolean;
  readOnlySandbox: boolean;
  writeSandbox: boolean;
}

export interface RuntimeTaskContext {
  agentId: string;
  incarnationId: string;
  idempotencyKey: string;
  task: string;
  worktreePath: string;
  worktreeMode: "write" | "read_only";
  authority: AuthorityEnvelope;
  model?: string;
  fencingToken?: number;
  hydration?: Record<string, unknown>;
}

export interface StartTurnResult {
  threadId: string;
  turnId: string;
  acceptedAt: string;
}

export interface ContinueTurnContext {
  agentId: string;
  incarnationId: string;
  idempotencyKey: string;
  threadId: string;
  input: string;
  worktreePath: string;
  worktreeMode: "write" | "read_only";
  model?: string;
  fencingToken?: number;
}

export interface ReconciliationResult {
  state: "active" | "terminal" | "not_loaded" | "not_found" | "unknown";
  threadId: string;
  turnId: string | null;
  turnStatus?: "completed" | "failed" | "interrupted";
  evidence: Record<string, unknown>;
}

export interface BackgroundTerminalInventory {
  clean: boolean;
  terminals: Array<{ id: string; status: string; command?: string }>;
  inspectedAt: string;
}

export type RuntimeEventHandler = (event: NormalizedRuntimeEvent) => void | Promise<void>;

export interface RuntimeAdapter {
  readonly id: string;
  readonly capabilities: RuntimeCapabilities;
  readonly state: RuntimeState;

  connect(): Promise<void>;
  close(): Promise<void>;
  onEvent(handler: RuntimeEventHandler): () => void;
  startTask(context: RuntimeTaskContext): Promise<StartTurnResult>;
  continueTurn(context: ContinueTurnContext): Promise<StartTurnResult>;
  steer(threadId: string, turnId: string, input: string, idempotencyKey: string): Promise<void>;
  interrupt(threadId: string, turnId: string): Promise<void>;
  respond(
    backendRequestId: string | number,
    method: string,
    response: AgentRespondRequest["response"],
    params: Record<string, unknown>
  ): Promise<void>;
  bindContext(agentId: string, incarnationId: string, threadId: string, turnId: string | null): void;
  findThreadByCorrelation(agentId: string, incarnationId: string, worktreePath: string): Promise<string | null>;
  reconcile(threadId: string, knownTurnId: string | null): Promise<ReconciliationResult>;
  inspectBackgroundTerminals(threadId: string): Promise<BackgroundTerminalInventory>;
}
