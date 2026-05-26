# Test Specification: Issue #3811 — Hermes Scenario Suite Migration

Generated from: `specs/2026-05-26_issue-3811-hermes-scenario-suites/spec.md`

## Test Strategy

Use TDD by adding failing scenario-framework tests before each suite/helper change. Prefer local dry-run/fake-provider tests for CI and reserve live messaging/provider/platform checks for declared runner/secret gated validation.

Primary existing test locations:

- `test/e2e/scenario-framework-tests/e2e-lib-helpers.test.ts`
- `test/e2e/scenario-framework-tests/e2e-suite-runner.test.ts`
- `test/e2e/scenario-framework-tests/e2e-scenario-schema.test.ts`
- `test/e2e/scenario-framework-tests/e2e-scenario-resolver.test.ts`
- `test/e2e/scenario-framework-tests/e2e-coverage-report.test.ts`
- `test/e2e/scenario-framework-tests/e2e-metadata-final-hygiene.test.ts`

## Phase 1: Add Hermes Primitive Library and Runtime Baseline - Test Guide

**Existing Tests to Modify:**

- `E2E shell helpers` in `test/e2e/scenario-framework-tests/e2e-lib-helpers.test.ts`
  - Current behavior: validates existing helper libraries source safely, fail clearly on missing context, and redact secrets.
  - Required changes: add Hermes helper source-safety, required-context, dry-run, and redaction coverage.
- `run-suites.sh` in `test/e2e/scenario-framework-tests/e2e-suite-runner.test.ts`
  - Current behavior: validates suite ordering and dry-run execution for existing suites.
  - Required changes: add `hermes-runtime` dry-run coverage and verify the runtime assertion IDs.

**New Tests to Create:**

1. `test_should_source_hermes_helpers_under_strict_shell_mode`
   - **Input**: Bash strict mode sourcing `test/e2e/validation_suites/lib/hermes.sh`.
   - **Expected**: Exit 0 and `e2e_hermes_load_context` plus baseline assertion functions are defined.
   - **Covers**: Hermes primitive library exists and is source-safe.

2. `test_should_fail_clearly_when_hermes_context_is_missing`
   - **Input**: Empty `E2E_CONTEXT_DIR` and a Hermes assertion requiring `E2E_AGENT`/`E2E_SANDBOX_NAME`.
   - **Expected**: Non-zero exit with missing key named; no shell trace or secret output.
   - **Covers**: Context-driven suites, no setup rediscovery.

3. `test_should_emit_hermes_runtime_assertion_ids_in_dry_run`
   - **Input**: Seeded Hermes `context.env`, `E2E_DRY_RUN=1`, `run-suites.sh hermes-runtime`.
   - **Expected**: Output contains `expected.hermes.runtime.gateway-health`, `agent-home`, `env-integrity`, and `security-posture`.
   - **Covers**: Stable assertion ID contract and dry-run behavior.

4. `test_should_not_emit_secret_values_from_hermes_runtime_helpers`
   - **Input**: Context containing fake provider/messaging tokens.
   - **Expected**: Output redacts or omits token values.
   - **Covers**: Secret safety.

**Test Implementation Notes:**

- Use temporary context directories as existing tests do.
- Prefer shell command override variables for live sandbox probes.
- Do not call install/onboard commands from helper tests.

## Phase 2: Encode Hermes Coverage and Expected-Outcome Metadata - Test Guide

**Existing Tests to Modify:**

- `e2e-scenario-schema.test.ts`
  - Current behavior: validates scenario metadata schemas.
  - Required changes: validate Hermes expectation metadata shape and allowed statuses.
- `e2e-coverage-report.test.ts`
  - Current behavior: validates coverage report rendering for scenarios/suites/gaps.
  - Required changes: assert Hermes expectation classifications and issue links render.
- `e2e-metadata-final-hygiene.test.ts`
  - Current behavior: checks metadata consistency.
  - Required changes: require every `expected.hermes.*` ID referenced by suites/tests to have metadata.

**New Tests to Create:**

1. `test_should_reject_unknown_hermes_expectation_status`
   - **Input**: Fixture metadata with status `maybe_later`.
   - **Expected**: Schema validation fails and names allowed statuses.
   - **Covers**: Status vocabulary.

2. `test_should_render_hermes_current_bug_expectations_in_coverage_report`
   - **Input**: Metadata including `expected_fail_current_bug` entries for known Hermes issues.
   - **Expected**: Report includes status, issue number, and related suite/assertion ID.
   - **Covers**: Product bugs are visible, not silently retired.

3. `test_should_require_metadata_for_all_expected_hermes_assertions`
   - **Input**: Suite script fixture that emits an undocumented `expected.hermes.*` ID.
   - **Expected**: Hygiene test fails with missing ID.
   - **Covers**: Assertion metadata completeness.

