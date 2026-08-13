# Codex Router

[![CI](https://github.com/rixzkiye/codex-router/actions/workflows/ci.yml/badge.svg)](https://github.com/rixzkiye/codex-router/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)

Codex Router is a durable MCP control plane for starting, observing, steering, continuing, cancelling, and handing off long-running coding agents. MCP calls remain bounded while work continues in persistent Codex App Server threads or configured external-provider bridge processes.

The core invariant is: logical agent identity is durable, execution context is replaceable, and the actual worktree plus observed evidence are authoritative.

## Product specifications

- [Unified Platform PRD](PLATFORM_PRD.md) defines the complete target product across durable agents, multi-provider inference, authentication, model catalogs, operations, and the expanded Web Console.
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
- A loopback-only OpenAI Responses inference gateway with exact model-to-provider routing, credential isolation, bounded request bodies, streaming backpressure, and no automatic replay or failover.
- A deterministic provider/model registry spanning the native, API-key, OAuth-forwarder, CLI-session, and local provider families in the Platform PRD, with conservative publication states and collision-safe identities.
- A hash-pinned LiteLLM translation closure, generated no-retry/no-fallback/no-cache configuration, independent edge-to-translator capability, and an actual-proxy hosted CI boot probe.
- Model-scoped compatibility profiles for DeepSeek, Kimi, Qwen, GLM, Gemini, Anthropic, MiniMax, Grok, Ollama, and strict tool-history repair, with transformation categories recorded instead of prompt bodies.
- Durable platform operations, append-before-project platform events, provider/catalog/model projections, sanitized request timing, provider usage, quota-header freshness, and generated-artifact manifests.
- Official CLI-owned login/logout readback for native Codex, Kimi, Grok, and Command Code boundaries; signed router compaction envelopes; bounded tool-result aging; namespace-safe tool relay; and a governed, deduplicating vision bridge.
- Local Ollama discovery, explicit-consent download/removal, measured tool-call validation, selection, cancellation, and restart reconciliation.
- Transactional current-user install planning, apply/update, rollback, disable, and manifest-owned uninstall across Linux, macOS, and Windows service-definition formats.
- Clean/unclean checkpoints, explicit cross-runtime hydration, policy-gated quota handoff, and no blind prompt replay.
- Versioned compact results that separate worker-reported claims from observed worktree and command evidence.
- Early recursive credential redaction and authority checks on pending approval responses.
- A responsive Web Console over the same router application service, with a resumable SSE projection, lifecycle controls, durable attention inbox, evidence views, runtime/worktree/event diagnostics, and an Emil-derived accessible design system.
- Console workbenches for Providers, Accounts, Models, Routing, Requests, Usage, Local Models, and Diagnostics, including resumable discovery, mock compatibility, explicit unknown/stale states, and version-checked mutations.
- A loopback-only Web gateway with one-time fragment bootstrap, HttpOnly SameSite session cookies, Origin/CSRF enforcement, strict CSP, bounded request bodies, and versioned redacted browser DTOs.

## Requirements

- Node.js 22.13 or newer.
- pnpm 10.
- SQLite native build support for `better-sqlite3` (prebuilt binaries are normally used).
- A supported `codex` binary for Codex-backed runtimes.
- One authorized `CODEX_HOME` directory per Codex runtime.
- Python 3.10 or newer only when a configured provider requires LiteLLM translation. The complete closure is installed from `requirements/litellm.txt` with hashes.

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

The built-in gateway binds to `127.0.0.1:4178` by default. `--open` places a short-lived one-time token in the URL fragment; the browser removes the fragment immediately and exchanges it for an HttpOnly, SameSite=Strict session cookie. Use `--port 0` for an ephemeral port or `--assets /absolute/path/to/dist/console` to override the static bundle location.

The built-in gateway intentionally refuses non-loopback binding. Remote access requires an explicitly configured authenticated TLS reverse proxy or a production gateway with trusted identity and role mapping. Do not forward the local bootstrap URL or expose it through a public tunnel.

For a representative local UI fixture without real credentials or provider calls:

```bash
pnpm preview:web
```

Model catalogs and account status remain provider/runtime-authoritative. The Console shows unavailable, unknown, stale, restricted, and experimental states explicitly and disables mutations whose evidence preconditions are not met.

### Platform operations

The same application service used by the Console is available through the local CLI:

```bash
node dist/index.js platform status --config ./codex-router.config.json
node dist/index.js platform providers --config ./codex-router.config.json
node dist/index.js platform doctor --config ./codex-router.config.json
node dist/index.js platform artifacts --output ./data/generated --config ./codex-router.config.json
node dist/index.js platform support-bundle --output ./data/support-$(date +%s).json --config ./codex-router.config.json
node dist/index.js platform provider native-codex validate --config ./codex-router.config.json
node dist/index.js platform provider native-codex login --codex-home /secure/codex-home --config ./codex-router.config.json
node dist/index.js platform local discover --config ./codex-router.config.json
node dist/index.js platform local download qwen3-coder:30b --yes --config ./codex-router.config.json
```

Provider and model mutations are version-checked, idempotent, audited, and read back before completion. Support bundles are created locally with mode `0600`, list their safe projections, exclude credential references and request content, and are never uploaded automatically.

Managed installation is deliberately two-step. Planning is read-only; material actions require `--yes` and refuse filesystem roots or the user home directory:

```bash
node dist/index.js platform install plan \
  --root /absolute/dedicated/state \
  --version 0.2.0 \
  --release-source /absolute/released-artifact \
  --entrypoint dist/index.js \
  --config /absolute/codex-router.config.json

node dist/index.js platform install apply \
  --root /absolute/dedicated/state \
  --version 0.2.0 \
  --release-source /absolute/released-artifact \
  --entrypoint dist/index.js \
  --config /absolute/codex-router.config.json \
  --yes

node dist/index.js platform install rollback --manifest /absolute/dedicated/state/install-manifest.json --yes
node dist/index.js platform install disable --manifest /absolute/dedicated/state/install-manifest.json --yes
node dist/index.js platform install uninstall --manifest /absolute/dedicated/state/install-manifest.json --yes
```

The Console exposes the same application authority under **Diagnostics → Managed installation**, including exact paths, consent, durable operation state, cancellation, and independent manifest readback.

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

## Model inference gateway

The optional inference gateway is a separate data plane for Codex-compatible Responses API traffic. It does not own agent lifecycle, tools, worktrees, continuations, or handoffs. Native Responses routes remain direct; configured Chat Completions and Anthropic Messages routes go through the loopback-only LiteLLM translation core under a separate internal capability.

Configure `inference` with an `env:` caller token reference, provider endpoints, provider credential references, and exact public-to-upstream model mappings. Then run:

```bash
export CODEX_ROUTER_INFERENCE_TOKEN="$(openssl rand -hex 32)"
export CODEX_ROUTER_EXAMPLE_PROVIDER_KEY="provider credential"
export CODEX_ROUTER_LITELLM_TOKEN="$(openssl rand -hex 32)"
export CODEX_ROUTER_COMPACTION_KEY="$(openssl rand -hex 32)"
node dist/index.js inference --config ./codex-router.config.json
```

The command prints a loopback base URL such as `http://127.0.0.1:4202/v1`. Clients authenticate to it with the caller token. The gateway authenticates before reading model traffic, strips caller and Codex identity headers, removes `client_metadata`, rewrites only the configured model ID, and injects only the selected provider credential. `GET /health` is credential-free and contains counts only; `GET /v1/models`, `POST /v1/responses`, and `POST /v1/responses/compact` require caller authentication.

Each request has exactly one selected provider. The gateway stages a bounded SSE preflight, records the first semantic boundary, rejects a provably empty completion before commitment, and never replays or fails over after semantic output. This preserves the router's no-replay boundary and keeps continuation/provider affinity an explicit control-plane decision.

`compaction.integrityKeyRef` enables router-owned signed compaction envelopes for external routes. `toolResultAging` is opt-in and preserves recent or error-bearing tool results. `visionBridge` is disabled by default; enabling it requires explicit engine model IDs and never changes the upstream model's native modality claim. Local model downloads and deletions are separate consented operations and selection requires a measured tool call.

Compressed JSON requests support bounded gzip, deflate, and Brotli decoding. Zstandard is accepted only when the running Node build exposes a bounded decoder; otherwise the edge returns a truthful `unsupported_content_encoding` response.

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

The suite covers state/idempotency behavior, sparse quotas, event deduplication, Codex App Server and external-provider JSONL contracts, parallel event waits, same-thread continuation, cancellation confirmation, observed results, authority/redaction, single-writer fencing, clean and unclean handoff, structured usage-limit recovery, restart reconciliation without duplicate start, provider registry and profile contracts, compressed bodies, empty-stream preflight, catalog discovery, platform operations, support-bundle redaction, and Console accessibility.

`pnpm verify` also verifies that the LiteLLM direct pins exist in the universal hash lock. Hosted `litellm.yml` separately installs the complete closure with `--require-hashes`, starts the real proxy, and probes `/health/liveliness`; this is not inferred from lock resolution.

Live credential-backed App Server and provider tests are intentionally operator-run because credentials never enter repository fixtures.

Passing `pnpm verify` establishes local implementation evidence only. General Availability additionally requires exact-head hosted CI, independent security and WCAG/visual review, package/provenance inspection, live provider/model compatibility, and released-artifact install/update/rollback proof on every supported host. See [Capability adoption ledger](docs/CAPABILITY_LEDGER.md).

## Contributing and security

Contributions are welcome. See [CONTRIBUTING.md](CONTRIBUTING.md) for the development workflow. Please report security issues privately as described in [SECURITY.md](SECURITY.md).

## License

Codex Router is available under the [MIT License](LICENSE).
