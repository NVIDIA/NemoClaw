// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import YAML from "yaml";

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const DEFAULT_WORKFLOW_PATH = join(REPO_ROOT, ".github", "workflows", "e2e.yaml");
const DEFAULT_FIXTURE_PATH = join(
  REPO_ROOT,
  "tools",
  "e2e",
  "hermes-gpu-docker-runtime-fixture.sh",
);
const JOB_NAME = "hermes-gpu-startup";
const CHECKOUT_ACTION = "actions/checkout@df4cb1c069e1874edd31b4311f1884172cec0e10";
const PR_CHECKOUT_REF = "${{ inputs.checkout_sha || github.sha }}";
const TRUSTED_CHECKOUT_STEP_NAME = "Checkout trusted Hermes GPU runtime fixture";
const TRUSTED_INSTALL_STEP_NAME = "Install trusted Hermes GPU runtime fixture";
const TRUSTED_CLEANUP_STEP_NAME = "Remove trusted Hermes GPU runtime fixture";
const REASSERT_NODE_STEP_NAME = "Reassert trusted Node runtime";
const SETUP_NODE_ACTION = "actions/setup-node@48b55a011bda9f5d6aeb4c2d9c7362e8dae4041e";
const TRUSTED_CHECKOUT_PATH =
  ".trusted-hermes-gpu-fixture-${{ github.run_id }}-${{ github.run_attempt }}";
const TRUSTED_FIXTURE_SOURCE = "tools/e2e/hermes-gpu-docker-runtime-fixture.sh";
const TRUSTED_FIXTURE_PATH =
  "/usr/local/libexec/nemoclaw/hermes-gpu-docker-runtime-fixture.${GITHUB_RUN_ID}.${GITHUB_RUN_ATTEMPT}.${E2E_HERMES_GPU_STARTUP_SCENARIO}";
const FALLBACK_STEP_IF = "${{ matrix.scenario == 'fallback' }}";
const TRUSTED_BASH_SHELL = "/bin/bash --noprofile --norc -e -o pipefail {0}";
const RUN_STEP_NAME = "Run Hermes GPU startup live Vitest test";
const RECOVERY_STEP_NAME = "Recover Docker daemon after Hermes GPU fallback fixture";
const LEGACY_PREPARE_STEP_NAME = "Prepare no-GPU native fallback fixture";
const LEGACY_RESTORE_STEP_NAME = "Restore Docker default runtime after fallback fixture";
const UPLOAD_STEP_NAME = "Upload Hermes GPU startup artifacts";
const DOCKER_AUTH_STEP_NAME = "Authenticate to Docker Hub";
const HOSTED_PROVIDER_ENV_NAMES = [
  "COMPATIBLE_API_KEY",
  "NEMOCLAW_E2E_USE_HOSTED_INFERENCE",
  "NVIDIA_API_KEY",
  "NVIDIA_INFERENCE_API_KEY",
] as const;
const SECRET_REFERENCE_PATTERN = /\bsecrets\.[A-Za-z0-9_]+\b/u;
const EXPECTED_SELECTOR =
  "${{ github.repository == 'NVIDIA/NemoClaw' && github.event_name == 'workflow_dispatch' && github.ref == 'refs/heads/main' && (contains(format(',{0},', inputs.jobs), ',hermes-gpu-startup,') || contains(format(',{0},', inputs.targets), ',hermes-gpu-startup,')) }}";

type WorkflowRecord = Record<string, unknown>;
type WorkflowStep = WorkflowRecord & {
  name?: string;
  run?: string;
};

function asRecord(value: unknown): WorkflowRecord {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as WorkflowRecord)
    : {};
}

function asSteps(value: unknown): WorkflowStep[] {
  return Array.isArray(value) ? (value as WorkflowStep[]) : [];
}