4. `test_should_represent_all_issue_inventory_items`
   - **Input**: Hermes expectation metadata.
   - **Expected**: Inventory issues from #3811 appear with PASS/current-bug/deferred/out-of-scope/retired classification.
   - **Covers**: Issue inventory acceptance criteria.

**Test Implementation Notes:**

- Use the top-level `hermes_expectations` section in `test/e2e/nemoclaw_scenarios/expected-states.yaml` as resolver-owned metadata.
- Keep tests metadata-focused and runnable without secrets.

## Phase 3: Migrate Hermes Inference Switching and Provider Routing - Test Guide

**Existing Tests to Modify:**

- `e2e-suite-runner.test.ts`
  - Current behavior: dry-run coverage for existing suites.
  - Required changes: add `hermes-inference-switch` dry-run assertion ID checks.
- `e2e-lib-helpers.test.ts`
  - Current behavior: covers inference routing helper behavior.
  - Required changes: add Hermes wrappers for route state, env immutability, PID stability, chat path, and timeout classification.

**New Tests to Create:**

1. `test_should_emit_hermes_inference_switch_ids_in_dry_run`
   - **Input**: Hermes cloud context and `run-suites.sh hermes-inference-switch` in dry-run.
   - **Expected**: Output includes all `expected.hermes.inference.*` IDs.
   - **Covers**: Suite wiring and stable ID contract.

2. `test_should_classify_external_timeout_separately_from_route_regression`
   - **Input**: Stubbed command override returning timeout for external provider and healthy route/config probes.
   - **Expected**: Assertion reports external/gated classification instead of product regression.
   - **Covers**: External availability cannot mask routing regressions.

3. `test_should_redact_provider_errors_from_hermes_inference_output`
   - **Input**: Stubbed command output containing fake API key/token.
   - **Expected**: Secret value absent; redaction marker present.
   - **Covers**: Secret safety.

4. `test_should_map_or_retire_legacy_inference_assertions`
   - **Input**: Hermes coverage metadata.
   - **Expected**: Legacy `test-hermes-inference-switch.sh` assertions are mapped to IDs or explicitly deferred/retired with reason.
   - **Covers**: Migration parity.

**Test Implementation Notes:**

- Reuse `validation_suites/lib/inference_routing.sh` tests where behavior is generic.
- Hermes-specific tests should focus on context/env/PID/classification wrappers.

## Phase 4: Migrate Hermes Messaging Suites - Test Guide

**Existing Tests to Modify:**

- `e2e-suite-runner.test.ts`
  - Current behavior: verifies generic messaging suite wiring.
  - Required changes: add `hermes-discord`, `hermes-slack`, and `hermes-telegram` dry-run coverage.
- `e2e-lib-helpers.test.ts`
  - Current behavior: has helper-level coverage for shared libraries.
  - Required changes: add Hermes messaging wrapper tests using fake-provider/fake-gateway fixtures.
- Metadata/schema tests
  - Required changes: validate required-secret and runner-requirement metadata for live messaging paths.

**New Tests to Create:**

1. `test_should_emit_hermes_discord_assertion_ids_in_dry_run`
   - **Input**: Hermes Discord context, `E2E_DRY_RUN=1`, `run-suites.sh hermes-discord`.
   - **Expected**: Output includes all `expected.hermes.discord.*` IDs.
   - **Covers**: Discord suite wiring.

2. `test_should_emit_hermes_slack_assertion_ids_in_dry_run`
   - **Input**: Hermes Slack context, `E2E_DRY_RUN=1`, `run-suites.sh hermes-slack`.
   - **Expected**: Output includes all `expected.hermes.slack.*` IDs.
   - **Covers**: Slack suite wiring.

3. `test_should_emit_hermes_telegram_assertion_ids_in_dry_run`
   - **Input**: Hermes Telegram context, `E2E_DRY_RUN=1`, `run-suites.sh hermes-telegram`.
   - **Expected**: Output includes all `expected.hermes.telegram.*` IDs.
   - **Covers**: Telegram suite wiring.

4. `test_should_not_log_messaging_secrets_from_hermes_suites`
   - **Input**: Context/config content containing fake Slack/Discord/Telegram secrets.
   - **Expected**: No raw credentials in stdout/stderr or artifacts.
   - **Covers**: Secret leakage acceptance criteria.

5. `test_should_mark_live_messaging_paths_with_required_secrets`
   - **Input**: Scenario/suite metadata for live provider tests.
   - **Expected**: Required secret metadata exists, and tests skip/gate when absent.
   - **Covers**: Explicit live-secret requirements.

6. `test_should_classify_known_messaging_product_bugs`
   - **Input**: Hermes expectation metadata.
   - **Expected**: #3893, #4070, #4189, #3582, and applicable #4246 are expected-fail/deferred/out-of-scope as specified.
   - **Covers**: Current bug visibility.

