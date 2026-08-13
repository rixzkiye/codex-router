# Capability adoption ledger

This is the file-level companion to the normative matrix in `PLATFORM_PRD.md`. A capability can be implemented while its release evidence is still blocked. General Availability requires every externally verifiable gate below to carry current evidence for the exact released head; local tests never promote a provider, platform, or artifact by themselves.

| Capability | Disposition | Owning implementation | Implementation evidence and remaining release gate |
| --- | --- | --- | --- |
| Provider/model registry and configured overlay | Adopted | `src/platform/builtin-registry.ts`, `src/platform/service.ts`, `src/config.ts` | collision, reference-only persistence, conservative publication, and schema tests; each GA provider still needs exact-head live evidence |
| LiteLLM protocol translation | Adopted behind stronger edge | `src/platform/artifacts.ts`, `requirements/litellm.txt`, `.github/workflows/litellm.yml` | no-retry/no-fallback/no-cache generation, universal hash lock, and actual proxy boot job; hosted job must pass on the released head |
| Direct native Responses dispatch | Adopted | `src/inference/server.ts` | exact model, header, compact-route, streaming, and no-replay contracts; installed supported Codex smoke remains a release gate |
| Credential-isolating forwarding | Adopted | `src/inference/server.ts`, `src/platform/service.ts` | caller/provider/internal capabilities are separate and canary tested; independent security review remains a release gate |
| Request profiles and tool-history repair | Adopted and generalized | `src/platform/profiles.ts` | provider-specific exact-body and semantic fixtures; advertised live provider variants still require current probes |
| Empty-completion and semantic-output boundary | Adopted | `src/inference/server.ts` | bounded JSON/SSE preflight, double-empty, partial stream, and no-replay tests |
| Compressed request handling | Adopted | `src/inference/server.ts` | bounded gzip, deflate, and Brotli tests; unsupported Zstandard remains truthful when the Node runtime lacks a decoder |
| Durable platform operations | Adopted | `src/platform/service.ts`, schema v2 in `src/store/database.ts` | event-before-projection, idempotency, scoped locks, monotonic fencing, cancellation, restart reconciliation, and terminal readback tests |
| Provider discovery and conservative curation | Adopted | `src/platform/service.ts` | strict catalog authority, redirect rejection, last-known-good stale state, no auto-publication, and operation readback tests |
| Official OAuth, CLI-session, and native login ownership | Adopted | `src/platform/auth.ts`, `src/platform/service.ts`, `src/platform/cli.ts` | official CLI login/logout, isolated `CODEX_HOME`, protected-session inspection, operation locking, and safe browser handoff; expiry, entitlement, logout, and PTY live matrix remains a per-provider release gate |
| Native Codex catalog capture and merge | Adopted | `src/platform/catalog.ts`, `src/platform/service.ts` | account/client cohort, schema cloning, collision, freshness, and publication tests; supported installed Codex catalog readback remains a release gate |
| Namespaced Codex app-tool relay | Adopted | `src/platform/compatibility.ts`, `src/inference/server.ts` | allowlisted flattening, ambiguous/unknown rejection, and streamed/non-streamed namespace restoration tests; supported-client generated-schema smoke remains a release gate |
| Routed collaboration payload boundary | Adopted fail-closed | `src/platform/compatibility.ts`, `src/inference/server.ts` | native ciphertext is preserved and proven router plaintext is normalized in both request/response trees; real native spawn/follow-up/cancel probes remain a release gate before collaboration is advertised |
| Router-owned compaction envelope | Adopted | `src/platform/compatibility.ts`, `src/inference/server.ts` | bounded signed envelope, tamper rejection, provenance, and continuation expansion tests |
| Tool-result aging | Adopted behind opt-in policy | `src/platform/compatibility.ts`, `src/inference/server.ts`, `src/config.ts` | large old results are receipted while recent and error evidence remains intact; default is off until the private long-context benchmark passes |
| Governed vision bridge | Adopted behind explicit configuration | `src/platform/vision.ts`, `src/inference/server.ts` | image/tool-result traversal, concurrent deduplication, engine provenance, byte/host policy, text-model leak prevention, and gateway tests; quota/privacy and local-quality live review remains a release gate |
| Local model discovery/download/benchmark/removal | Adopted as experimental | `src/platform/local-models.ts`, `src/platform/service.ts`, `src/platform/cli.ts` | loopback-only runtime, explicit download/removal consent, progress, cancellation, measured tool call, selection, restart recovery, and browser workflow tests; released runtime/device matrix is required before GA labeling a model |
| Usage, rate-limit, quota, and versioned cost estimates | Adopted | `src/platform/service.ts`, `src/inference/server.ts`, `src/platform/routing.ts` | provider reports remain separate from estimates, sparse windows retain freshness, pricing requires source/version, and UI labels invoice truth separately |
| Routing decision evidence and pre-output failover | Superseded by a stricter single-attempt policy | `src/platform/routing.ts`, `src/inference/server.ts` | eligibility/scoring is persisted before dispatch; this release performs no automatic cross-provider retry, eliminating duplicate semantic execution by construction |
| Provider/model/request/usage/local/diagnostic UI | Adopted | `web/src/platform-pages.tsx`, `web/src/styles.css` | component, axe, keyboard, responsive, forced-color, explicit-consent, reduced-motion, and browser-contract gates; independent WCAG 2.2 AA and visual review remains a release gate |
| Generated artifact ownership and drift | Adopted | `src/platform/files.ts` | foreign owner, symlink, permissions, hash readback, complete staging, and rollback-safe replacement tests |
| Doctor and support bundle | Adopted for local read-only workflow | `src/platform/cli.ts`, `src/platform/files.ts` | local-only mode `0600`, included-file reporting, no upload, and seeded-secret tests; managed repair stays limited to explicitly owned layers |
| Guided install/update/rollback/disable/uninstall | Adopted | `src/platform/installation.ts`, `src/platform/service.ts`, `src/web/server.ts`, `src/platform/cli.ts`, `web/src/platform-pages.tsx` | read-only plan, explicit consent, transaction rollback, integrity/readiness readback, scoped locks, and manifest-owned removal tests; released-artifact Linux/macOS/Windows matrix remains a GA gate |
| Native tray and presence reminders | Superseded by responsive Console | `web/src/app.tsx`, `web/src/platform-pages.tsx` | routine and recovery authority remains complete in web/CLI; an optional thin companion owns no unique capability |
| Router-managed optional skill pack | Deferred optional capability | none | not installed implicitly; requires owned-content collision/update/uninstall tests before a later release can ship it and is not needed for core inference or control-plane GA |
| Compatible non-Codex client profiles | Deferred per client | secure Responses edge only | sharing an SDK is not a compatibility claim; each client requires an explicit catalog/route/tool/stream contract before publication |
| Homebrew/winget publication | Deferred packaging channel | none | npm/released-artifact package proof is independent; any additional channel requires checksums, provenance, clean install, and rollback evidence |
| Reference layout and fixed ports | Rejected as authority | unified event-sourced platform | ephemeral or managed ports and manifest ownership supersede source-layout and fixed-port assumptions |

## Exact-head General Availability gates

The implementation is not labeled General Availability until all of these are independently recorded for one exact commit:

1. full local `pnpm verify` and package-content inspection;
2. hosted Quality and hash-locked LiteLLM proxy jobs;
3. independent secret-canary/threat-model security review;
4. independent WCAG 2.2 AA, keyboard, narrow viewport, forced-color, reduced-motion, and visual review;
5. live provider/model compatibility for every variant and capability advertised as generally available;
6. released-artifact clean install, update, failed-update rollback, disable, and uninstall on supported Linux, macOS, and Windows hosts;
7. artifact checksum/provenance inspection and, only if claimed, deployment plus live-health proof.