function stringValue(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function normalizedShell(value: unknown): string {
  return stringValue(value)
    .replace(/\\\r?\n/gu, " ")
    .replace(/\s+/gu, " ")
    .trim();
}

export function validateHermesGpuStartupWorkflowBoundary(
  workflowPath = DEFAULT_WORKFLOW_PATH,
  fixturePath = DEFAULT_FIXTURE_PATH,
): string[] {
  const workflow = asRecord(YAML.parse(readFileSync(workflowPath, "utf8")));
  const job = asRecord(asRecord(workflow.jobs)[JOB_NAME]);
  const errors: string[] = [];
  if (Object.keys(job).length === 0) {
    return [`workflow missing ${JOB_NAME} job`];
  }

  if (job["runs-on"] !== "linux-amd64-gpu-rtxpro6000-latest-1") {
    errors.push(`${JOB_NAME} job must run on the native RTX PRO 6000 GPU runner`);
  }
  if (job.needs !== "generate-matrix" || job.if !== EXPECTED_SELECTOR) {
    errors.push(`${JOB_NAME} job must remain explicit-only behind generate-matrix`);
  }
  if (job["timeout-minutes"] !== 90) {
    errors.push(`${JOB_NAME} job must keep the 90 minute timeout`);
  }
  const strategy = asRecord(job.strategy);
  const matrix = asRecord(strategy.matrix);
  if (strategy["fail-fast"] !== false) {
    errors.push(`${JOB_NAME} strategy must keep fail-fast disabled`);
  }
  if (strategy["max-parallel"] !== 1) {
    errors.push(`${JOB_NAME} strategy must serialize GPU scenarios`);
  }
  if (
    !Array.isArray(matrix.scenario) ||
    matrix.scenario.length !== 3 ||
    matrix.scenario[0] !== "native" ||
    matrix.scenario[1] !== "fallback" ||
    matrix.scenario[2] !== "compatibility-only"
  ) {
    errors.push(
      `${JOB_NAME} matrix must run exactly the native, fallback, and compatibility-only scenarios`,
    );
  }

  const jobEnv = asRecord(job.env);
  const requiredEnv = {
    E2E_ARTIFACT_DIR:
      "${{ github.workspace }}/e2e-artifacts/live/hermes-gpu-startup/${{ matrix.scenario }}",
    E2E_HERMES_GPU_STARTUP_SCENARIO: "${{ matrix.scenario }}",
    E2E_JOB: "1",
    E2E_TARGET_ID: JOB_NAME,
    NEMOCLAW_AGENT: "hermes",
    NEMOCLAW_RUN_LIVE_E2E: "1",
    NEMOCLAW_SANDBOX_GPU: "1",
    NEMOCLAW_SANDBOX_NAME: "e2e-hermes-gpu-startup-${{ matrix.scenario }}",
  } as const;
  for (const [name, expected] of Object.entries(requiredEnv)) {
    if (jobEnv[name] !== expected) {
      errors.push(`${JOB_NAME} job must set ${name}=${expected}`);
    }
  }
  if (Object.hasOwn(jobEnv, "E2E_DEFAULT_ENABLED")) {
    errors.push(
      `${JOB_NAME} job must not set E2E_DEFAULT_ENABLED; the trusted inventory owns its explicit-only classification`,
    );
  }
  if (Object.hasOwn(jobEnv, "NEMOCLAW_DOCKER_GPU_PATCH")) {
    errors.push(
      `${JOB_NAME} job must leave NEMOCLAW_DOCKER_GPU_PATCH unset so the scenario harness owns route selection`,
    );
  }
  for (const name of HOSTED_PROVIDER_ENV_NAMES) {
    if (Object.hasOwn(jobEnv, name)) {
      errors.push(`${JOB_NAME} job env must not expose ${name}`);
    }
  }
  if (SECRET_REFERENCE_PATTERN.test(JSON.stringify(jobEnv))) {
    errors.push(`${JOB_NAME} job env must not consume repository secrets`);
  }

  const steps = asSteps(job.steps);
  for (const step of steps) {
    const stepName = step.name ?? "<unnamed>";
    const stepEnv = asRecord(step.env);
    for (const name of HOSTED_PROVIDER_ENV_NAMES) {
      if (Object.hasOwn(stepEnv, name)) {
        errors.push(`${JOB_NAME} step '${stepName}' must not expose ${name}`);
      }
    }
    if (stepName !== DOCKER_AUTH_STEP_NAME && SECRET_REFERENCE_PATTERN.test(JSON.stringify(step))) {
      errors.push(`${JOB_NAME} step '${stepName}' must not consume repository secrets`);
    }
    if (stringValue(step.run).includes("test/e2e/live/hermes-e2e.test.ts")) {
      errors.push(`${JOB_NAME} step '${stepName}' must not run the hosted Hermes E2E test`);
    }
  }

  const prCheckoutIndex = steps.findIndex((step) => {
    const checkoutWith = asRecord(step.with);
    return step.uses === CHECKOUT_ACTION && checkoutWith.ref === PR_CHECKOUT_REF;
  });
  const trustedCheckoutIndex = steps.findIndex((step) => step.name === TRUSTED_CHECKOUT_STEP_NAME);
  const trustedCheckout = steps[trustedCheckoutIndex];
  if (!trustedCheckout) {
    errors.push(`${JOB_NAME} job missing step: ${TRUSTED_CHECKOUT_STEP_NAME}`);
  } else {
    if (prCheckoutIndex < 0 || trustedCheckoutIndex !== prCheckoutIndex + 1) {
      errors.push(`${JOB_NAME} trusted fixture checkout must immediately follow the PR checkout`);
    }
    if (trustedCheckout.if !== FALLBACK_STEP_IF) {
      errors.push(`${JOB_NAME} trusted fixture checkout must remain fallback-only`);
    }
    if (trustedCheckout.uses !== CHECKOUT_ACTION) {
      errors.push(`${JOB_NAME} trusted fixture checkout must use the pinned checkout action`);
    }
    const checkoutWith = asRecord(trustedCheckout.with);
    if (
      checkoutWith.repository !== "NVIDIA/NemoClaw" ||
      checkoutWith.ref !== "${{ github.workflow_sha }}" ||
      checkoutWith["persist-credentials"] !== false
    ) {
      errors.push(
        `${JOB_NAME} trusted fixture checkout must use credential-free NVIDIA/NemoClaw workflow_sha provenance`,
      );
    }
    if (
      checkoutWith.path !== TRUSTED_CHECKOUT_PATH ||
      checkoutWith["sparse-checkout"] !== TRUSTED_FIXTURE_SOURCE ||
      checkoutWith["sparse-checkout-cone-mode"] !== false
    ) {
      errors.push(
        `${JOB_NAME} trusted fixture checkout must use its run-specific exact-file sparse path`,
      );
    }
  }

  const trustedInstallIndex = steps.findIndex((step) => step.name === TRUSTED_INSTALL_STEP_NAME);
  const trustedInstall = steps[trustedInstallIndex];
  if (!trustedInstall) {
    errors.push(`${JOB_NAME} job missing step: ${TRUSTED_INSTALL_STEP_NAME}`);
  } else {
    if (trustedInstallIndex !== trustedCheckoutIndex + 1) {
      errors.push(
        `${JOB_NAME} trusted fixture install must immediately follow its trusted checkout`,
      );
    }
    if (trustedInstall.if !== FALLBACK_STEP_IF || trustedInstall.shell !== TRUSTED_BASH_SHELL) {
      errors.push(`${JOB_NAME} trusted fixture install must be a fallback-only bash step`);
    }
    const installEnv = asRecord(trustedInstall.env);
    const installScript = normalizedShell(trustedInstall.run);
    const installFragments = [
      'trusted_checkout="$GITHUB_WORKSPACE/.trusted-hermes-gpu-fixture-${GITHUB_RUN_ID}-${GITHUB_RUN_ATTEMPT}"',
      `trusted_source="$trusted_checkout/${TRUSTED_FIXTURE_SOURCE}"`,
      `trusted_fixture="${TRUSTED_FIXTURE_PATH}"`,
      '[[ "$TRUSTED_WORKFLOW_SHA" =~ ^[a-f0-9]{40}$ ]]',
      '/usr/bin/git -C "$trusted_checkout" rev-parse HEAD',
      '[ -f "$trusted_source" ] && [ ! -L "$trusted_source" ]',
      "/usr/bin/sudo /usr/bin/install -d -o root -g root -m 0755 /usr/local/libexec/nemoclaw",
      '/usr/bin/sudo /usr/bin/install -o root -g root -m 0500 "$trusted_source" "$trusted_fixture"',
      `/usr/bin/sudo /usr/bin/stat -c '%a %u %g' "$trusted_fixture")" = "500 0 0"`,
      '/usr/bin/sudo /usr/bin/cmp -s "$trusted_source" "$trusted_fixture"',
      "trusted_state_root=/var/lib/nemoclaw-e2e",
      '/usr/bin/sudo /usr/bin/install -d -o root -g root -m 0700 "$trusted_state_root"',
      '/usr/bin/sudo /usr/bin/find "$trusted_state_root"',
      "-name 'hermes-gpu-fallback-docker-runtime.*' -print0",
      'run_trusted_fixture restore "$stale_state_dir" /etc/docker/daemon.json',
      "/usr/bin/sudo -n /usr/bin/env -i",
      "PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin",
      '/bin/bash "$trusted_fixture" "$@"',
      "if ! run_trusted_fixture restore",
    ];
    if (
      installEnv.TRUSTED_WORKFLOW_SHA !== "${{ github.workflow_sha }}" ||
      installEnv.BASH_ENV !== "/dev/null" ||
      installEnv.E2E_HERMES_GPU_STARTUP_SCENARIO !== "${{ matrix.scenario }}" ||
      installEnv.ENV !== "/dev/null" ||
      !installFragments.every((fragment) => installScript.includes(fragment))
    ) {
      errors.push(
        `${JOB_NAME} trusted fixture install must prove workflow_sha provenance and install root:root mode 0500`,
      );
    }
  }

  const runStep = steps.find((step) => step.name === RUN_STEP_NAME);
  if (!runStep) {
    errors.push(`${JOB_NAME} job missing step: ${RUN_STEP_NAME}`);
    return errors;
  }
  const runScript = stringValue(runStep.run);
  const normalizedRunScript = normalizedShell(runStep.run);
  const runEnv = asRecord(runStep.env);
  if (
    runStep.shell !== TRUSTED_BASH_SHELL ||
    runEnv.BASH_ENV !== "/dev/null" ||
    runEnv.E2E_HERMES_GPU_STARTUP_SCENARIO !== "${{ matrix.scenario }}" ||
    runEnv.ENV !== "/dev/null"
  ) {
    errors.push(`${JOB_NAME} live test must reassert its trusted shell environment`);
  }
  const prepareIndex = steps.findIndex((step) => step.name === "Prepare E2E workspace");
  const reassertNodeIndex = steps.findIndex((step) => step.name === REASSERT_NODE_STEP_NAME);
  const reassertNode = steps[reassertNodeIndex];
  const reassertNodeEnv = asRecord(reassertNode?.env);
  if (
    !reassertNode ||
    reassertNode.uses !== SETUP_NODE_ACTION ||
    asRecord(reassertNode.with)["node-version"] !== "22" ||
    reassertNodeEnv.BASH_ENV !== "/dev/null" ||
    reassertNodeEnv.E2E_HERMES_GPU_STARTUP_SCENARIO !== "${{ matrix.scenario }}" ||
    reassertNodeEnv.ENV !== "/dev/null" ||
    reassertNodeEnv.NODE_OPTIONS !== "" ||
    prepareIndex < 0 ||
    reassertNodeIndex !== prepareIndex + 1 ||
    steps.indexOf(runStep) !== reassertNodeIndex + 1
  ) {
    errors.push(
      `${JOB_NAME} must reassert pinned Node after PR build code and before its live test`,
    );
  }
  const trustedRunFragments = [
    `trusted_fixture="${TRUSTED_FIXTURE_PATH}"`,
    "/usr/bin/sudo -n /usr/bin/env -i",
    "PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin",
    '/bin/bash "$trusted_fixture" "$@"',
    'run_trusted_fixture capture "$state_dir" "$daemon_json"',
    'run_trusted_fixture select-runc "$state_dir" "$daemon_json"',
    'run_trusted_fixture restore "$state_dir" "$daemon_json"',
  ];
  if (!trustedRunFragments.every((fragment) => normalizedRunScript.includes(fragment))) {
    errors.push(`${JOB_NAME} live test must invoke only the installed trusted fixture via sudo`);
  }
  const trustedStateFragments = [
    "trusted_state_root=/var/lib/nemoclaw-e2e",
    '/usr/bin/sudo /usr/bin/install -d -o root -g root -m 0700 "$trusted_state_root"',
    'state_dir="$(/usr/bin/sudo /usr/bin/mktemp -d "$trusted_state_root/hermes-gpu-fallback-docker-runtime.',
    '/usr/bin/sudo /usr/bin/chown root:root "$state_dir"',
    '/usr/bin/sudo /usr/bin/chmod 0700 "$state_dir"',
  ];
  if (!trustedStateFragments.every((fragment) => normalizedRunScript.includes(fragment))) {
    errors.push(`${JOB_NAME} fallback snapshot state must remain private and root-owned`);
  }
  if (runScript.includes(TRUSTED_FIXTURE_SOURCE)) {
    errors.push(`${JOB_NAME} live test must not invoke the PR-workspace Docker fixture source`);
  }
  if (
    steps.some(
      (step) => step.name === LEGACY_PREPARE_STEP_NAME || step.name === LEGACY_RESTORE_STEP_NAME,
    )
  ) {
    errors.push(`${JOB_NAME} fallback Docker mutation, Vitest, and restore must share one step`);
  }
  const cleanupBoundaryFragments = [
    "umask 077",
    "mktemp -d",
    'chmod 0700 "$state_dir"',
    "${GITHUB_RUN_ID}.${GITHUB_RUN_ATTEMPT}.fallback.XXXXXX",
    "restore_docker_default_runtime()",
    "trap restore_docker_default_runtime EXIT",
    "trap 'exit 130' INT",
    "trap 'exit 143' TERM",
    "run_trusted_fixture capture",
    "run_trusted_fixture select-runc",
    "run_trusted_fixture restore",
  ];
  if (!cleanupBoundaryFragments.every((fragment) => runScript.includes(fragment))) {
    errors.push(`${JOB_NAME} fallback Docker mutation must remain under same-step cleanup traps`);
  }
  const sourceBoundaryMarkers = [
    "invalidState:",
    "sourceBoundary:",
    "whyNotSourceFix:",
    "regressionTest:",
    "removalCondition:",
  ];
  if (!sourceBoundaryMarkers.every((marker) => runScript.includes(marker))) {
    errors.push(`${JOB_NAME} fallback Docker fixture must retain its source-boundary rationale`);
  }
  if (/\b(?:install\s+-m|chmod)\s+0?644\b/u.test(runScript)) {
    errors.push(`${JOB_NAME} fallback Docker fixture must reject permissive 0644 file modes`);
  }
  if (!runScript.includes("npx vitest run --project e2e-live")) {
    errors.push(`${JOB_NAME} step must run the e2e-live Vitest project`);
  }
  if (!runScript.includes("test/e2e/live/hermes-gpu-startup.test.ts")) {
    errors.push(`${JOB_NAME} step must run the dedicated Hermes GPU startup test`);
  }

  const recoveryStep = steps.find((step) => step.name === RECOVERY_STEP_NAME);
  if (!recoveryStep) {
    errors.push(`${JOB_NAME} job missing step: ${RECOVERY_STEP_NAME}`);
  } else {
    if (recoveryStep.if !== "always()") {
      errors.push(`${JOB_NAME} independent Docker recovery step must always run`);
    }
    if (recoveryStep.shell !== TRUSTED_BASH_SHELL) {
      errors.push(`${JOB_NAME} independent Docker recovery step must use trusted absolute bash`);
    }
    const recoveryEnv = asRecord(recoveryStep.env);
    if (
      recoveryEnv.BASH_ENV !== "/dev/null" ||
      recoveryEnv.E2E_HERMES_GPU_STARTUP_SCENARIO !== "${{ matrix.scenario }}" ||
      recoveryEnv.ENV !== "/dev/null"
    ) {
      errors.push(`${JOB_NAME} recovery must reassert scenario and clear shell startup state`);
    }
    const recoveryScript = stringValue(recoveryStep.run);
    const normalizedRecoveryScript = normalizedShell(recoveryStep.run);
    const recoveryFragments = [
      `trusted_fixture="${TRUSTED_FIXTURE_PATH}"`,
      "trusted_state_root=/var/lib/nemoclaw-e2e",
      '/usr/bin/sudo /usr/bin/find "$trusted_state_root"',
      "${GITHUB_RUN_ID}.${GITHUB_RUN_ATTEMPT}.fallback.",
      "/usr/bin/sudo -n /usr/bin/env -i",
      '/bin/bash "$trusted_fixture" "$@"',
      'run_trusted_fixture restore "$state_dir" /etc/docker/daemon.json',
      "recovery_failed=1",
    ];
    if (!recoveryFragments.every((fragment) => normalizedRecoveryScript.includes(fragment))) {
      errors.push(
        `${JOB_NAME} independent Docker recovery step must discover and restore cancelled fallback state`,
      );
    }
    if (recoveryScript.includes(TRUSTED_FIXTURE_SOURCE)) {
      errors.push(`${JOB_NAME} recovery must not invoke the PR-workspace Docker fixture source`);
    }
    if (recoveryScript.includes("done < <(")) {
      errors.push(`${JOB_NAME} recovery must propagate trusted state discovery failures`);
    }
    if (/\b(?:install\s+-m|chmod)\s+0?644\b/u.test(recoveryScript)) {
      errors.push(`${JOB_NAME} fallback Docker fixture must reject permissive 0644 file modes`);
    }
    if (steps.indexOf(recoveryStep) <= steps.indexOf(runStep)) {
      errors.push(`${JOB_NAME} independent Docker recovery step must follow the live test step`);
    }
  }

  const trustedCleanupIndex = steps.findIndex((step) => step.name === TRUSTED_CLEANUP_STEP_NAME);
  const trustedCleanup = steps[trustedCleanupIndex];
  const recoveryStepIndex = steps.findIndex((step) => step.name === RECOVERY_STEP_NAME);
  if (!trustedCleanup) {
    errors.push(`${JOB_NAME} job missing step: ${TRUSTED_CLEANUP_STEP_NAME}`);
  } else {
    const cleanupScript = normalizedShell(trustedCleanup.run);
    const cleanupEnv = asRecord(trustedCleanup.env);
    if (
      recoveryStepIndex < 0 ||
      trustedCleanupIndex !== recoveryStepIndex + 1 ||
      trustedCleanup.if !== "${{ always() && matrix.scenario == 'fallback' }}" ||
      trustedCleanup.shell !== TRUSTED_BASH_SHELL ||
      cleanupEnv.BASH_ENV !== "/dev/null" ||
      cleanupEnv.E2E_HERMES_GPU_STARTUP_SCENARIO !== "${{ matrix.scenario }}" ||
      cleanupEnv.ENV !== "/dev/null" ||
      !cleanupScript.includes(`trusted_fixture="${TRUSTED_FIXTURE_PATH}"`) ||
      !cleanupScript.includes('/usr/bin/sudo /usr/bin/rm -f -- "$trusted_fixture"')
    ) {
      errors.push(
        `${JOB_NAME} installed trusted fixture must be removed in an always step immediately after recovery`,
      );
    }
  }

  let fixtureScript = "";
  try {
    fixtureScript = readFileSync(fixturePath, "utf8");
  } catch {
    errors.push(`${JOB_NAME} Docker runtime fixture helper is missing`);
  }
  if (fixtureScript) {
    if (/\b(?:install\s+-m|chmod)\s+0?644\b/u.test(fixtureScript)) {
      errors.push(`${JOB_NAME} fallback Docker fixture must reject permissive 0644 file modes`);
    }
    const fixedTargetFragments = [
      "expected_state_root=/var/lib/nemoclaw-e2e",
      "expected_daemon_json=/etc/docker/daemon.json",
      "validate_daemon_path",
      "hermes-gpu-fallback-docker-runtime\\.[0-9]+\\.[0-9]+\\.fallback",
    ];
    if (!fixedTargetFragments.every((fragment) => fixtureScript.includes(fragment))) {
      errors.push(`${JOB_NAME} Docker runtime fixture must pin privileged state and daemon paths`);
    }
    const fixtureFragments = [
      "umask 077",
      'install -m 0600 /dev/null "$state_dir/daemon.json.original"',
      "/usr/bin/jq",
      "sudo stat -c '%a %u %g' \"$daemon_json\"",
      "daemon.json.metadata",
      'sudo install -m "$original_mode"',
      'sudo chown "$original_uid:$original_gid" "$daemon_json"',
      'sudo chmod "$original_mode" "$daemon_json"',
      'sudo cmp -s "$state_dir/daemon.json.original" "$daemon_json"',
      "restored_mode $restored_uid $restored_gid",
      '"$restored_runtime" != "$original_runtime"',
      'rm -rf -- "$state_dir"',
    ];
    if (!fixtureFragments.every((fragment) => fixtureScript.includes(fragment))) {
      errors.push(
        `${JOB_NAME} Docker runtime fixture must preserve and verify content, mode, UID, GID, and runtime`,
      );
    }
    const cleanupMatch = /^\s{2}rm -rf -- "\$state_dir" \|\| restore_failed=1$/mu.exec(
      fixtureScript,
    );
    const cleanupIndex = cleanupMatch?.index ?? -1;
    const failureIndex = fixtureScript.indexOf('if [ "$restore_failed" -ne 0 ]', cleanupIndex);
    if (cleanupIndex < 0 || failureIndex < cleanupIndex) {
      errors.push(
        `${JOB_NAME} Docker runtime fixture must remove private state before reporting restore failure`,
      );
    }
  }

  const uploadStep = steps.find((step) => step.name === UPLOAD_STEP_NAME);
  if (!uploadStep) {
    errors.push(`${JOB_NAME} job missing step: ${UPLOAD_STEP_NAME}`);
  } else {
    const uploadWith = asRecord(uploadStep.with);
    if (uploadWith.name !== "e2e-hermes-gpu-startup-${{ matrix.scenario }}") {
      errors.push(`${JOB_NAME} upload must use a scenario-specific artifact name`);
    }
    if (uploadWith.path !== "e2e-artifacts/live/hermes-gpu-startup/${{ matrix.scenario }}/") {
      errors.push(`${JOB_NAME} upload must use the scenario-specific artifact path`);
    }
  }

  return errors;
}