**Test Implementation Notes:**

- Use existing fake fixture scripts where possible.
- Treat live gateway/API tests as gated validation, not required unit/scenario-framework tests.

## Phase 5: Migrate Hermes Rebuild and Durable State - Test Guide

**Existing Tests to Modify:**

- `e2e-suite-runner.test.ts`
  - Required changes: add `hermes-rebuild` dry-run coverage.
- `e2e-lib-helpers.test.ts`
  - Required changes: add command-override tests for credential reuse, config preservation, port-forward release, and post-rebuild health.

**New Tests to Create:**

1. `test_should_emit_hermes_rebuild_assertion_ids_in_dry_run`
   - **Input**: Hermes context and `run-suites.sh hermes-rebuild` in dry-run.
   - **Expected**: Output contains all `expected.hermes.rebuild.*` IDs.
   - **Covers**: Rebuild suite wiring.

2. `test_should_detect_gateway_credential_reuse_when_host_env_empty`
   - **Input**: Stubbed gateway credential command succeeds; host env variable missing.
   - **Expected**: Credential reuse assertion passes and does not print the credential.
   - **Covers**: #3895 expected behavior and secret safety.

3. `test_should_detect_messaging_config_hash_preservation`
   - **Input**: Pre/post rebuild config hash fixtures.
   - **Expected**: Preserved hash passes; changed hash fails with stable ID.
   - **Covers**: Durable messaging state.

4. `test_should_record_current_bug_expectations_for_rebuild_issues`
   - **Input**: Hermes metadata.
   - **Expected**: #3895 and applicable #4146 have expected current status and linked evidence.
   - **Covers**: Known rebuild bug visibility.

**Test Implementation Notes:**

- Keep generic rebuild behavior in shared helper tests; Hermes tests should cover domain-specific state only.

## Phase 6: Migrate Hermes Policy, Provider Compatibility, Security, and TUI Coverage - Test Guide

**Existing Tests to Modify:**

- `e2e-suite-runner.test.ts`
  - Required changes: add dry-run coverage for `hermes-policy`, `hermes-provider-compatibility`, and `hermes-security-tui`.
- `e2e-lib-helpers.test.ts`
  - Required changes: add helper tests for policy path classification, provider failure classification, shields, and TUI history assertions.
- Metadata/schema tests
  - Required changes: enforce platform runner requirements for macOS/VM-driver scenarios.

**New Tests to Create:**

1. `test_should_emit_hermes_policy_assertion_ids_in_dry_run`
   - **Input**: Hermes context and `run-suites.sh hermes-policy`.
   - **Expected**: Output includes all `expected.hermes.policy.*` IDs.
   - **Covers**: Policy suite wiring.

2. `test_should_emit_hermes_provider_compatibility_ids_in_dry_run`
   - **Input**: Hermes provider contexts and `run-suites.sh hermes-provider-compatibility`.
   - **Expected**: Output includes all `expected.hermes.provider.*` IDs.
   - **Covers**: Provider compatibility suite wiring.

3. `test_should_emit_hermes_security_tui_ids_in_dry_run`
   - **Input**: Hermes context and `run-suites.sh hermes-security-tui`.
   - **Expected**: Output includes shields and TUI IDs.
   - **Covers**: Security/TUI suite wiring.

4. `test_should_classify_anthropic_messages_path_policy`
   - **Input**: Policy fixture with/without `/v1/messages` egress.
   - **Expected**: Missing required path fails with stable ID and classification.
   - **Covers**: #4230 policy behavior.

5. `test_should_require_macos_runner_for_vm_driver_shields_scenario`
   - **Input**: macOS Docker Desktop shields scenario metadata.
   - **Expected**: `runner_requirements` includes platform/driver requirement.
   - **Covers**: Platform-specific gating.

6. `test_should_classify_policy_provider_security_tui_known_bugs`
   - **Input**: Hermes expectation metadata.
   - **Expected**: #3981 pass, #4230/#4232/#4245/#3225/#2432 expected-fail or gated as specified.
   - **Covers**: Remaining issue inventory.

**Test Implementation Notes:**

- Tests should not require macOS or live external providers; validate metadata and command override paths locally.

## Phase 7: Integrate Scenario Plans and Verify Plan-Only Compatibility - Test Guide

**Existing Tests to Modify:**

- `e2e-scenario-resolver.test.ts`
  - Required changes: ensure all Hermes scenarios and suite families resolve.
- `e2e-scenarios-workflow.test.ts` or existing plan-only tests
  - Required changes: verify `run-scenario.sh <id> --plan-only` includes expected Hermes suites.
- `e2e-suite-runner.test.ts`
  - Required changes: ensure suites do not run setup rediscovery/onboarding.

**New Tests to Create:**

