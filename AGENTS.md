# Codex Router repository contract

## Product invariants

- Keep MCP lifecycle calls bounded; a start call must never wait for turn completion.
- Append normalized runtime events before updating projections.
- Never replay a turn after semantic output, a command, a file mutation, an approval, or an external side effect is observed.
- Keep logical-agent, incarnation, runtime, thread, turn, and worktree identity separate.
- A write worktree has one persisted lease owner and a monotonically increasing fencing token.
- Runtime profiles contain secret references only. Never persist resolved credential or `CODEX_HOME` values.
- Continuations retain runtime and thread affinity. Cross-runtime recovery is an explicit handoff with a new thread.
- Results label worker reports separately from router-observed evidence.

## Verification

Run `pnpm verify` for the full local gate. Use focused `pnpm vitest run <path>` while iterating.

Protocol compatibility is pinned in `src/runtime/codex-protocol.ts`. Validate changes against generated types from the supported `codex app-server` before changing its request shapes.
