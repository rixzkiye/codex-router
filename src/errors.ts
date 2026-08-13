export type RouterErrorCode =
  | "not_found"
  | "conflict"
  | "idempotency_conflict"
  | "invalid_transition"
  | "invalid_worktree"
  | "worktree_conflict"
  | "no_eligible_runtime"
  | "stale_incarnation"
  | "stale_turn"
  | "not_steerable"
  | "handoff_required"
  | "waiting_for_reset"
  | "unsupported"
  | "runtime_unavailable"
  | "protocol_incompatible"
  | "unauthorized"
  | "internal";

export class RouterError extends Error {
  readonly code: RouterErrorCode;
  readonly details: Record<string, unknown>;

  constructor(
    code: RouterErrorCode,
    message: string,
    details: Record<string, unknown> = {}
  ) {
    super(message);
    this.name = "RouterError";
    this.code = code;
    this.details = details;
  }
}
export function asRouterError(error: unknown): RouterError {
  if (error instanceof RouterError) return error;
  const message = error instanceof Error ? error.message : "Unknown router failure";
  return new RouterError("internal", message);
}
