// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { isDeepStrictEqual } from "node:util";
import YAML from "yaml";
import {
  CLI_ARTIFACT_PUBLISH_STEP,
  CLI_ARTIFACT_UPLOAD_ACTION,
} from "./cli-artifact-workflow-boundary.mts";
import { SHARED_E2E_JOB_ID } from "./credential-free-tests.mts";
import { E2E_ACTION_PROVENANCE } from "./workflow-boundary-policy.mts";

export { E2E_ACTION_PROVENANCE };

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const DEFAULT_ACTION_PATH = join(
  REPO_ROOT,
  ".github",
  "actions",
  "upload-e2e-artifacts",
  "action.yaml",
);

export const UPLOAD_E2E_ARTIFACTS_ACTION_PROVENANCE = E2E_ACTION_PROVENANCE.uploadArtifacts;

export const UPLOAD_E2E_ARTIFACTS_ACTION = UPLOAD_E2E_ARTIFACTS_ACTION_PROVENANCE.reference;
export const OPENSHELL_DEV_ARTIFACT_DIRECTORY = "${{ runner.temp }}/openshell-dev-artifact";
export const OPENSHELL_DEV_ARTIFACT_UPLOAD_NAME =
  "${{ steps.resolve_openshell_dev_artifact.outputs.artifact_name || format('openshell-dev-infrastructure-failure-{0}-{1}', github.run_id, github.run_attempt) }}";

const CHECKOUT_LOCAL_UPLOAD_E2E_ARTIFACTS_ACTION = "./.github/actions/upload-e2e-artifacts";
const UPLOAD_E2E_ARTIFACTS_ACTION_PREFIX = "NVIDIA/NemoClaw/.github/actions/upload-e2e-artifacts@";
const UPLOAD_ARTIFACT_ACTION = "actions/upload-artifact@043fb46d1a93c77aae656e7c1c64a875d1fc6a0a";
const UPLOAD_ARTIFACT_ACTION_PREFIX = "actions/upload-artifact@";
const MANAGED_IMAGE_BUILD_CACHE_PUBLISH_STEP = "Publish exact amd64 protected runtime build cache";
const MANAGED_IMAGE_BUILD_CACHE_ARTIFACT_NAME =
  "${{ env.NEMOCLAW_PROTECTED_MANAGED_IMAGE_BUILD_CACHE_ARTIFACT }}";
const MANAGED_IMAGE_BUILD_CACHE_ARTIFACT_PATH =
  "${{ env.NEMOCLAW_PROTECTED_MANAGED_IMAGE_BUILD_CACHE }}/";
const NATIVE_RUNTIME_AGGREGATE_UPLOAD_CONTRACT: WorkflowStep = {
  name: "Upload aggregate evidence",
  uses: UPLOAD_ARTIFACT_ACTION,
  with: {
    name: "native-runtime-qualification-${{ inputs.checkout_sha }}",
    path: "${{ runner.temp }}/native-runtime-aggregate/",
    "if-no-files-found": "error",
    "retention-days": 30,
    "compression-level": 9,
  },
};
const INNER_ALWAYS = "${{ always() }}";
const CALLER_ALWAYS = "always()";
const RETIRED_SELECTOR_COMPATIBILITY_JOB = "retired-selector-compatibility";
const MCP_SCANNED_UPLOAD_CONDITION =
  "${{ always() && steps.mcp_artifact_secret_scan.outcome == 'success' }}";
const CREDENTIAL_WINDOW_SCANNED_UPLOAD_CONDITION =
  "${{ always() && steps.credential_window_artifact_secret_scan.outcome == 'success' }}";
const GATEWAY_AUTH_SCANNED_UPLOAD_CONDITION =
  "${{ always() && steps.artifact_safety.outcome == 'success' && steps.artifact_safety.outputs.approved_path != '' }}";
const TARGET_ID_PATTERN = /^[A-Za-z0-9_-]+$/;

