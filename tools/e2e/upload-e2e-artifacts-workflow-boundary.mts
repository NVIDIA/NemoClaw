// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { isDeepStrictEqual } from "node:util";
import YAML from "yaml";

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const DEFAULT_ACTION_PATH = join(
  REPO_ROOT,
  ".github",
  "actions",
  "upload-e2e-artifacts",
  "action.yaml",
);

export const UPLOAD_E2E_ARTIFACTS_ACTION_PROVENANCE = {
  reference:
    "NVIDIA/NemoClaw/.github/actions/upload-e2e-artifacts@7768e15eb90d3ee2d33432f481dfe8747e4f6d57",
  contentSha256: "8f6f71a0e6d71d85418fa88c2b26a4d601f568bdcaae20aca4085ae423c5044b",
} as const;

export const UPLOAD_E2E_ARTIFACTS_ACTION = UPLOAD_E2E_ARTIFACTS_ACTION_PROVENANCE.reference;

const CHECKOUT_LOCAL_UPLOAD_E2E_ARTIFACTS_ACTION = "./.github/actions/upload-e2e-artifacts";
const UPLOAD_E2E_ARTIFACTS_ACTION_PREFIX = "NVIDIA/NemoClaw/.github/actions/upload-e2e-artifacts@";
const UPLOAD_ARTIFACT_ACTION = "actions/upload-artifact@043fb46d1a93c77aae656e7c1c64a875d1fc6a0a";
const UPLOAD_ARTIFACT_ACTION_PREFIX = "actions/upload-artifact@";
const INNER_ALWAYS = "${{ always() }}";
const CALLER_ALWAYS = "always()";
const TARGET_ID_PATTERN = /^[A-Za-z0-9_-]+$/;
const EXPECTED_UPLOAD_JOB_COUNT = 74;
const EXPECTED_DEFAULT_CALLER_COUNT = 65;

type WorkflowRecord = Record<string, unknown>;
type WorkflowStep = WorkflowRecord & {
  name?: string;
  if?: string;
  uses?: string;
  with?: WorkflowRecord;
};

type ExplicitUploadContract = {
  name: string;
  path: string;
};