1. `test_should_resolve_all_hermes_scenario_plans`
   - **Input**: Scenario metadata after Hermes suites are attached.
   - **Expected**: Resolver returns valid plans for all Hermes scenarios.
   - **Covers**: Scenario matrix integration.

2. `test_should_include_hermes_suites_in_plan_only_output`
   - **Input**: `run-scenario.sh ubuntu-repo-cloud-hermes --plan-only` and provider-specific Hermes scenarios.
   - **Expected**: Plan includes relevant Hermes suite families and metadata.
   - **Covers**: Plan-only compatibility.

3. `test_should_not_execute_setup_commands_from_validation_suites`
   - **Input**: Dry-run suite output and suite script source scan.
   - **Expected**: No install/onboard/setup rediscovery commands in suites.
   - **Covers**: Separation of setup and validation.

4. `test_should_gate_suite_execution_on_expected_state`
   - **Input**: Scenario fixture with unmet expected state.
   - **Expected**: Suite execution is skipped/failed according to existing expected-state semantics.
   - **Covers**: Expected-state validation compatibility.

**Test Implementation Notes:**

- Use existing resolver fixtures where possible and avoid adding broad integration tests that duplicate runner behavior.

## Phase 8: Validate Against Main and In-Flight Fix PRs - Test Guide

**Existing Tests to Modify:**

- No source tests required unless validation exposes mismatched metadata or suite bugs.

**New Tests to Create:**

1. `test_should_capture_expected_bug_reproduction_evidence_for_high_risk_assertions`
   - **Input**: Local validation notes or CI artifacts from targeted scenarios.
   - **Expected**: Evidence references current main result and expected status.
   - **Covers**: RED-on-main validation for open bugs.

2. `test_should_update_expectation_metadata_when_fix_branch_flips_green`
   - **Input**: Result from targeted fix branch run.
   - **Expected**: Metadata status remains expected-fail until fix lands, or is updated to expected-pass with evidence after merge.
   - **Covers**: Metadata reality check.

**Test Implementation Notes:**

- Treat these as validation evidence rather than mandatory CI unit tests.
- Run only where branch, runner, and secret requirements are available.

## Phase 9: Clean the House - Test Guide

**Existing Tests to Modify:**

- `e2e-convention-lint.test.ts`
  - Required changes: add conventions for new Hermes suite scripts if not already covered.
- Docs validation tests if docs are touched.
- `e2e-metadata-final-hygiene.test.ts`
  - Required changes: ensure no completed Hermes migration TODOs remain in metadata/docs.

**New Tests to Create:**

1. `test_should_not_leave_unmapped_legacy_hermes_assertions`
   - **Input**: Migration metadata/docs.
   - **Expected**: Legacy Hermes assertions are mapped, deferred, out-of-scope, or retired with evidence.
   - **Covers**: Final migration hygiene.

2. `test_should_document_hermes_helper_extension_path`
   - **Input**: E2E docs.
   - **Expected**: Docs reference the Hermes primitive layer and how to add new suite assertions.
   - **Covers**: Contributor guidance.

3. `test_should_pass_shell_conventions_for_new_hermes_scripts`
   - **Input**: New `test/e2e/validation_suites/hermes/**/*.sh` scripts.
   - **Expected**: Existing shell/convention checks pass; scripts are executable and have SPDX headers if required by project conventions.
   - **Covers**: Maintainability.

**Test Implementation Notes:**

- Do not delete legacy scripts unless parity evidence and project policy allow it.
- Prefer metadata/docs cleanup over broad code churn.

## Recommended Test Command Matrix

Run targeted tests as phases are implemented:

```bash
npm test -- test/e2e/scenario-framework-tests/e2e-lib-helpers.test.ts
npm test -- test/e2e/scenario-framework-tests/e2e-suite-runner.test.ts
npm test -- test/e2e/scenario-framework-tests/e2e-scenario-schema.test.ts
npm test -- test/e2e/scenario-framework-tests/e2e-scenario-resolver.test.ts
npm test -- test/e2e/scenario-framework-tests/e2e-coverage-report.test.ts
npm test -- test/e2e/scenario-framework-tests/e2e-metadata-final-hygiene.test.ts
```

For local suite wiring:

```bash
E2E_DRY_RUN=1 bash test/e2e/runtime/run-suites.sh hermes-runtime
E2E_DRY_RUN=1 bash test/e2e/runtime/run-suites.sh hermes-inference-switch
E2E_DRY_RUN=1 bash test/e2e/runtime/run-suites.sh hermes-discord
E2E_DRY_RUN=1 bash test/e2e/runtime/run-suites.sh hermes-slack
E2E_DRY_RUN=1 bash test/e2e/runtime/run-suites.sh hermes-telegram
bash test/e2e/runtime/run-scenario.sh ubuntu-repo-cloud-hermes --plan-only
```