const SCORECARD_RUNTIME_UPLOAD_CONTRACT: WorkflowStep = {
  name: "Upload E2E runtime summary",
  if: "${{ always() && github.event_name == 'push' }}",
  uses: UPLOAD_E2E_ARTIFACTS_ACTION,
  with: {
    name: "e2e-runtime-summary",
    path: "${{ runner.temp }}/e2e-runtime-summary.json",
  },
};

const SHARED_E2E_JOBS: ReadonlyMap<string, { targetId: string }> = new Map([
  [SHARED_E2E_JOB_ID, { targetId: "${{ matrix.id }}" }],
]);

type WorkflowRecord = Record<string, unknown>;
type WorkflowStep = WorkflowRecord & {
  name?: string;
  if?: string;
  uses?: string;
  with?: WorkflowRecord;
};

type ExplicitUploadContract = {
  name: string;
  path?: string;
};

function isExactManagedImageBuildCacheUpload(jobName: string, step: WorkflowStep): boolean {
  const inputs = record(step.with);
  return (
    jobName === "managed-image-multiarch-startup" &&
    step.name === MANAGED_IMAGE_BUILD_CACHE_PUBLISH_STEP &&
    step.uses === UPLOAD_ARTIFACT_ACTION &&
    inputs.name === MANAGED_IMAGE_BUILD_CACHE_ARTIFACT_NAME &&
    inputs.path === MANAGED_IMAGE_BUILD_CACHE_ARTIFACT_PATH
  );
}

function isExactNativeRuntimeAggregateUpload(jobName: string, step: WorkflowStep): boolean {
  return (
    jobName === "native-runtime-qualification-producer-aggregate" &&
    isDeepStrictEqual(step, NATIVE_RUNTIME_AGGREGATE_UPLOAD_CONTRACT)
  );
}

