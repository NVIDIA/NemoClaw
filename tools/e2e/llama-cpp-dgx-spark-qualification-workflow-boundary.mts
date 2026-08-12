// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { isDeepStrictEqual } from "node:util";

import {
  LLAMA_CPP_DGX_SPARK_QUALIFICATION_ACTIVATION_PATH,
  LLAMA_CPP_DGX_SPARK_QUALIFICATION_JOB_ID,
} from "../../scripts/checks/llama-cpp-dgx-spark-qualification-contract.mts";

type RecordValue = Record<string, unknown>;
type WorkflowStep = RecordValue & {
  env?: RecordValue;
  name?: string;
  run?: string;
  uses?: string;
  with?: RecordValue;
};

const PLAN_JOB_ID = "llama-cpp-dgx-spark-plan";
const RUNNER_QUEUE_INPUT = "allow_dgx_spark_runner_queue";
const SELECTOR = `\${{ inputs.${RUNNER_QUEUE_INPUT} && github.repository == 'NVIDIA/NemoClaw' && github.ref == 'refs/heads/main' && (github.event_name == 'push' || (github.event_name == 'workflow_dispatch' && inputs.jobs == '' && inputs.targets == '') || contains(format(',{0},', inputs.jobs), ',${LLAMA_CPP_DGX_SPARK_QUALIFICATION_JOB_ID},') || contains(format(',{0},', inputs.targets), ',${LLAMA_CPP_DGX_SPARK_QUALIFICATION_JOB_ID},')) }}`;
const QUALIFICATION_SELECTOR = `\${{ inputs.${RUNNER_QUEUE_INPUT} && github.repository == 'NVIDIA/NemoClaw' && github.ref == 'refs/heads/main' && (github.event_name == 'push' || (github.event_name == 'workflow_dispatch' && inputs.jobs == '' && inputs.targets == '') || contains(format(',{0},', inputs.jobs), ',${LLAMA_CPP_DGX_SPARK_QUALIFICATION_JOB_ID},') || contains(format(',{0},', inputs.targets), ',${LLAMA_CPP_DGX_SPARK_QUALIFICATION_JOB_ID},')) && needs.${PLAN_JOB_ID}.outputs.execution == 'enabled' }}`;
const CHECKOUT = "actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1";
const BUILDX = "docker/setup-buildx-action@bb05f3f5519dd87d3ba754cc423b652a5edd6d2c";
const PREPARE =
  "NVIDIA/NemoClaw/.github/actions/prepare-e2e@f6304bc25fc35bfaa441c8c2fbfee38f72805a75";

function record(value: unknown): RecordValue {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as RecordValue) : {};
}

function steps(value: unknown): WorkflowStep[] {
  return Array.isArray(value) ? (value as WorkflowStep[]) : [];
}

