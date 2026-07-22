// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import YAML from "yaml";

/**
 * SOURCE_OF_TRUTH_REVIEW
 * invalidState: untrusted workflow drift weakens privileged host mutation or daemon restoration.
 * sourceBoundary: this shared workflow guard pins trust semantics that GitHub validates only as syntax.
 * whyNotSourceFix: Actions cannot enforce fixture digest, mode, ownership, path, or recovery ordering.
 * regressionTest: hermes-workflow-boundary.test.ts mutates each trust invariant independently.
 * removalCondition: the Hermes GPU job no longer mutates privileged self-hosted runner state.
 */
const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const DEFAULT_WORKFLOW_PATH = join(REPO_ROOT, ".github", "workflows", "e2e.yaml");
const FIXTURE = join(REPO_ROOT, "tools", "e2e", "hermes-gpu-docker-runtime-fixture.sh");
const JOB_NAME = "hermes-gpu-startup";
const CHECKOUT = "actions/checkout@df4cb1c069e1874edd31b4311f1884172cec0e10";
const SOURCE = "tools/e2e/hermes-gpu-docker-runtime-fixture.sh";
const SHA = "e273c4baa7fe89546d64517cf56eafec30aeda7b355971263605ab1327fade02";
const F_PATH =
  "/usr/local/libexec/nemoclaw/hermes-gpu-docker-runtime-fixture.${GITHUB_RUN_ID}.${GITHUB_RUN_ATTEMPT}.${E2E_HERMES_GPU_STARTUP_SCENARIO}";
const FALLBACK = "${{ matrix.scenario == 'fallback' }}";
const BASH = "/bin/bash --noprofile --norc -e -o pipefail {0}";
const RUN_STEP_NAME = "Run Hermes GPU startup live Vitest test";
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

// biome-ignore format: Compact declarative shell-proof vocabulary.
const TOKENS = { "@bash": '/bin/bash "$trusted_fixture" "$@"', "@bin": "/usr/bin", "@daemon": '"$daemon_json"', "@docker": "/etc/docker/daemon.json", "@env": "/usr/bin/sudo -n /usr/bin/env -i", "@fixture": '"$trusted_fixture"', "@gpu": "hermes-gpu-fallback-docker-runtime", "@install": "/usr/bin/sudo /usr/bin/install", "@root": '"$trusted_state_root"', "@run": "run_trusted_fixture", "@sha": '"$TRUSTED_FIXTURE_SHA256"', "@source": '"$trusted_source"', "@state": '"$state_dir"', "@sudo": "/usr/bin/sudo", "@workflow": '"$TRUSTED_WORKFLOW_SHA"' } as const;

function proof(spec: string): string[] {
  return spec
    .trim()
    .split("\n")
    .map((line) => line.trim().replace(/@\w+/gu, (token) => TOKENS[token as keyof typeof TOKENS]));
}

function hasProof(value: unknown, spec: string, ordered = false, raw = false): boolean {
  const script = raw
    ? stringValue(value)
    : stringValue(value)
        .replace(/\\\r?\n/gu, " ")
        .replace(/\s+/gu, " ")
        .trim();
  let offset = 0;
  return proof(spec).every((fragment) => {
    const index = script.indexOf(fragment, offset);
    if (ordered && index >= 0) offset = index + fragment.length;
    return index >= 0;
  });
}

function trustedEnv(step: WorkflowStep | undefined): boolean {
  const env = asRecord(step?.env);
  return (
    env.BASH_ENV === "/dev/null" &&
    env.E2E_HERMES_GPU_STARTUP_SCENARIO === "${{ matrix.scenario }}" &&
    env.ENV === "/dev/null"
  );
}