const EXPLICIT_UPLOAD_CONTRACTS = new Map<string, ExplicitUploadContract>([
  [
    "generate-matrix",
    {
      name: "e2e-dispatch-${{ github.run_id }}-${{ github.run_attempt }}",
      path: "${{ runner.temp }}/nemoclaw-e2e-dispatch/dispatch.json",
    },
  ],
  [
    "jetson-nvmap-gpu",
    {
      name: "e2e-jetson-nvmap-gpu",
      path: "${{ runner.temp }}/e2e-artifacts/live/jetson-nvmap-gpu/",
    },
  ],
  [
    "retired-selector-compatibility",
    {
      name: "e2e-retired-selector-compatibility",
      path: "e2e-artifacts/live/retired-selector-compatibility/",
    },
  ],
  [
    "staging-brev-launchable",
    {
      name: "staging-brev-launchable-${{ env.CANDIDATE_SHA }}-${{ github.run_id }}-${{ github.run_attempt }}",
      path: [
        "${{ steps.workspace.outputs.work_dir }}/lane.log",
        "${{ steps.workspace.outputs.work_dir }}/launchable-e2e.json",
        "${{ steps.workspace.outputs.work_dir }}/full-e2e.log",
        "${{ steps.workspace.outputs.work_dir }}/cleanup.json",
        "",
      ].join("\n"),
    },
  ],
  [
    "staging-brev-launchable-identity",
    {
      name: "staging-brev-launchable-identity-${{ env.CANDIDATE_SHA }}-${{ github.run_id }}-${{ github.run_attempt }}",
      path: [
        "${{ steps.workspace.outputs.work_dir }}/lane.log",
        "${{ steps.workspace.outputs.work_dir }}/launchable-identity.json",
        "${{ steps.workspace.outputs.work_dir }}/cleanup.json",
        "",
      ].join("\n"),
    },
  ],
  [
    "live",
    {
      name: "e2e-${{ matrix.id }}",
      path: [
        "e2e-artifacts/live/${{ matrix.id }}/run-plan.json",
        "e2e-artifacts/live/${{ matrix.id }}/target.json",
        "e2e-artifacts/live/${{ matrix.id }}/target-result.json",
        "e2e-artifacts/live/${{ matrix.id }}/test-progress.json",
        "e2e-artifacts/live/${{ matrix.id }}/environment.result.json",
        "e2e-artifacts/live/${{ matrix.id }}/onboarding.result.json",
        "e2e-artifacts/live/${{ matrix.id }}/state-validation.result.json",
        "e2e-artifacts/live/${{ matrix.id }}/dcode-base-image.json",
        "e2e-artifacts/live/${{ matrix.id }}/cloud-onboard-trace-timing-summary.json",
        "e2e-artifacts/live/risk-signal.json",
        "e2e-artifacts/live/${{ matrix.id }}/actions/",
        "e2e-artifacts/live/${{ matrix.id }}/logs/",
        "e2e-artifacts/live/${{ matrix.id }}/shell/",
        "",
      ].join("\n"),
    },
  ],
  [
    "managed-image-multiarch-startup",
    {
      name: "e2e-managed-image-multiarch-startup-${{ matrix.shard }}",
      path: "e2e-artifacts/live/managed-image-multiarch-startup/${{ matrix.shard }}/",
    },
  ],
  [
    "managed-image-protected-runtime",
    {
      name: "e2e-managed-image-protected-runtime",
      path: "e2e-artifacts/live/managed-image-protected-runtime/",
    },
  ],
  [
    "native-runtime-qualification-podman-toolchain",
    {
      name: "native-runtime-podman-toolchain-${{ matrix.architecture }}",
      path: "${{ runner.temp }}/native-runtime-podman-toolchain/",
    },
  ],
  [
    "native-runtime-qualification-producer",
    {
      name: "${{ matrix.artifactName }}",
      path: "${{ runner.temp }}/native-runtime-evidence/",
    },
  ],
  [
    "llama-cpp-dgx-spark-qualification",
    {
      name: "e2e-llama-cpp-dgx-spark-qualification",
      path: "e2e-artifacts/live/llama-cpp-dgx-spark-qualification/",
    },
  ],
  [
    "hermes-gpu-startup",
    {
      name: "e2e-hermes-gpu-startup-${{ matrix.scenario }}",
      path: "e2e-artifacts/live/hermes-gpu-startup/${{ matrix.scenario }}/",
    },
  ],
  [
    "openshell-gateway-auth-contract",
    {
      name: "e2e-openshell-gateway-auth-contract",
      path: "${{ steps.artifact_safety.outputs.approved_path }}",
    },
  ],
  [
    "mcp-bridge",
    {
      name: "e2e-mcp-bridge-${{ matrix.agent }}",
      path: "e2e-artifacts/live/mcp-bridge/${{ matrix.agent }}/",
    },
  ],
  [
    "mcp-bridge-dev",
    {
      name: "e2e-mcp-bridge-dev-${{ matrix.agent }}",
      path: "e2e-artifacts/live/mcp-bridge-dev/${{ matrix.agent }}/",
    },
  ],
  [
    "openshell-dev-artifact",
    {
      name: OPENSHELL_DEV_ARTIFACT_UPLOAD_NAME,
      path: `${OPENSHELL_DEV_ARTIFACT_DIRECTORY}/`,
    },
  ],
  [
    "openshell-credential-generation-window",
    {
      name: "e2e-openshell-credential-generation-window",
      path: "e2e-artifacts/live/openshell-credential-generation-window/",
    },
  ],
]);

const EXPLICIT_CALLER_CONDITIONS = new Map<string, string>([
  ["generate-matrix", "${{ github.event_name == 'workflow_dispatch' }}"],
  ["native-runtime-qualification-podman-toolchain", "success()"],
  ["native-runtime-qualification-producer", "success()"],
  ["staging-brev-launchable", "${{ always() && steps.workspace.outputs.work_dir != '' }}"],
  ["staging-brev-launchable-identity", "${{ always() && steps.workspace.outputs.work_dir != '' }}"],
  ["mcp-bridge", MCP_SCANNED_UPLOAD_CONDITION],
  ["mcp-bridge-dev", MCP_SCANNED_UPLOAD_CONDITION],
  ["openshell-dev-artifact", "${{ always() }}"],
  ["openshell-credential-generation-window", CREDENTIAL_WINDOW_SCANNED_UPLOAD_CONDITION],
  ["openshell-gateway-auth-contract", GATEWAY_AUTH_SCANNED_UPLOAD_CONDITION],
]);