const EXPLICIT_UPLOAD_CONTRACTS = new Map<string, ExplicitUploadContract>([
  [
    "live",
    {
      name: "e2e-${{ matrix.id }}",
      path: [
        "e2e-artifacts/live/${{ matrix.id }}/run-plan.json",
        "e2e-artifacts/live/${{ matrix.id }}/target.json",
        "e2e-artifacts/live/${{ matrix.id }}/target-result.json",
        "e2e-artifacts/live/${{ matrix.id }}/environment.result.json",
        "e2e-artifacts/live/${{ matrix.id }}/onboarding.result.json",
        "e2e-artifacts/live/${{ matrix.id }}/state-validation.result.json",
        "e2e-artifacts/live/${{ matrix.id }}/cloud-onboard-trace-timing-summary.json",
        "e2e-artifacts/live/${{ matrix.id }}/actions/",
        "e2e-artifacts/live/${{ matrix.id }}/logs/",
        "e2e-artifacts/live/${{ matrix.id }}/shell/",
        "",
      ].join("\n"),
    },
  ],
  [
    "skill-agent",
    {
      name: "e2e-skill-agent",
      path: [
        "e2e-artifacts/live/skill-agent/*/artifact-summary.json",
        "e2e-artifacts/live/skill-agent/*/cleanup.json",
        "e2e-artifacts/live/skill-agent/*/cleanup-skill-agent-summary.json",
        "e2e-artifacts/live/skill-agent/*/target.json",
        "e2e-artifacts/live/skill-agent/*/target-result.json",
        "e2e-artifacts/live/skill-agent/*/shell/*.result.json",
        "e2e-artifacts/live/skill-agent/*/shell/*.stdout.txt",
        "e2e-artifacts/live/skill-agent/*/shell/*.stderr.txt",
        "",
      ].join("\n"),
    },
  ],
  [
    "hermes-inference-switch",
    {
      name: "e2e-hermes-inference-switch-${{ matrix.mode }}",
      path: "e2e-artifacts/live/hermes-inference-switch/${{ matrix.mode }}/",
    },
  ],
  [
    "hermes-slack",
    {
      name: "e2e-hermes-slack",
      path: "e2e-artifacts/live/hermes-slack-e2e/",
    },
  ],
  [
    "shields-config",
    {
      name: "e2e-shields-config",
      path: "e2e-artifacts/live/shields-config/\n",
    },
  ],
  [
    "security-posture",
    {
      name: "e2e-security-posture-${{ matrix.agent }}",
      path: "e2e-artifacts/live/security-posture-${{ matrix.agent }}/",
    },
  ],
  [
    "openclaw-inference-switch",
    {
      name: "e2e-openclaw-inference-switch-${{ matrix.mode }}",
      path: "e2e-artifacts/live/openclaw-inference-switch/${{ matrix.mode }}/",
    },
  ],
  [
    "bedrock-runtime-compatible-anthropic",
    {
      name: "e2e-bedrock-runtime-compatible-anthropic-${{ matrix.agent }}",
      path: "e2e-artifacts/live/bedrock-runtime-compatible-anthropic/${{ matrix.agent }}/",
    },
  ],
  [
    "channels-stop-start",
    {
      name: "e2e-channels-stop-start-${{ matrix.agent }}",
      path: "e2e-artifacts/live/channels-stop-start/${{ matrix.agent }}/",
    },
  ],
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
        return jobName === "live" || record(job.env).E2E_JOB === "1";
      })
      .map(([jobName]) => jobName),
  );
  const defaultJobs = [...expectedJobs].filter(
    (jobName) => !EXPLICIT_UPLOAD_CONTRACTS.has(jobName),
  );

  if (expectedJobs.size !== EXPECTED_UPLOAD_JOB_COUNT) {
    errors.push(
      `upload-e2e-artifacts must cover exactly ${EXPECTED_UPLOAD_JOB_COUNT} live and E2E_JOB execution jobs`,
    );
  }
  if (defaultJobs.length !== EXPECTED_DEFAULT_CALLER_COUNT) {
    errors.push(
      `upload-e2e-artifacts must keep exactly ${EXPECTED_DEFAULT_CALLER_COUNT} default callers`,
    );
  }
  for (const jobName of EXPLICIT_UPLOAD_CONTRACTS.keys()) {
    if (!expectedJobs.has(jobName)) {
      errors.push(`upload-e2e-artifacts explicit caller is missing: ${jobName}`);
    }
  }

  for (const [jobName, value] of Object.entries(jobs)) {
    const job = record(value);
    const jobSteps = steps(job.steps);
    const expected = expectedJobs.has(jobName);

    for (const step of jobSteps) {
      const uses = typeof step.uses === "string" ? step.uses : "";
      if (uses.startsWith(CHECKOUT_LOCAL_UPLOAD_E2E_ARTIFACTS_ACTION)) {
        errors.push(`${jobName} must not load upload-e2e-artifacts from the target checkout`);
      }
      if (uses.startsWith(UPLOAD_ARTIFACT_ACTION_PREFIX)) {
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
    if (upload.if !== CALLER_ALWAYS) {
      errors.push(`${jobName} upload-e2e-artifacts invocation must run with always()`);
    }
    const stepsAfterUpload = jobSteps.slice(jobSteps.indexOf(upload) + 1);
    if (
      stepsAfterUpload.length > 1 ||
      stepsAfterUpload.some((step) => step.name !== "Clean up Docker auth")
    ) {
      errors.push(
        `${jobName} upload-e2e-artifacts invocation must follow artifact producers and precede only Docker auth cleanup`,
      );
    }

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
