# Codex Router

[![CI](https://github.com/rixzkiye/codex-router/actions/workflows/ci.yml/badge.svg)](https://github.com/rixzkiye/codex-router/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)

Codex Router is a durable MCP control plane for starting, observing, steering, continuing, cancelling, and handing off long-running coding agents. MCP calls remain bounded while work continues in persistent Codex App Server threads or configured external-provider bridge processes.

The core invariant is: logical agent identity is durable, execution context is replaceable, and the actual worktree plus observed evidence are authoritative.

## Product specifications

- [Core Router PRD](PRD.md) defines lifecycle, durability, routing, recovery, authority, and evidence semantics.
- [Web Console PRD](WEB_UI_PRD.md) defines the complete operator UI, browser transport, interaction model, aesthetic system, accessibility, and release gates.

## What is implemented

- The ten PRD lifecycle tools: `agent_start`, `agent_status`, `agent_list`, `agent_wait`, `agent_steer`, `agent_continue`, `agent_cancel`, `agent_handoff`, `agent_result`, and `agent_respond`.
- `router_diagnostics` for runtime health, concurrency, quota, leases, pending attention, event counts, and duplicate-suppression counters.
- Transactional SQLite projections plus an append-before-project event journal.
- Durable idempotency records for every mutating command.
- Registry-version event waits with `any`, `all`, timeout, and reconnect cursors.
- Worktree path containment, actual Git inspection, single-writer leases, and monotonically increasing fencing tokens.
- Capability-, affinity-, quota-, health-, load-, project-, provider-, and model-aware scheduling with recorded reasons.
- Codex App Server JSONL supervision with `initialize`, thread start/read/resume, turn start/steer/interrupt, lifecycle normalization, approvals, sparse quota updates, and restart reconciliation.
- A normalized external-provider JSONL bridge contract for configured OpenAI, DeepSeek, or other API worker processes.
- Clean/unclean checkpoints, explicit cross-runtime hydration, policy-gated quota handoff, and no blind prompt replay.
- Versioned compact results that separate worker-reported claims from observed worktree and command evidence.
- Early recursive credential redaction and authority checks on pending approval responses.
- A responsive Web Console over the same router application service, with a resumable SSE projection, lifecycle controls, durable attention inbox, evidence views, runtime/worktree/event diagnostics, and an Emil-derived accessible design system.
- A loopback-only Web gateway with one-time fragment bootstrap, HttpOnly SameSite session cookies, Origin/CSRF enforcement, strict CSP, bounded request bodies, and versioned redacted browser DTOs.

## Requirements

- Node.js 22.13 or newer.
- pnpm 10.
- SQLite native build support for `better-sqlite3` (prebuilt binaries are normally used).
- A supported `codex` binary for Codex-backed runtimes.
- One authorized `CODEX_HOME` directory per Codex runtime.

The concrete App Server boundary was validated against `openai/codex` commit `363427b5e3fe1b6d7499e6bc47651f62a5a3b1d2` and codex-cli `0.147.0`. The official protocol documentation is [Codex App Server](https://developers.openai.com/codex/app-server/). Regenerate or inspect the installed version’s types before changing request shapes:

```bash
codex app-server generate-ts --out ./schemas
codex app-server generate-json-schema --out ./schemas
```

## Install and run

```bash
pnpm install
cp codex-router.config.example.json codex-router.config.json
pnpm build
node dist/index.js --config ./codex-router.config.json
```

Register it in an MCP host as a stdio server. A representative command is:

```json
{
  "command": "node",
  "args": [
    "/absolute/path/to/codex-router/dist/index.js",
    "--config",
    "/absolute/path/to/codex-router/codex-router.config.json"
  ]
}
```

### Web Console

Build and open the local Console:

```bash
pnpm build
node dist/index.js web --open --config ./codex-router.config.json
```

The built-in gateway binds to `127.0.0.1:4178` by default. `--open` places a short-lived one-time token in the URL fragment; the browser removes the fragment immediately and exchanges it for an HttpOnly, SameSite=Strict session cookie. Use `--port 0` for an ephemeral port or `--assets /absolute/path/to/dist/web` to override the static bundle location.

The built-in gateway intentionally refuses non-loopback binding. Remote access requires an explicitly configured authenticated TLS reverse proxy or a production gateway with trusted identity and role mapping. Do not forward the local bootstrap URL or expose it through a public tunnel.

For a representative local UI fixture without real credentials or provider calls:

```bash
pnpm preview:web
```

Model catalogs and account status remain runtime-authoritative. When an installed adapter does not expose those capabilities, the Console shows an explicit unavailable/unknown state and disables the related mutation instead of inventing a model list or authentication result.

Set every referenced runtime environment variable in the router process, for example:

```bash
export CODEX_ROUTER_SOL_MAIN_HOME=/secure/codex-runtimes/sol-main
```

The configuration persists only the reference `env:CODEX_ROUTER_SOL_MAIN_HOME`; the resolved path is injected into the child process and registered with the redactor. Do not put raw credentials in the JSON file.

## Configuration

`allowedWorktreeRoots` must contain specific absolute workspace directories. Filesystem root and the user home directory are rejected. Requested worktrees are resolved through symlinks before containment checks.

Each Codex runtime has an isolated `codexHomeRef`, model allow-list, capability tiers, concurrency limit, and policy tags. Project-scoped authorization uses `project:<projectKey>` tags. If a profile has any `project:` tags, a request must match one of them.

New long tasks avoid `draining` runtimes. `limited` and `offline` runtimes are never allocated. Continuations have dominant affinity and never silently switch runtime or provider.

## External-provider bridge

An `external_provider` runtime launches the configured command and injects its resolved credential as `CODEX_ROUTER_PROVIDER_CREDENTIAL`. The bridge uses newline-delimited JSON-RPC-like messages and must respond to:

- `initialize`, followed by `initialized`
- `agent/start`
- `agent/continue` when `resume` is advertised
- `agent/steer` when `steer` is advertised
- `agent/interrupt` when `interrupt` is advertised
- `agent/respond` when `approvals` is advertised
- `agent/reconcile`
- `agent/find` for lost-response correlation recovery
- `agent/terminals`

Start and continue return `{ "threadId", "turnId", "acceptedAt" }`. The bridge sends normalized notifications as:

```json
{
  "method": "event",
  "params": {
    "eventId": "provider-event-id",
    "type": "turn_completed",
    "threadId": "thread-id",
    "turnId": "turn-id",
    "payload": { "status": "completed", "reported": { "summary": "..." } },
    "occurredAt": "2026-08-13T00:00:00.000Z"
  }
}
```

The bridge, not the router, owns provider-specific model calls and tool execution. It must enforce the supplied worktree mode, authority envelope, and fencing token.

## Lifecycle and recovery semantics

- `agent_start` returns after turn acceptance or after the task is durably visible as queued/attention-required.
- Identical retries return the same logical agent. Conflicting reuse of an idempotency key fails closed.
- `agent_wait` subscribes to durable registry versions; it does not poll a model.
- `agent_cancel` first records `cancelling`; only a runtime event or reconciliation establishes `interrupted`.
- A continuation stays on its runtime and thread. An unavailable original runtime requires reset or explicit handoff.
- A handoff quiesces/reconciles the old incarnation, inventories background terminals, inspects the real worktree, records a checkpoint, fences the old lease, and starts a new thread with verification-first hydration.
- Writer leases renew for the lifetime of router ownership. Restart restores only unexpired matching leases; an expired active lease becomes an attention state instead of being silently reused.
- Codex threads carry a `threadSource` correlation marker so restart reconciliation can discover a thread accepted before its response was durably projected.
- Automatic quota handoff occurs only for `auto_handoff_if_clean`, a clean checkpoint, and another eligible authorized runtime.
- An unclean checkpoint requires explicit `allowUnclean: true`.
- Semantic output, command start, file change, and diff events permanently mark replay as unsafe.

## Verification

Run the complete local gate:

```bash
pnpm verify
```

The suite covers state/idempotency behavior, sparse quotas, event deduplication, Codex App Server and external-provider JSONL contracts, parallel event waits, same-thread continuation, cancellation confirmation, observed results, authority/redaction, single-writer fencing, clean and unclean handoff, structured usage-limit recovery, and restart reconciliation without duplicate start.

Live credential-backed App Server and provider tests are intentionally operator-run because credentials never enter repository fixtures.

## Contributing and security

Contributions are welcome. See [CONTRIBUTING.md](CONTRIBUTING.md) for the development workflow. Please report security issues privately as described in [SECURITY.md](SECURITY.md).

## License

Codex Router is available under the [MIT License](LICENSE).
