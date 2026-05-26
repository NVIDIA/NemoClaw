# Validation Plan: Issue #3811 — Hermes Scenario Suite Migration

Generated from: `specs/2026-05-26_issue-3811-hermes-scenario-suites/spec.md`
Test Spec: `specs/2026-05-26_issue-3811-hermes-scenario-suites/tests.md`

## Overview

**Feature**: Migrate Hermes E2E behavior from legacy scripts into layered scenario validation suites with Hermes primitives, stable assertion IDs, expected-outcome metadata, and plan-only compatibility.

**Available Tools**: Bash, npm/Vitest, scenario runner scripts, dry-run mode, fake provider/gateway fixtures, metadata resolver tests, optional `gh` for PR/issue evidence.

## Coverage Summary

- Happy Paths: 8 scenarios
- Sad Paths: 7 scenarios
- Total: 15 scenarios

---

## Phase 1: Hermes Primitive Library and Runtime Baseline - Validation Scenarios

### Scenario 1.1: Hermes runtime suite emits baseline assertion IDs [STATUS: pending]
**Type**: Happy Path

**Given**: A seeded `$E2E_CONTEXT_DIR/context.env` for a running Hermes sandbox
**When**: `E2E_DRY_RUN=1 bash test/e2e/runtime/run-suites.sh hermes-runtime` runs
**Then**: The suite succeeds and emits `expected.hermes.runtime.gateway-health`, `expected.hermes.runtime.agent-home`, `expected.hermes.runtime.env-integrity`, and `expected.hermes.runtime.security-posture`

**Validation Steps**:
1. **Setup**: Bash: create temporary context with `E2E_AGENT=hermes`, gateway URL, sandbox name, and running state.
2. **Execute**: Bash: run `E2E_DRY_RUN=1 bash test/e2e/runtime/run-suites.sh hermes-runtime`.
3. **Verify**: Bash/Vitest: assert exit 0, all four IDs present, and no install/onboard command appears.

**Tools Required**: Bash, `run-suites.sh`, Vitest optional

### Scenario 1.2: Hermes helpers fail clearly without required context [STATUS: pending]
**Type**: Sad Path

**Given**: `$E2E_CONTEXT_DIR` exists but `context.env` is missing or lacks required Hermes keys
**When**: A Hermes runtime assertion is invoked
**Then**: The assertion fails with the missing key named and does not perform setup rediscovery

**Validation Steps**:
1. **Setup**: Bash: create empty temporary context directory.
2. **Execute**: Bash: source `lib/hermes.sh` and invoke a context-dependent assertion.
3. **Verify**: Bash/Vitest: assert non-zero exit, diagnostic mentions `context.env` or missing key, and no install/onboard output appears.

**Tools Required**: Bash, Vitest optional

### Scenario 1.3: Hermes helper output redacts secrets [STATUS: pending]
**Type**: Sad Path

**Given**: Context and command output contain fake Slack/Discord/provider token values
**When**: Hermes helper assertions run in dry-run or stubbed live mode
**Then**: Raw secret values are absent from stdout/stderr and any artifacts

**Validation Steps**:
1. **Setup**: Bash: seed context with fake token values and stub command output containing those values.
2. **Execute**: Bash: run representative Hermes runtime/messaging/inference helpers.
3. **Verify**: Bash/Vitest: assert raw token strings are absent and redaction markers or safe summaries are present.

**Tools Required**: Bash, Vitest

---

## Phase 2: Hermes Coverage and Expected-Outcome Metadata - Validation Scenarios

### Scenario 2.1: Coverage report renders Hermes expectation classifications [STATUS: pending]
**Type**: Happy Path

**Given**: Hermes expectation metadata includes expected pass, expected current bug, deferred/gated, out-of-scope, and retired statuses
**When**: The E2E coverage report is rendered
**Then**: The report shows Hermes assertion IDs, statuses, and issue links for current bugs

**Validation Steps**:
1. **Setup**: Bash: ensure metadata includes representative entries for each allowed status.
2. **Execute**: npm/Vitest: run `npm test -- test/e2e/scenario-framework-tests/e2e-coverage-report.test.ts`.
3. **Verify**: Vitest: assert rendered markdown includes status names, `expected.hermes.*` IDs, and issue numbers.

**Tools Required**: npm, Vitest

### Scenario 2.2: Invalid Hermes expectation status is rejected [STATUS: pending]
**Type**: Sad Path

