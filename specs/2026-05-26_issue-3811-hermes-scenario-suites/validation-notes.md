# Phase 8 Validation Notes

Validated locally in dry-run/plan-only mode because live Hermes sandboxes, messaging secrets, macOS Docker Desktop VM-driver runners, and in-flight PR worktrees were not available in this agent session.

Commands run:

- `E2E_DRY_RUN=1 bash test/e2e/runtime/run-suites.sh hermes-runtime`
- `E2E_DRY_RUN=1 bash test/e2e/runtime/run-suites.sh hermes-inference-switch`
- `E2E_DRY_RUN=1 bash test/e2e/runtime/run-suites.sh hermes-discord`
- `E2E_DRY_RUN=1 bash test/e2e/runtime/run-suites.sh hermes-slack`
- `E2E_DRY_RUN=1 bash test/e2e/runtime/run-suites.sh hermes-telegram`
- `E2E_DRY_RUN=1 bash test/e2e/runtime/run-suites.sh hermes-rebuild`
- `E2E_DRY_RUN=1 bash test/e2e/runtime/run-suites.sh hermes-policy`
- `E2E_DRY_RUN=1 bash test/e2e/runtime/run-suites.sh hermes-provider-compatibility`
- `E2E_DRY_RUN=1 bash test/e2e/runtime/run-suites.sh hermes-security-tui`
- `bash test/e2e/runtime/run-scenario.sh ubuntu-repo-cloud-hermes --plan-only`

Result: all dry-run suite wiring and plan-only commands passed. Live RED-on-main / GREEN-on-fix-branch validation remains gated by runner, platform, branch, and secret availability and is represented in `hermes_expectations` metadata.