export function validateHermesGpuStartupWorkflow(
  workflow: WorkflowRecord,
  fixtureFile = FIXTURE,
): string[] {
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
    errors.push(`${JOB_NAME} requires a 90 minute timeout`);
  }
  const strategy = asRecord(job.strategy);
  const matrix = asRecord(strategy.matrix);
  if (
    strategy["fail-fast"] !== false ||
    strategy["max-parallel"] !== 1 ||
    JSON.stringify(matrix.include) !==
      JSON.stringify([
        { scenario: "native" },
        { scenario: "fallback" },
        { scenario: "compatibility-only" },
      ])
  ) {
    errors.push(`${JOB_NAME} must serialize GPU scenarios`);
  }

  const jobEnv = asRecord(job.env);
  const requiredEnv = {
    E2E_ARTIFACT_DIR:
      "${{ github.workspace }}/e2e-artifacts/live/hermes-gpu-startup/${{ matrix.scenario }}",
    E2E_HERMES_GPU_STARTUP_SCENARIO: "${{ matrix.scenario }}",
    E2E_JOB: "1",
    E2E_TARGET_ID: JOB_NAME,
    NEMOCLAW_AGENT: "hermes",
    NEMOCLAW_E2E_SHARD: "${{ matrix.scenario }}",
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
    errors.push(`${JOB_NAME} no E2E_DEFAULT_ENABLED`);
  }
  if (Object.hasOwn(jobEnv, "NEMOCLAW_DOCKER_GPU_PATCH")) {
    errors.push(`${JOB_NAME} no NEMOCLAW_DOCKER_GPU_PATCH`);
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

  const prI = steps.findIndex(
    (step) =>
      step.uses === CHECKOUT &&
      asRecord(step.with).ref === "${{ inputs.checkout_sha || github.sha }}",
  );
  const ci = steps.findIndex((step) => step.name === "Checkout trusted Hermes GPU runtime fixture");
  const checkout = steps[ci];
  const ii = steps.findIndex((step) => step.name === "Install trusted Hermes GPU runtime fixture");
  const install = steps[ii];
  const co = asRecord(checkout?.with);
  const ie = asRecord(install?.env);
  const spec = `trusted_checkout="$GITHUB_WORKSPACE/.trusted-hermes-gpu-fixture-\${GITHUB_RUN_ID}-\${GITHUB_RUN_ATTEMPT}"
trusted_source="$trusted_checkout/${SOURCE}"
trusted_fixture="${F_PATH}"
[[ @sha =~ ^[a-f0-9]{64}$ ]]
[[ @workflow =~ ^[a-f0-9]{40}$ ]]
[[ "$TRUSTED_DISPATCH_SHA" = @workflow ]]
@bin/git -C "$trusted_checkout" rev-parse HEAD
[ -f @source ] && [ ! -L @source ]
@install -d -o root -g root -m 0755 /usr/local/libexec/nemoclaw
@install -o root -g root -m 0500 @source @fixture
@sudo @bin/stat -c '%a %u %g' @fixture)" = "500 0 0"
printf '%s %s\\n' @sha @fixture | @sudo @bin/sha256sum -c -
@sudo @bin/cmp -s @source @fixture
trusted_state_root=/var/lib/nemoclaw-e2e
@install -d -o root -g root -m 0700 @root
@sudo @bin/find @root
-type d -name '@gpu.*' -print0
@run restore "$stale_state_dir" @docker
@env
PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin
@bash
if ! @run restore`;
  if (
    prI < 0 ||
    ci !== prI + 1 ||
    ii !== ci + 1 ||
    checkout?.if !== FALLBACK ||
    checkout?.uses !== CHECKOUT ||
    co.repository !== "NVIDIA/NemoClaw" ||
    co.ref !== "${{ github.workflow_sha }}" ||
    co.path !== ".trusted-hermes-gpu-fixture-${{ github.run_id }}-${{ github.run_attempt }}" ||
    co["sparse-checkout"] !== SOURCE ||
    co["sparse-checkout-cone-mode"] !== false ||
    co["persist-credentials"] !== false ||
    install?.if !== FALLBACK ||
    install?.shell !== BASH ||
    !trustedEnv(install) ||
    ie.TRUSTED_DISPATCH_SHA !== "${{ github.sha }}" ||
    ie.TRUSTED_FIXTURE_SHA256 !== SHA ||
    ie.TRUSTED_WORKFLOW_SHA !== "${{ github.workflow_sha }}" ||
    !hasProof(install?.run, spec) ||
    !hasProof(install?.run, proof(spec).slice(9, 13).join("\n"), true)
  ) {
    errors.push(`${JOB_NAME} root-owned fixture boundary failed`);
  }

  const runStep = steps.find((step) => step.name === RUN_STEP_NAME);
  if (!runStep) {
    errors.push(`${JOB_NAME} job missing step: ${RUN_STEP_NAME}`);
    return errors;
  }
  const run = stringValue(runStep.run);
  const pi = steps.findIndex((step) => step.name === "Prepare E2E workspace");
  const ni = steps.findIndex((step) => step.name === "Reassert trusted Node runtime");
  const node = steps[ni];
  if (
    runStep.shell !== BASH ||
    !trustedEnv(runStep) ||
    pi < 0 ||
    ni !== pi + 1 ||
    ni + 1 !== steps.indexOf(runStep) ||
    node?.uses !== "actions/setup-node@48b55a011bda9f5d6aeb4c2d9c7362e8dae4041e" ||
    asRecord(node?.with)["node-version"] !== "22" ||
    !trustedEnv(node) ||
    asRecord(node?.env).NODE_OPTIONS !== "" ||
    run.includes(SOURCE) ||
    !hasProof(
      runStep.run,
      `trusted_fixture="${F_PATH}"
@env
PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin
@bash
@run capture @state @daemon
@run select-runc @state @daemon
@run restore @state @daemon
trusted_state_root=/var/lib/nemoclaw-e2e
@install -d -o root -g root -m 0700 @root
state_dir="$(@sudo @bin/mktemp -d "$trusted_state_root/@gpu.
@sudo @bin/chown root:root @state
@sudo @bin/chmod 0700 @state`,
    ) ||
    steps.some(
      (step) =>
        step.name === "Prepare no-GPU native fallback fixture" ||
        step.name === "Restore Docker default runtime after fallback fixture",
    ) ||
    !hasProof(
      run,
      `umask 077
mktemp -d
chmod 0700 @state
\${GITHUB_RUN_ID}.\${GITHUB_RUN_ATTEMPT}.fallback.XXXXXX
restore_docker_default_runtime()
trap restore_docker_default_runtime EXIT
trap 'exit 130' INT
trap 'exit 143' TERM
@run capture
@run select-runc
@run restore
SOURCE_OF_TRUTH_REVIEW
invalidState:
sourceBoundary:
whyNotSourceFix:
regressionTest:
removalCondition:`,
      false,
      true,
    ) ||
    /\b(?:install\s+-m|chmod)\s+0?644\b/u.test(run) ||
    !run.includes("tools/e2e/live-vitest-invocation.mts run --test-path") ||
    !run.includes("test/e2e/live/hermes-gpu-startup.test.ts")
  ) {
    errors.push(`${JOB_NAME} trusted runtime boundary failed`);
  }

  const ri = steps.findIndex(
    (step) => step.name === "Recover Docker daemon after Hermes GPU fallback fixture",
  );
  const recovery = steps[ri];
  const rr = stringValue(recovery?.run);
  if (
    recovery?.if !== "always()" ||
    recovery?.shell !== BASH ||
    !trustedEnv(recovery) ||
    ri <= steps.indexOf(runStep) ||
    rr.includes(SOURCE) ||
    rr.includes("done < <(") ||
    !hasProof(
      recovery?.run,
      `trusted_fixture="${F_PATH}"
trusted_state_root=/var/lib/nemoclaw-e2e
@sudo @bin/find @root
\${GITHUB_RUN_ID}.\${GITHUB_RUN_ATTEMPT}.fallback.
@env
@bash
@run restore @state @docker
recovery_failed=1`,
    ) ||
    /\b(?:install\s+-m|chmod)\s+0?644\b/u.test(rr)
  ) {
    errors.push(`${JOB_NAME} trusted recovery boundary failed`);
  }

  const ki = steps.findIndex((step) => step.name === "Remove trusted Hermes GPU runtime fixture");
  const cleanup = steps[ki];
  if (
    ki !== ri + 1 ||
    cleanup?.if !== "${{ always() && matrix.scenario == 'fallback' }}" ||
    cleanup?.shell !== BASH ||
    !trustedEnv(cleanup) ||
    !hasProof(
      cleanup?.run,
      `trusted_fixture="${F_PATH}"
@sudo @bin/rm -f -- @fixture`,
    )
  ) {
    errors.push(`${JOB_NAME} cleanup requires an always step`);
  }

  let fixture = "";
  try {
    fixture = readFileSync(fixtureFile, "utf8");
  } catch {
    errors.push(`${JOB_NAME} fixture missing`);
  }
  if (fixture) {
    if (createHash("sha256").update(fixture).digest("hex") !== SHA) {
      errors.push(`${JOB_NAME} fixture must match its trusted SHA-256`);
    }
    if (/\b(?:install\s+-m|chmod)\s+0?644\b/u.test(fixture)) {
      errors.push(`${JOB_NAME} fixture must reject permissive 0644 modes`);
    }
    if (
      !hasProof(
        fixture,
        `expected_state_root=/var/lib/nemoclaw-e2e
expected_daemon_json=@docker
validate_daemon_path
@gpu\\.[0-9]+\\.[0-9]+\\.fallback`,
      )
    ) {
      errors.push(`${JOB_NAME} fixture must pin privileged state and daemon paths`);
    }
    if (
      !hasProof(
        fixture,
        `umask 077
install -m 0600 /dev/null "$state_dir/daemon.json.original"
@bin/jq
sudo stat -c '%a %u %g' @daemon
daemon.json.metadata
sudo install -m "$original_mode"
sudo chown "$original_uid:$original_gid" @daemon
sudo chmod "$original_mode" @daemon
sudo cmp -s "$state_dir/daemon.json.original" @daemon
restored_mode $restored_uid $restored_gid
"$restored_runtime" != "$original_runtime"
rm -rf -- @state`,
        false,
        true,
      )
    ) {
      errors.push(`${JOB_NAME} fixture must preserve content, mode, UID, GID, and runtime`);
    }
    const cleanup =
      /^\s{2}rm -rf -- "\$state_dir" \|\| restore_failed=1$/mu.exec(fixture)?.index ?? -1;
    if (cleanup < 0 || fixture.indexOf('if [ "$restore_failed" -ne 0 ]', cleanup) < cleanup) {
      errors.push(`${JOB_NAME} fixture must clean private state before restore failure`);
    }
  }

  const upload = asRecord(
    steps.find((step) => step.name === "Upload Hermes GPU startup artifacts")?.with,
  );
  if (
    upload.name !== "e2e-hermes-gpu-startup-${{ matrix.scenario }}" ||
    upload.path !== "e2e-artifacts/live/hermes-gpu-startup/${{ matrix.scenario }}/"
  ) {
    errors.push(`${JOB_NAME} upload needs a scenario artifact path`);
  }

  return errors;
}

export function validateHermesGpuStartupWorkflowBoundary(
  workflowPath = DEFAULT_WORKFLOW_PATH,
  fixtureFile = FIXTURE,
): string[] {
  return validateHermesGpuStartupWorkflow(
    asRecord(YAML.parse(readFileSync(workflowPath, "utf8"))),
    fixtureFile,
  );
}