**Given**: A metadata fixture contains an unsupported Hermes expectation status
**When**: Schema/resolver validation runs
**Then**: Validation fails and names the allowed status vocabulary

**Validation Steps**:
1. **Setup**: Vitest fixture: inject status such as `maybe_later`.
2. **Execute**: npm/Vitest: run schema validation test.
3. **Verify**: Vitest: assert non-success validation with clear allowed-status message.

**Tools Required**: npm, Vitest

### Scenario 2.3: Every emitted Hermes assertion has metadata [STATUS: pending]
**Type**: Sad Path

**Given**: A suite emits an `expected.hermes.*` assertion ID
**When**: Metadata hygiene tests scan suites and expectation metadata
**Then**: Any missing metadata entry fails the test with the missing ID named

**Validation Steps**:
1. **Setup**: Vitest fixture or real suite metadata with emitted IDs.
2. **Execute**: npm/Vitest: run `e2e-metadata-final-hygiene.test.ts`.
3. **Verify**: Vitest: assert all IDs are covered; fixture missing ID fails.

**Tools Required**: npm, Vitest

---

## Phase 3: Hermes Inference Switching and Provider Routing - Validation Scenarios

### Scenario 3.1: Hermes inference switch suite separates route checks from external provider availability [STATUS: pending]
**Type**: Happy Path

**Given**: Hermes context has healthy route/config state and the external provider probe is stubbed to timeout
**When**: `hermes-inference-switch` runs
**Then**: Route/config assertions pass and timeout is classified as external/gated, not as a product routing regression

**Validation Steps**:
1. **Setup**: Bash: seed context and set helper command override variables for healthy route checks plus timeout external call.
2. **Execute**: Bash: run `E2E_DRY_RUN=1` or stubbed live `run-suites.sh hermes-inference-switch`.
3. **Verify**: Bash/Vitest: assert all `expected.hermes.inference.*` IDs are emitted and timeout classification is explicit.

**Tools Required**: Bash, `run-suites.sh`, Vitest optional

### Scenario 3.2: Provider error output cannot leak credentials [STATUS: pending]
**Type**: Sad Path

**Given**: A stubbed provider failure returns a message containing a fake API key
**When**: Hermes inference assertions record the failure
**Then**: The output redacts the key and still reports the stable assertion ID

**Validation Steps**:
1. **Setup**: Bash: configure command override with fake secret in stderr/stdout.
2. **Execute**: Bash: run the inference helper or suite.
3. **Verify**: Bash/Vitest: assert secret absent and stable ID present.

**Tools Required**: Bash, Vitest

---

## Phase 4: Hermes Messaging Suites - Validation Scenarios

### Scenario 4.1: Hermes Discord, Slack, and Telegram suites run in dry-run/fake mode [STATUS: pending]
**Type**: Happy Path

**Given**: Provider-specific Hermes contexts and fake provider/gateway fixtures are available
**When**: `hermes-discord`, `hermes-slack`, and `hermes-telegram` run in dry-run/fake mode
**Then**: Each suite exits successfully and emits its required `expected.hermes.<provider>.*` IDs

**Validation Steps**:
1. **Setup**: Bash: seed context for Discord, Slack, and Telegram in turn; configure fake fixture paths where needed.
2. **Execute**: Bash: run `E2E_DRY_RUN=1 bash test/e2e/runtime/run-suites.sh <suite>` for each provider.
3. **Verify**: Bash/Vitest: assert provider-specific IDs present and no generic unrelated suite IDs appear.

**Tools Required**: Bash, fake provider fixtures, `run-suites.sh`, Vitest optional

### Scenario 4.2: Live messaging paths are gated when secrets are absent [STATUS: pending]
**Type**: Sad Path

**Given**: A live Slack/Discord/Telegram scenario lacks required provider secrets
**When**: The live messaging suite or scenario plan is evaluated
**Then**: The path is skipped/gated with required-secret metadata rather than failing as a product regression

**Validation Steps**:
1. **Setup**: Bash/metadata: create scenario context without live provider secrets.
2. **Execute**: Bash: run plan-only or dry-run suite with live path selected.
3. **Verify**: Bash/Vitest: assert required-secret gating message and no raw secret placeholder leak.

**Tools Required**: Bash, resolver metadata tests