const EXPECTED_ACTION_INPUTS = {
  name: {
    description: "Artifact name. Defaults to the current E2E target.",
    required: false,
    default: "",
  },
  path: {
    description: "Artifact path. Defaults to the current E2E target's artifact directory.",
    required: false,
    default: "",
  },
};

const EXPECTED_UPLOAD_POLICY = {
  name: "${{ inputs.name != '' && inputs.name || format('e2e-{0}', env.E2E_TARGET_ID) }}",
  path: "${{ inputs.path != '' && inputs.path || format('e2e-artifacts/live/{0}/', env.E2E_TARGET_ID) }}",
  "include-hidden-files": false,
  "if-no-files-found": "ignore",
  "retention-days": 14,
};

function record(value: unknown): WorkflowRecord {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as WorkflowRecord)
    : {};
}

function steps(value: unknown): WorkflowStep[] {
  return Array.isArray(value) ? (value as WorkflowStep[]) : [];
}

function sortedKeys(value: WorkflowRecord): string[] {
  return Object.keys(value).sort();
}

function validateUploadPlacement(
  errors: string[],
  jobName: string,
  jobSteps: readonly WorkflowStep[],
  upload: WorkflowStep,
): void {
  // The generate-matrix receipt is intentionally uploaded before candidate
  // checkout. Its exact pre-checkout position is enforced by workflow-boundary.
  if (jobName === "generate-matrix") return;
  const stepsAfterUpload = jobSteps.slice(jobSteps.indexOf(upload) + 1);
  if (
    stepsAfterUpload.length > 1 ||
    stepsAfterUpload.some((step) => step.name !== "Clean up Docker auth")
  ) {
    errors.push(
      `${jobName} upload-e2e-artifacts invocation must follow artifact producers and precede only Docker auth cleanup`,
    );
  }
}

export function validateUploadE2eArtifactsAction(actionPath = DEFAULT_ACTION_PATH): string[] {
  const source = readFileSync(actionPath, "utf8");
  const action = record(YAML.parse(source));
  const errors: string[] = [];

  if (
    createHash("sha256").update(source).digest("hex") !==
    UPLOAD_E2E_ARTIFACTS_ACTION_PROVENANCE.contentSha256
  ) {
    errors.push(
      "upload-e2e-artifacts content must match the action reviewed at its immutable commit pin",
    );
  }
  if (!isDeepStrictEqual(sortedKeys(action), ["description", "inputs", "name", "runs"])) {
    errors.push("upload-e2e-artifacts action must expose only its canonical top-level schema");
  }
  if (
    action.name !== "upload-e2e-artifacts" ||
    action.description !== "Upload the artifacts produced by an E2E target."
  ) {
    errors.push("upload-e2e-artifacts action identity must remain canonical");
  }
  if (!isDeepStrictEqual(record(action.inputs), EXPECTED_ACTION_INPUTS)) {
    errors.push("upload-e2e-artifacts action must expose only optional name and path inputs");
  }

  const runs = record(action.runs);
  if (runs.using !== "composite" || !isDeepStrictEqual(sortedKeys(runs), ["steps", "using"])) {
    errors.push("upload-e2e-artifacts must remain a composite action with canonical run keys");
  }
  const actionSteps = steps(runs.steps);
  if (actionSteps.length !== 1) {
    errors.push("upload-e2e-artifacts must contain exactly one inner upload step");
    return errors;
  }

  const upload = actionSteps[0];
  if (!isDeepStrictEqual(sortedKeys(upload), ["if", "name", "uses", "with"])) {
    errors.push("upload-e2e-artifacts inner step must not override its canonical contract");
  }
  if (upload.name !== "Upload E2E artifacts") {
    errors.push("upload-e2e-artifacts inner step name must remain canonical");
  }
  if (upload.if !== INNER_ALWAYS) {
    errors.push("upload-e2e-artifacts inner step must run with always()");
  }
  if (upload.uses !== UPLOAD_ARTIFACT_ACTION) {
    errors.push("upload-e2e-artifacts inner step must use the reviewed upload-artifact pin");
  }
  if (!isDeepStrictEqual(record(upload.with), EXPECTED_UPLOAD_POLICY)) {
    errors.push(
      "upload-e2e-artifacts must preserve artifact defaults, hidden-file policy, missing-file behavior, and retention",
    );
  }
  return errors;
}