function text(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function validateRunnerQueueInput(errors: string[], workflow: RecordValue): void {
  const triggers = record(workflow.on ?? workflow[true as unknown as string]);
  const dispatch = record(triggers.workflow_dispatch);
  const inputs = record(dispatch.inputs);
  const input = record(inputs[RUNNER_QUEUE_INPUT]);
  if (Object.keys(input).length === 0) {
    errors.push(`workflow_dispatch must define ${RUNNER_QUEUE_INPUT}`);
    return;
  }
  if (input.type !== "boolean") {
    errors.push(`workflow_dispatch ${RUNNER_QUEUE_INPUT} input must be boolean`);
  }
  if (input.default !== false) {
    errors.push(`workflow_dispatch ${RUNNER_QUEUE_INPUT} input must default to false`);
  }
  const description = text(input.description);
  if (
    !description.includes("repository administrator confirmation") ||
    !description.includes("DGX Spark runner") ||
    !description.includes("authoritative") ||
    !description.includes("NVIDIA/NemoClaw Settings -> Actions -> Runners") ||
    !description.includes("timeout-minutes")
  ) {
    errors.push(
      `workflow_dispatch ${RUNNER_QUEUE_INPUT} input must require repository administrator confirmation from the authoritative NVIDIA/NemoClaw Settings -> Actions -> Runners inventory and document queued timeout behavior`,
    );
  }
}

function requireStep(
  errors: string[],
  jobId: string,
  workflowSteps: readonly WorkflowStep[],
  name: string,
): WorkflowStep | undefined {
  const matches = workflowSteps.filter((step) => step.name === name);
  if (matches.length !== 1) errors.push(`${jobId} must define exactly one '${name}' step`);
  return matches[0];
}

function requireValues(
  errors: string[],
  subject: string,
  actual: RecordValue,
  expected: Readonly<Record<string, unknown>>,
): void {
  for (const [name, value] of Object.entries(expected)) {
    if (actual[name] !== value) errors.push(`${subject} must bind ${name} to ${String(value)}`);
  }
}

function requireFragments(
  errors: string[],
  jobId: string,
  step: WorkflowStep | undefined,
  fragments: readonly string[],
): void {
  const run = text(step?.run);
  for (const fragment of fragments) {
    if (!run.includes(fragment)) {
      errors.push(`${jobId} step '${step?.name ?? "missing"}' must include ${fragment}`);
    }
  }
}

function requireOrderedSteps(
  errors: string[],
  jobId: string,
  workflowSteps: readonly WorkflowStep[],
  names: readonly string[],
): void {
  const indexes = names.map((name) => workflowSteps.findIndex((step) => step.name === name));
  if (indexes.some((index) => index < 0)) return;
  if (indexes.some((index, offset) => offset > 0 && index <= indexes[offset - 1])) {
    errors.push(`${jobId} trusted planning, execution, cleanup, and evidence steps drifted`);
  }
}

export function validateLlamaCppDgxSparkQualificationWorkflow(workflow: RecordValue): string[] {
  const errors: string[] = [];
  validateRunnerQueueInput(errors, workflow);
  const jobs = record(workflow.jobs);
  const planJob = record(jobs[PLAN_JOB_ID]);
  const qualificationJob = record(jobs[LLAMA_CPP_DGX_SPARK_QUALIFICATION_JOB_ID]);
  if (Object.keys(planJob).length === 0) errors.push(`workflow missing ${PLAN_JOB_ID} job`);
  if (Object.keys(qualificationJob).length === 0) {
    errors.push(`workflow missing ${LLAMA_CPP_DGX_SPARK_QUALIFICATION_JOB_ID} job`);
    return errors;
  }

  if (planJob.needs !== "generate-matrix") {
    errors.push(`${PLAN_JOB_ID} must depend on generate-matrix`);
  }
  if (planJob.if !== SELECTOR)
    errors.push(`${PLAN_JOB_ID} must require ${RUNNER_QUEUE_INPUT} and retain manual selectors`);
  if (planJob["runs-on"] !== "ubuntu-24.04") {
    errors.push(`${PLAN_JOB_ID} must run on a standard trusted planner`);
  }
  if (planJob["timeout-minutes"] !== 15) {
    errors.push(`${PLAN_JOB_ID} must keep the 15 minute timeout`);
  }
  if (!isDeepStrictEqual(planJob.permissions, { contents: "read" })) {
    errors.push(`${PLAN_JOB_ID} permissions must be contents: read`);
  }
  const expectedOutputs = Object.fromEntries(
    [
      "agent_qualification_execution",
      "environment",
      "execution",
      "model_host_path",
      "plan",
      "plan_sha256",
      "qualification",
      "runner",
    ].map((name) => [name, `\${{ steps.plan.outputs.${name} }}`]),
  );
  if (!isDeepStrictEqual(planJob.outputs, expectedOutputs)) {
    errors.push(`${PLAN_JOB_ID} must expose only validated declarative plan outputs`);
  }

  const planSteps = steps(planJob.steps);
  const planGuard = requireStep(
    errors,
    PLAN_JOB_ID,
    planSteps,
    "Validate trusted llama.cpp plan dispatch",
  );
  requireFragments(errors, PLAN_JOB_ID, planGuard, [
    '"NVIDIA/NemoClaw"',
    '"refs/heads/main"',
    '"push"',
    '"workflow_dispatch"',
    '[[ "$CHECKOUT_SHA" =~ ^[a-f0-9]{40}$ && "$BASE_SHA" =~ ^[a-f0-9]{40}$ ]]',
    '"$WORKFLOW_SHA" == "$EXPECTED_WORKFLOW_SHA"',
  ]);
  if (text(planGuard?.run).includes("github-actions[bot]")) {
    errors.push(
      `${PLAN_JOB_ID} must not restrict trusted manual dispatches to github-actions[bot]`,
    );
  }
  const trustedPlanCheckout = requireStep(
    errors,
    PLAN_JOB_ID,
    planSteps,
    "Checkout trusted llama.cpp plan compiler",
  );
  if (trustedPlanCheckout?.uses !== CHECKOUT) errors.push(`${PLAN_JOB_ID} must pin checkout`);
  requireValues(errors, `${PLAN_JOB_ID} trusted checkout`, record(trustedPlanCheckout?.with), {
    repository: "${{ github.repository }}",
    ref: "${{ inputs.workflow_sha || github.workflow_sha }}",
    "fetch-depth": 0,
    "persist-credentials": false,
  });
  const candidatePlanCheckout = requireStep(
    errors,
    PLAN_JOB_ID,
    planSteps,
    "Checkout exact llama.cpp candidate configuration",
  );
  if (candidatePlanCheckout?.uses !== CHECKOUT) errors.push(`${PLAN_JOB_ID} must pin checkout`);
  requireValues(errors, `${PLAN_JOB_ID} candidate checkout`, record(candidatePlanCheckout?.with), {
    repository: "${{ inputs.checkout_repository || github.repository }}",
    ref: "${{ inputs.checkout_sha || github.sha }}",
    path: ".candidate-llama-cpp",
    "fetch-depth": 0,
    "persist-credentials": false,
  });
  const compile = requireStep(
    errors,
    PLAN_JOB_ID,
    planSteps,
    "Compile exact candidate llama.cpp qualification plan",
  );
  requireFragments(errors, PLAN_JOB_ID, compile, [
    'git -C "$CANDIDATE_ROOT" rev-parse --verify HEAD',
    '"$CHECKOUT_SHA"',
    "scripts/checks/export-llama-cpp-dgx-spark-qualification-plan.mts",
    '--source-root "$CANDIDATE_ROOT"',
  ]);
  if (text(compile?.run).includes(".candidate-llama-cpp/scripts")) {
    errors.push(`${PLAN_JOB_ID} must not execute candidate-controlled scripts`);
  }

  if (!isDeepStrictEqual(qualificationJob.needs, ["generate-matrix", PLAN_JOB_ID])) {
    errors.push(`${LLAMA_CPP_DGX_SPARK_QUALIFICATION_JOB_ID} must depend on the trusted plan`);
  }
  if (qualificationJob.if !== QUALIFICATION_SELECTOR) {
    errors.push(
      `${LLAMA_CPP_DGX_SPARK_QUALIFICATION_JOB_ID} must require ${RUNNER_QUEUE_INPUT} after the trusted plan is enabled`,
    );
  }
  if (qualificationJob["runs-on"] !== `\${{ needs.${PLAN_JOB_ID}.outputs.runner }}`) {
    errors.push(`${LLAMA_CPP_DGX_SPARK_QUALIFICATION_JOB_ID} runner must come from validated YAML`);
  }
  if (
    !isDeepStrictEqual(qualificationJob.environment, {
      name: `\${{ needs.${PLAN_JOB_ID}.outputs.environment }}`,
    })
  ) {
    errors.push(
      `${LLAMA_CPP_DGX_SPARK_QUALIFICATION_JOB_ID} approval environment must come from validated YAML`,
    );
  }
  if (qualificationJob["timeout-minutes"] !== 300) {
    errors.push(`${LLAMA_CPP_DGX_SPARK_QUALIFICATION_JOB_ID} must keep the 300 minute timeout`);
  }
  if (!isDeepStrictEqual(qualificationJob.permissions, { contents: "read" })) {
    errors.push(`${LLAMA_CPP_DGX_SPARK_QUALIFICATION_JOB_ID} permissions must be contents: read`);
  }
  if (qualificationJob["continue-on-error"] !== undefined) {
    errors.push(`${LLAMA_CPP_DGX_SPARK_QUALIFICATION_JOB_ID} must not weaken failures`);
  }
  const jobEnv = record(qualificationJob.env);
  requireValues(errors, `${LLAMA_CPP_DGX_SPARK_QUALIFICATION_JOB_ID} env`, jobEnv, {
    E2E_DEFAULT_ENABLED: "0",
    E2E_JOB: "1",
    E2E_TARGET_ID: LLAMA_CPP_DGX_SPARK_QUALIFICATION_JOB_ID,
    RELEASE_E2E_ACTIVATION_PATH: LLAMA_CPP_DGX_SPARK_QUALIFICATION_ACTIVATION_PATH,
    NEMOCLAW_E2E_EXPECTED_SHA: "${{ inputs.checkout_sha }}",
    NEMOCLAW_LLAMA_CPP_QUALIFICATION_BASE_SHA:
      "${{ inputs.base_sha || github.event.before || github.sha }}",
    NEMOCLAW_LLAMA_CPP_QUALIFICATION_HEAD_SHA: "${{ inputs.checkout_sha || github.sha }}",
    NEMOCLAW_LLAMA_CPP_QUALIFICATION_PLAN:
      "${{ github.workspace }}/.llama-cpp-qualification/plan.json",
    NEMOCLAW_LLAMA_CPP_QUALIFICATION_WORKFLOW_SHA:
      "${{ inputs.workflow_sha || github.workflow_sha }}",
    NEMOCLAW_LLAMA_CPP_QUALIFICATION_PLAN_SHA256: `\${{ needs.${PLAN_JOB_ID}.outputs.plan_sha256 }}`,
  });
  for (const secret of [
    "DOCKERHUB_TOKEN",
    "DOCKERHUB_USERNAME",
    "GITHUB_TOKEN",
    "MODEL_HOST_PATH",
    "NVIDIA_API_KEY",
  ]) {
    if (jobEnv[secret] !== undefined) {
      errors.push(
        `${LLAMA_CPP_DGX_SPARK_QUALIFICATION_JOB_ID} must not expose ${secret} at job scope`,
      );
    }
  }

  const qualificationSteps = steps(qualificationJob.steps);
  const guard = requireStep(
    errors,
    LLAMA_CPP_DGX_SPARK_QUALIFICATION_JOB_ID,
    qualificationSteps,
    "Validate protected llama.cpp exact-head dispatch",
  );
  requireFragments(errors, LLAMA_CPP_DGX_SPARK_QUALIFICATION_JOB_ID, guard, [
    '"NVIDIA/NemoClaw"',
    '"refs/heads/main"',
    '"push"',
    '"workflow_dispatch"',
    '"$WORKFLOW_SHA" == "$EXPECTED_WORKFLOW_SHA"',
    '"$RUNNER_ARCH_KIND" == "ARM64"',
  ]);
  if (text(guard?.run).includes("github-actions[bot]")) {
    errors.push(
      `${LLAMA_CPP_DGX_SPARK_QUALIFICATION_JOB_ID} must not restrict trusted manual dispatches to github-actions[bot]`,
    );
  }
  const trustedCheckout = requireStep(
    errors,
    LLAMA_CPP_DGX_SPARK_QUALIFICATION_JOB_ID,
    qualificationSteps,
    "Checkout trusted llama.cpp qualification",
  );
  if (trustedCheckout?.uses !== CHECKOUT) {
    errors.push(`${LLAMA_CPP_DGX_SPARK_QUALIFICATION_JOB_ID} must pin trusted checkout`);
  }
  requireValues(errors, "trusted llama.cpp qualification checkout", record(trustedCheckout?.with), {
    repository: "${{ github.repository }}",
    ref: "${{ inputs.workflow_sha || github.workflow_sha }}",
    "fetch-depth": 0,
    "persist-credentials": false,
  });
  const candidateCheckout = requireStep(
    errors,
    LLAMA_CPP_DGX_SPARK_QUALIFICATION_JOB_ID,
    qualificationSteps,
    "Checkout exact llama.cpp qualification candidate",
  );
  if (candidateCheckout?.uses !== CHECKOUT) {
    errors.push(`${LLAMA_CPP_DGX_SPARK_QUALIFICATION_JOB_ID} must pin candidate checkout`);
  }
  requireValues(
    errors,
    "llama.cpp qualification candidate checkout",
    record(candidateCheckout?.with),
    {
      repository: "${{ inputs.checkout_repository || github.repository }}",
      ref: "${{ inputs.checkout_sha || github.sha }}",
      path: ".candidate-llama-cpp",
      "fetch-depth": 0,
      "persist-credentials": false,
    },
  );
  const buildx = requireStep(
    errors,
    LLAMA_CPP_DGX_SPARK_QUALIFICATION_JOB_ID,
    qualificationSteps,
    "Set up protected llama.cpp Buildx",
  );
  if (buildx?.uses !== BUILDX) {
    errors.push(`${LLAMA_CPP_DGX_SPARK_QUALIFICATION_JOB_ID} must pin Buildx setup`);
  }
  if (!isDeepStrictEqual(buildx?.with, { driver: "docker" })) {
    errors.push(
      `${LLAMA_CPP_DGX_SPARK_QUALIFICATION_JOB_ID} must use the host-network-free Docker driver`,
    );
  }
  const prepare = requireStep(
    errors,
    LLAMA_CPP_DGX_SPARK_QUALIFICATION_JOB_ID,
    qualificationSteps,
    "Prepare E2E workspace",
  );
  if (prepare?.uses !== PREPARE || !isDeepStrictEqual(prepare.with, { "build-cli": "false" })) {
    errors.push(
      `${LLAMA_CPP_DGX_SPARK_QUALIFICATION_JOB_ID} must use trusted no-build preparation`,
    );
  }
  const installOpenShell = requireStep(
    errors,
    LLAMA_CPP_DGX_SPARK_QUALIFICATION_JOB_ID,
    qualificationSteps,
    "Install OpenShell CLI for declarative OpenClaw qualification",
  );
  if (
    installOpenShell?.if !==
    `\${{ needs.${PLAN_JOB_ID}.outputs.agent_qualification_execution == 'enabled' }}`
  ) {
    errors.push(
      `${LLAMA_CPP_DGX_SPARK_QUALIFICATION_JOB_ID} must gate OpenShell installation on the declarative agent qualification`,
    );
  }
  requireFragments(errors, LLAMA_CPP_DGX_SPARK_QUALIFICATION_JOB_ID, installOpenShell, [
    "env -u DOCKER_CONFIG",
    "-u DOCKERHUB_USERNAME",
    "-u DOCKERHUB_TOKEN",
    "-u NVIDIA_API_KEY",
    "-u NVIDIA_INFERENCE_API_KEY",
    "-u GITHUB_TOKEN",
    "bash scripts/install-openshell.sh",
  ]);
  if (text(installOpenShell?.run).includes(".candidate-llama-cpp/scripts")) {
    errors.push(
      `${LLAMA_CPP_DGX_SPARK_QUALIFICATION_JOB_ID} must install OpenShell only from trusted helper code`,
    );
  }
  const materialize = requireStep(
    errors,
    LLAMA_CPP_DGX_SPARK_QUALIFICATION_JOB_ID,
    qualificationSteps,
    "Materialize trusted llama.cpp qualification plan",
  );
  requireFragments(errors, LLAMA_CPP_DGX_SPARK_QUALIFICATION_JOB_ID, materialize, [
    'git -C "$CANDIDATE_ROOT" rev-parse --verify HEAD',
    'install -d -m 0700 "$(dirname "$NEMOCLAW_LLAMA_CPP_QUALIFICATION_PLAN")"',
    "printf '%s' \"$PLAN\"",
    'sha256sum "$NEMOCLAW_LLAMA_CPP_QUALIFICATION_PLAN"',
    '"$PLAN_SHA256"',
  ]);
  const qualify = requireStep(
    errors,
    LLAMA_CPP_DGX_SPARK_QUALIFICATION_JOB_ID,
    qualificationSteps,
    "Build and qualify exact llama.cpp candidate",
  );
  requireValues(errors, "llama.cpp qualification step env", record(qualify?.env), {
    BASE_SHA: "${{ inputs.base_sha || github.event.before || github.sha }}",
    CANDIDATE_ROOT: "${{ github.workspace }}/.candidate-llama-cpp",
    CHECKOUT_SHA: "${{ inputs.checkout_sha || github.sha }}",
    MODEL_HOST_PATH: `\${{ needs.${PLAN_JOB_ID}.outputs.model_host_path }}`,
    WORKFLOW_SHA: "${{ inputs.workflow_sha || github.workflow_sha }}",
  });
  requireFragments(errors, LLAMA_CPP_DGX_SPARK_QUALIFICATION_JOB_ID, qualify, [
    'git rev-parse --verify HEAD)" == "$WORKFLOW_SHA"',
    "scripts/checks/run-llama-cpp-dgx-spark-qualification.mts",
    '--candidate-root "$CANDIDATE_ROOT"',
    '--model-host-path "$MODEL_HOST_PATH"',
    '--plan-sha256 "$NEMOCLAW_LLAMA_CPP_QUALIFICATION_PLAN_SHA256"',
    '--workflow-sha "$WORKFLOW_SHA"',
  ]);
  if (text(qualify?.run).includes(".candidate-llama-cpp/scripts")) {
    errors.push(
      `${LLAMA_CPP_DGX_SPARK_QUALIFICATION_JOB_ID} must execute only trusted helper code`,
    );
  }
  const cleanup = requireStep(
    errors,
    LLAMA_CPP_DGX_SPARK_QUALIFICATION_JOB_ID,
    qualificationSteps,
    "Remove protected llama.cpp qualification resources",
  );
  if (cleanup?.if !== "always()") {
    errors.push(`${LLAMA_CPP_DGX_SPARK_QUALIFICATION_JOB_ID} cleanup must always run`);
  }
  requireFragments(errors, LLAMA_CPP_DGX_SPARK_QUALIFICATION_JOB_ID, cleanup, [
    "run-llama-cpp-dgx-spark-qualification.mts",
    "--cleanup-only",
    '"$NEMOCLAW_LLAMA_CPP_QUALIFICATION_REGISTRY"',
  ]);
  const evidence = requireStep(
    errors,
    LLAMA_CPP_DGX_SPARK_QUALIFICATION_JOB_ID,
    qualificationSteps,
    "Validate protected llama.cpp evidence",
  );
  requireFragments(errors, LLAMA_CPP_DGX_SPARK_QUALIFICATION_JOB_ID, evidence, [
    "tools/e2e/live-vitest-invocation.mts run",
    "--test-path test/e2e/live/llama-cpp-dgx-spark-qualification.test.ts",
  ]);
  const upload = requireStep(
    errors,
    LLAMA_CPP_DGX_SPARK_QUALIFICATION_JOB_ID,
    qualificationSteps,
    "Upload protected llama.cpp evidence",
  );
  if (upload?.if !== "always()") {
    errors.push(`${LLAMA_CPP_DGX_SPARK_QUALIFICATION_JOB_ID} evidence upload must always run`);
  }
  requireValues(errors, "llama.cpp qualification evidence upload", record(upload?.with), {
    name: "e2e-llama-cpp-dgx-spark-qualification",
    path: "e2e-artifacts/live/llama-cpp-dgx-spark-qualification/",
  });
  requireOrderedSteps(errors, LLAMA_CPP_DGX_SPARK_QUALIFICATION_JOB_ID, qualificationSteps, [
    "Validate protected llama.cpp exact-head dispatch",
    "Checkout trusted llama.cpp qualification",
    "Checkout exact llama.cpp qualification candidate",
    "Prepare E2E workspace",
    "Install OpenShell CLI for declarative OpenClaw qualification",
    "Materialize trusted llama.cpp qualification plan",
    "Build and qualify exact llama.cpp candidate",
    "Remove protected llama.cpp qualification resources",
    "Validate protected llama.cpp evidence",
    "Upload protected llama.cpp evidence",
    "Clean up Docker auth",
  ]);
  return errors;
}
