# Contributing to Codex Router

Thanks for helping improve Codex Router.

## Development setup

Requirements:

- Node.js 22.13 or newer
- pnpm 10.33.2
- Native build support for `better-sqlite3` when a prebuilt binary is unavailable

Install dependencies and run the local gate:

```bash
pnpm install --frozen-lockfile
pnpm verify
pnpm test:coverage
npm pack --dry-run --json
```

Live Codex App Server and provider checks require credentials and remain operator-run. Never add credentials, resolved `CODEX_HOME` paths, or production data to fixtures or logs.

## Pull requests

1. Open an issue first for substantial behavior or protocol changes.
2. Create a focused branch from `main`.
3. Add or update tests for observable behavior.
4. Preserve the repository invariants in `AGENTS.md`.
5. Run the complete local gate and describe any skipped runtime checks.
6. Open a focused pull request with a clear rationale and verification evidence.

Keep commits reviewable and avoid unrelated formatting or dependency churn. Protocol changes must be validated against generated types from the supported Codex App Server version.

By contributing, you agree that your contributions will be licensed under the MIT License.