export function validateUploadE2eArtifactsInvocations(workflow: WorkflowRecord): string[] {
  const errors: string[] = [];
  const jobs = record(workflow.jobs);
  const expectedJobs = new Set(
    Object.entries(jobs)
      .filter(([jobName, value]) => {
        const job = record(value);
        const jobSteps = steps(job.steps);
        const env = record(job.env);
        return (
          jobName === "staging-brev-launchable" ||
          jobName === "generate-matrix" ||
          jobName === "jetson-nvmap-gpu" ||
          jobName === "live" ||
          jobName === "native-runtime-qualification-podman-toolchain" ||
          jobName === "openshell-dev-artifact" ||
          jobName === RETIRED_SELECTOR_COMPATIBILITY_JOB ||
          env.E2E_JOB === "1" ||
          env.NEMOCLAW_RUN_LIVE_E2E === "1" ||
          SHARED_E2E_JOBS.has(jobName) ||
          jobSteps.some(
            (step) =>
              typeof step.run === "string" &&
              (step.run.includes("--project e2e-live") ||
                step.run.includes("tools/e2e/live-vitest-invocation.mts run --test-path")),
          )
        );
      })
      .map(([jobName]) => jobName),
  );
  for (const jobName of EXPLICIT_UPLOAD_CONTRACTS.keys()) {
    if (!expectedJobs.has(jobName)) {
      errors.push(`upload-e2e-artifacts explicit caller is missing: ${jobName}`);
    }
  }

  for (const jobName of SHARED_E2E_JOBS.keys()) {
    const value = jobs[jobName];
    if (value === undefined) {
      errors.push(`upload-e2e-artifacts shared job is missing: ${jobName}`);
      continue;
    }
    const env = record(record(value).env);
    if (Object.hasOwn(env, "E2E_JOB")) {
      errors.push(`${jobName} must not declare E2E_JOB`);
    }
    if (Object.hasOwn(env, "E2E_EXECUTION_PROFILE")) {
      errors.push(`${jobName} must not declare E2E_EXECUTION_PROFILE`);
    }
  }

  for (const [jobName, value] of Object.entries(jobs)) {
    const job = record(value);
    const jobSteps = steps(job.steps);
    const expected = expectedJobs.has(jobName);
    const exactManagedImageBuildCacheUploads = jobSteps.filter((step) =>
      isExactManagedImageBuildCacheUpload(jobName, step),
    );
    if (
      jobName === "managed-image-multiarch-startup" &&
      exactManagedImageBuildCacheUploads.length !== 1
    ) {
      errors.push(
        "managed-image-multiarch-startup must define exactly one exact protected build-cache direct upload",
      );
    }

    for (const step of jobSteps) {
      const uses = typeof step.uses === "string" ? step.uses : "";
      if (uses.startsWith(CHECKOUT_LOCAL_UPLOAD_E2E_ARTIFACTS_ACTION)) {
        errors.push(`${jobName} must not load upload-e2e-artifacts from the target checkout`);
      }
      const isExactCommitCliArtifactUpload =
        jobName === "generate-matrix" &&
        step.name === CLI_ARTIFACT_PUBLISH_STEP &&
        uses === CLI_ARTIFACT_UPLOAD_ACTION;
      if (
        uses.startsWith(UPLOAD_ARTIFACT_ACTION_PREFIX) &&
        !isExactCommitCliArtifactUpload &&
        !isExactManagedImageBuildCacheUpload(jobName, step) &&
        !isExactNativeRuntimeAggregateUpload(jobName, step)
      ) {
        errors.push(`${jobName} must not invoke actions/upload-artifact directly`);
      }
      if (
        uses.startsWith(UPLOAD_E2E_ARTIFACTS_ACTION_PREFIX) &&
        uses !== UPLOAD_E2E_ARTIFACTS_ACTION
      ) {
        errors.push(`${jobName} must use the reviewed immutable upload-e2e-artifacts reference`);
      }
    }

    const uploadSteps = jobSteps.filter((step) => step.uses === UPLOAD_E2E_ARTIFACTS_ACTION);
    if (jobName === "scorecard") {
      if (
        uploadSteps.length !== 1 ||
        !isDeepStrictEqual(uploadSteps[0], SCORECARD_RUNTIME_UPLOAD_CONTRACT)
      ) {
        errors.push(
          "scorecard must use upload-e2e-artifacts exactly once with its push runtime summary contract",
        );
        continue;
      }
      validateUploadPlacement(errors, jobName, jobSteps, uploadSteps[0]);
      continue;
    }
    if (!expected) {
      if (uploadSteps.length > 0) {
        errors.push(`${jobName} must not use upload-e2e-artifacts`);
      }
      continue;
    }
    if (uploadSteps.length !== 1) {
      errors.push(`${jobName} must use upload-e2e-artifacts exactly once`);
      continue;
    }

    const upload = uploadSteps[0];
    const explicitContract = EXPLICIT_UPLOAD_CONTRACTS.get(jobName);
    const allowedKeys = explicitContract ? ["if", "name", "uses", "with"] : ["if", "name", "uses"];
    if (!isDeepStrictEqual(sortedKeys(upload), allowedKeys)) {
      errors.push(`${jobName} upload-e2e-artifacts invocation must not override its contract`);
    }
    if (typeof upload.name !== "string" || upload.name.length === 0) {
      errors.push(`${jobName} upload-e2e-artifacts invocation must retain a step name`);
    }
    const expectedCallerCondition = EXPLICIT_CALLER_CONDITIONS.get(jobName) ?? CALLER_ALWAYS;
    if (upload.if !== expectedCallerCondition) {
      errors.push(
        expectedCallerCondition === CALLER_ALWAYS
          ? `${jobName} upload-e2e-artifacts invocation must run with always()`
          : `${jobName} upload-e2e-artifacts invocation must remain gated by its reviewed pre-upload checks`,
      );
    }
    validateUploadPlacement(errors, jobName, jobSteps, upload);

    if (explicitContract) {
      if (!isDeepStrictEqual(record(upload.with), explicitContract)) {
        errors.push(
          `${jobName} upload-e2e-artifacts must preserve its explicit name/path contract`,
        );
      }
      continue;
    }

    if (Object.hasOwn(upload, "with")) {
      errors.push(`${jobName} upload-e2e-artifacts must use the action defaults`);
    }
    const targetId = record(job.env).E2E_TARGET_ID;
    const sharedJobContract = SHARED_E2E_JOBS.get(jobName);
    if (sharedJobContract) {
      if (targetId !== sharedJobContract.targetId) {
        errors.push(
          `${jobName} default upload caller E2E_TARGET_ID must be '${sharedJobContract.targetId}'`,
        );
      }
      continue;
    }
    if (typeof targetId !== "string" || !TARGET_ID_PATTERN.test(targetId)) {
      errors.push(`${jobName} default upload caller must declare a valid E2E_TARGET_ID`);
    } else if (targetId !== jobName) {
      errors.push(`${jobName} default upload caller E2E_TARGET_ID must match its job id`);
    }
  }

  return errors;
}

export function validateUploadE2eArtifactsWorkflowBoundary(
  workflow: WorkflowRecord,
  actionPath = DEFAULT_ACTION_PATH,
): string[] {
  return [
    ...validateUploadE2eArtifactsAction(actionPath),
    ...validateUploadE2eArtifactsInvocations(workflow),
  ];
}
