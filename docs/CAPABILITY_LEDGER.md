# Capability adoption ledger

This ledger is the file-level companion to the normative matrix in `PLATFORM_PRD.md`. `Deferred` means the capability is not a GA claim and remains a blocking release gate.

| Capability | Disposition | Owning implementation | Evidence / release gate |
| --- | --- | --- | --- |
| Provider/model registry and configured overlay | Adopted | `src/platform/builtin-registry.ts`, `src/platform/service.ts` | validation, collision, reference-only persistence, and catalog tests |
| LiteLLM protocol translation | Adopted behind stronger edge | `src/platform/artifacts.ts`, `requirements/litellm.txt`, `.github/workflows/litellm.yml` | hash lock plus actual proxy liveliness job |
| Direct native Responses dispatch | Adopted | `src/inference/server.ts` | exact model/header/stream contract tests |
| Credential-isolating forwarding | Adopted | `src/inference/server.ts`, `src/platform/service.ts` | caller/provider/internal capability separation and canary tests |
| Request profiles and tool-history repair | Adopted and generalized | `src/platform/profiles.ts` | exact body and semantic classification fixtures |
| Empty-completion guard | Adopted | `src/inference/server.ts` | bounded SSE preflight and JSON/SSE empty tests |
| Compressed request handling | Adopted | `src/inference/server.ts` | bounded gzip test; unsupported Zstandard is truthful on older Node |
| Durable platform operations | Adopted | `src/platform/service.ts`, schema v2 in `src/store/database.ts` | event-before-projection, idempotency, stale-version tests |
| Provider discovery and conservative curation | Adopted | `src/platform/service.ts` | strict local mock, no auto-publication, terminal operation readback |
| Usage/rate-limit observation | Adopted | `src/platform/service.ts`, `src/inference/server.ts` | provider usage remains separate from estimates; freshness retained |
| Provider/model/request/operator UI | Adopted | `web/src/platform-pages.tsx`, `web/src/styles.css` | component, accessibility, responsive and reduced-motion gates |
| Generated artifact ownership/drift | Adopted | `src/platform/files.ts` | foreign owner, permissions, hash readback, rollback-safe replacement tests |
| Doctor and support bundle | Adopted for local read-only workflow | `src/platform/cli.ts`, `src/platform/files.ts` | local-only, no-upload, seeded-secret tests |
| Kimi/Grok OAuth and official CLI sessions | Deferred, Phase 3 blocker | registry identity exists; no token storage is claimed | expiry, PTY, restart, logout, and live entitlement matrix required |
| Native Codex account catalog merge | Deferred, Phase 3 blocker | native boundary is registered only | installed Codex-version catalog and isolated login tests required |
| Routed collaboration payload relay | Deferred, Phase 4 blocker | agent control plane stays authoritative | real spawn/follow-up and no-decrypted-log probes required |
| Tool-result aging and router compaction envelope | Deferred, Phase 4 blocker | no default behavior | private benchmark and corruption/long-context tests required |
| Vision bridge and transcript deduplication | Deferred, Phase 5 blocker | capability remains visibly unavailable | quota consent, dedup, provenance, and image-leak E2E required |
| Local download/benchmark/removal | Deferred, Phase 5 blocker | discovery is implemented; downloads are not | explicit consent, restart recovery, repeated agent checks required |
| Safe pre-output cross-provider failover | Superseded by stricter no-retry policy for this release | `src/inference/server.ts` | no duplicate execution; future failover requires chaos proof |
| Guided service install/update/rollback/uninstall | Deferred, Phase 7 blocker | generated artifacts and doctor only | macOS/Linux/Windows released-artifact matrix required |
| Native tray | Superseded by responsive Console | `web/src/app.tsx`, `web/src/platform-pages.tsx` | all routine/recovery capability must remain in web/CLI |
| Homebrew/winget publication | Deferred packaging decision | none | checksums, provenance, clean install, rollback evidence required |
| Reference layout and fixed ports | Rejected as authority | unified event-sourced platform | ephemeral/managed port and manifest tests |
