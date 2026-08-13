# Platform architecture and threat boundaries

## Authority map

| Boundary | Owns | Explicitly does not own |
| --- | --- | --- |
| Node inference edge | caller auth, model dispatch, decompression bounds, cancellation, response commitment, semantic observation, sanitized request records | provider identity stores, automatic cross-provider routing, durable agent identity |
| LiteLLM core | Responses to Chat Completions or Messages translation | caller auth, provider selection, retries, fallbacks, caching, virtual keys, spend authority |
| Provider boundary | selected symbolic credential resolution and upstream protocol | another provider's credential, browser state, logical-agent recovery |
| Agent control plane | logical agents, incarnations, runtimes, threads, turns, worktrees, leases, approvals, results | silent provider/account/model migration |
| Platform service | registry, operations, catalogs, compatibility, usage, diagnostics, generated artifacts | raw secrets, prompt/response retention, provider billing truth |
| Web Console | redacted projections and versioned commands | OAuth callbacks, token exchange, raw provider calls, SQLite access |

Every platform mutation appends a normalized platform event before changing its projection in the same SQLite transaction. Browser SSE uses the shared registry version, so agent and platform changes cannot race through separate client authorities.

## Identity and replay

Provider, account reference, model, request, attempt, runtime, logical agent, incarnation, thread, and turn remain separate fields. The inference edge stages only a bounded initial SSE window. Text, reasoning, tool/function output, and output items close replay eligibility permanently. A disconnect after that boundary is terminal evidence, not a reason to call another provider.

The edge currently chooses the exact configured provider for a model and performs no automatic retry. This is stricter than the PRD's optional safe pre-output failover and cannot duplicate semantic work.

## Secret flow

Configuration, SQLite, DTOs, events, generated routes, and support bundles store references such as `env:DEEPSEEK_API_KEY`, never their values. The edge resolves one selected reference immediately before the request and registers the resolved value with the redactor. Chat/Messages routes send only the independent LiteLLM internal capability to the translator. Provider credentials are resolved by the translator's environment and never accepted from browser or client headers.

Provider discovery resolves the selected boundary at operation time, rejects redirects, records only model IDs, and publishes none of them automatically. Support bundles deliberately omit reference names, actors, idempotency keys, request content, and raw errors.

## Generated artifacts

`platform artifacts` writes `litellm.yaml`, `routes.json`, and `manifest.json` with current-user-only modes. It refuses foreign manifests and symlinks, stages complete files, replaces only owned paths, and reads back the registry hash. The manifest binds registry, routes, and LiteLLM content hashes so file presence alone cannot report readiness.

## Explicit release boundaries

Mock compatibility never spends provider quota. Live probes, OAuth/CLI login, large local-model downloads, service installation, update, rollback, and destructive removal require separate operator authority and exact released-head evidence. Their capability-ledger entries remain release blockers until those platform-specific workflows pass the matrices in `PLATFORM_PRD.md`.