### Scenario 4.3: Known messaging bugs remain visible as expected current failures [STATUS: pending]
**Type**: Sad Path

**Given**: Hermes expectation metadata includes known messaging bugs (#3893, #4070, #4189, #3582, and applicable #4246)
**When**: Coverage/reporting and metadata tests run
**Then**: Those bugs are classified as expected current failures, deferred/gated, or out-of-scope with evidence; none are silently retired

**Validation Steps**:
1. **Setup**: Metadata: ensure issue entries exist.
2. **Execute**: npm/Vitest: run coverage and hygiene tests.
3. **Verify**: Vitest: assert issue IDs, statuses, and reasons are present.

**Tools Required**: npm, Vitest

---

## Phase 5: Hermes Rebuild and Durable State - Validation Scenarios

### Scenario 5.1: Hermes rebuild suite preserves domain-specific durable state [STATUS: pending]
**Type**: Happy Path

**Given**: Stubbed pre/post rebuild state includes gateway credential availability, messaging config hashes, released dashboard forward, and healthy post-rebuild sandbox
**When**: `hermes-rebuild` runs with command overrides
**Then**: The suite emits and passes all `expected.hermes.rebuild.*` IDs without duplicating generic rebuild assertions

**Validation Steps**:
1. **Setup**: Bash: seed Hermes context and command overrides for pre/post states.
2. **Execute**: Bash: run `E2E_DRY_RUN=1` or stubbed live `run-suites.sh hermes-rebuild`.
3. **Verify**: Bash/Vitest: assert rebuild IDs are present and no credential value appears.

**Tools Required**: Bash, `run-suites.sh`, Vitest optional

### Scenario 5.2: Rebuild current bugs are expected failures until fixed [STATUS: pending]
**Type**: Sad Path

**Given**: Metadata represents #3895 and applicable #4146 as current bugs or fixed/pass based on evidence
**When**: Coverage and metadata hygiene tests run
**Then**: The report links the issues/PRs and does not mark known failures as retired without evidence

**Validation Steps**:
1. **Setup**: Metadata: include rebuild bug entries and linked evidence.
2. **Execute**: npm/Vitest: run coverage/hygiene tests.
3. **Verify**: Vitest: assert status and evidence are rendered.

**Tools Required**: npm, Vitest

---

## Phase 6: Hermes Policy, Provider Compatibility, Security, and TUI - Validation Scenarios

### Scenario 6.1: Remaining Hermes suite families emit stable IDs [STATUS: pending]
**Type**: Happy Path

**Given**: Hermes contexts for policy, provider compatibility, security, and TUI suites
**When**: `hermes-policy`, `hermes-provider-compatibility`, and `hermes-security-tui` run in dry-run/stubbed mode
**Then**: Each suite exits successfully and emits its required stable IDs

**Validation Steps**:
1. **Setup**: Bash: seed Hermes context and any provider/platform fixture values.
2. **Execute**: Bash: run each suite through `run-suites.sh` with `E2E_DRY_RUN=1`.
3. **Verify**: Bash/Vitest: assert policy/provider/security/tui IDs appear.

**Tools Required**: Bash, `run-suites.sh`, Vitest optional

### Scenario 6.2: Platform-specific security checks require matching runners [STATUS: pending]
**Type**: Sad Path

**Given**: macOS Docker Desktop VM-driver shields assertions are configured
**When**: Scenario metadata is validated on a non-macOS/non-VM-driver context
**Then**: The scenario is gated by runner requirements instead of running and failing spuriously

**Validation Steps**:
1. **Setup**: Metadata: define macOS/VM-driver scenario requirements.
2. **Execute**: npm/Vitest: run schema/resolver tests.
3. **Verify**: Vitest: assert runner requirements are present and unmet runners skip/gate.

**Tools Required**: npm, Vitest

### Scenario 6.3: Provider/policy/TUI known bugs are classified explicitly [STATUS: pending]
**Type**: Sad Path

**Given**: Metadata covers #3981, #4230, #4232, #4245, #3225, and #2432
**When**: Coverage report renders
**Then**: Landed fixes are expected-pass, open bugs are expected-fail or gated, and issue evidence is visible

**Validation Steps**:
1. **Setup**: Metadata: include all remaining issue entries.
2. **Execute**: npm/Vitest: run coverage tests.
3. **Verify**: Vitest: assert statuses and issue links match current evidence.

**Tools Required**: npm, Vitest

---

## Phase 7: Scenario Plan Integration and Plan-Only Compatibility - Validation Scenarios

### Scenario 7.1: Hermes scenario plans resolve and include expected suites [STATUS: pending]
**Type**: Happy Path

**Given**: Hermes suites are attached to relevant setup scenarios/test plans
**When**: `bash test/e2e/runtime/run-scenario.sh ubuntu-repo-cloud-hermes --plan-only` and provider-specific Hermes plan-only commands run
**Then**: Plans resolve successfully, include expected Hermes suites, and preserve existing expected-state gating

**Validation Steps**:
1. **Setup**: Metadata: ensure Hermes scenario/test plan entries are present.
2. **Execute**: Bash: run plan-only commands for base and provider-specific Hermes scenarios.
3. **Verify**: Bash/Vitest: assert exit 0 and suite list contains expected Hermes suite families.

**Tools Required**: Bash, `run-scenario.sh`, resolver tests

### Scenario 7.2: Validation suites do not perform install/onboard/setup rediscovery [STATUS: pending]
**Type**: Sad Path

**Given**: Hermes validation suite scripts are implemented
**When**: Convention tests or source scans inspect suite scripts
**Then**: Scripts do not call install/onboard flows or rediscover setup state; they consume context only

**Validation Steps**:
1. **Setup**: Bash/Vitest: collect `test/e2e/validation_suites/hermes/**/*.sh`.
2. **Execute**: npm/Vitest: run convention/source-scan test.
3. **Verify**: Vitest: assert prohibited commands/patterns are absent and `context.env` usage is present.

**Tools Required**: npm, Vitest

---

## Phase 8: Main and Fix-Branch Evidence - Validation Scenarios

### Scenario 8.1: High-risk current bugs reproduce red on main and flip on fix branches where practical [STATUS: pending]
**Type**: Happy Path

**Given**: Runner/platform/secrets are available for selected high-risk current-bug scenarios and optional fix branches exist
**When**: The same targeted suite runs against main-equivalent code and a relevant fix branch
**Then**: Main produces expected current failure and the fix branch flips to pass where the PR is intended to fix the behavior

**Validation Steps**:
1. **Setup**: Bash/git/gh: checkout main-equivalent and selected fix branch worktrees where available.
2. **Execute**: Bash: run targeted `run-suites.sh` or `run-scenario.sh` commands.
3. **Verify**: Bash/manual evidence: record assertion status, issue/PR, runner requirements, and artifact path.

**Tools Required**: Bash, git, optional `gh`, scenario runner, live/fake provider fixtures

---

## Phase 9: Migration Cleanup and Documentation - Validation Scenarios

### Scenario 9.1: Final metadata/docs leave no unmapped Hermes migration debris [STATUS: pending]
**Type**: Happy Path

**Given**: Hermes suite migration is complete
**When**: Metadata hygiene, convention lint, and docs validation run
**Then**: Legacy Hermes assertions are mapped/deferred/out-of-scope/retired with evidence, docs explain the new helper path, and no stale migration TODOs remain for completed work

**Validation Steps**:
1. **Setup**: Repo with final suite, metadata, and docs changes.
2. **Execute**: npm/Bash: run scenario framework tests, convention lint, shell checks, and docs validation if touched.
3. **Verify**: Test output: all checks pass and coverage report matches remaining gaps.

**Tools Required**: npm, Bash, docs validation tools if touched

---

## Summary

| Phase | Happy | Sad | Total | Passed | Failed | Pending |
|-------|-------|-----|-------|--------|--------|---------|
| Phase 1 | 1 | 2 | 3 | 0 | 0 | 3 |
| Phase 2 | 1 | 2 | 3 | 0 | 0 | 3 |
| Phase 3 | 1 | 1 | 2 | 0 | 0 | 2 |
| Phase 4 | 1 | 2 | 3 | 0 | 0 | 3 |
| Phase 5 | 1 | 1 | 2 | 0 | 0 | 2 |
| Phase 6 | 1 | 2 | 3 | 0 | 0 | 3 |
| Phase 7 | 1 | 1 | 2 | 0 | 0 | 2 |
| Phase 8 | 1 | 0 | 1 | 0 | 0 | 1 |
| Phase 9 | 1 | 0 | 1 | 0 | 0 | 1 |
| **Total** | **8** | **7** | **15** | **0** | **0** | **15** |
