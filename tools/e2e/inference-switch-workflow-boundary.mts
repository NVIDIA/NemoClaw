// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { isDeepStrictEqual } from "node:util";
import YAML from "yaml";

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const DEFAULT_WORKFLOW_PATH = join(REPO_ROOT, ".github", "workflows", "e2e.yaml");

type WorkflowStep = {
  if?: string;
  name?: string;
  run?: string;
  with?: Record<string, unknown>;
};

type WorkflowJob = {
  env?: Record<string, unknown>;
  permissions?: { contents?: string };
  steps?: WorkflowStep[];
  strategy?: {
    "fail-fast"?: boolean;
    matrix?: { include?: Array<Record<string, unknown>> };
  };
};

export type InferenceSwitchWorkflow = {
  jobs: Record<string, WorkflowJob>;
};

type JobSpec = {
  agent: "hermes" | "openclaw";
  job: string;
  scenario: string;
  uploadStep: string;
};

const JOBS: JobSpec[] = [
  {
    agent: "hermes",
    job: "hermes-inference-switch",
    scenario: "hermes-inference-switch",
    uploadStep: "Upload Hermes inference switch artifacts",
  },
  {
    agent: "openclaw",
    job: "openclaw-inference-switch",
    scenario: "openclaw-inference-switch",
    uploadStep: "Upload OpenClaw inference switch artifacts",
  },
];

function expectedModes(agent: JobSpec["agent"]): Array<Record<string, unknown>> {
  return [
    {
      mode: "hosted",
      sandbox_name: `e2e-${agent}-inference-switch`,
      switch_provider: "compatible-endpoint",
      switch_model: "nvidia/nvidia/nemotron-3-super-v3",
      switch_inference_api: "openai-completions",
      switch_mock_anthropic: "0",
    },
    {
      mode: "anthropic",
      sandbox_name: `e2e-${agent}-anthropic-inference-switch`,
      switch_provider: "compatible-anthropic-endpoint",
      switch_model: "mock-anthropic-model",
      switch_inference_api: "anthropic-messages",
      switch_mock_anthropic: "1",
    },
  ];
}

function validateJob(errors: string[], spec: JobSpec, job: WorkflowJob): void {
  if (job.permissions?.contents !== "read") {
    errors.push(`${spec.job} must pin contents permission to read`);
  }
  if (job.strategy?.["fail-fast"] !== false) {
    errors.push(`${spec.job} mode matrix must not fail fast`);
  }
  if (!isDeepStrictEqual(job.strategy?.matrix?.include, expectedModes(spec.agent))) {
    errors.push(`${spec.job} must run the exact hosted and Anthropic-compatible modes`);
  }

  const requiredEnv: Record<string, unknown> = {
    E2E_ARTIFACT_DIR: `\${{ github.workspace }}/e2e-artifacts/live/${spec.scenario}/\${{ matrix.mode }}`,
    NEMOCLAW_AGENT: spec.agent,
    NEMOCLAW_SANDBOX_NAME: "${{ matrix.sandbox_name }}",
    NEMOCLAW_SWITCH_PROVIDER: "${{ matrix.switch_provider }}",
    NEMOCLAW_SWITCH_MODEL: "${{ matrix.switch_model }}",
    NEMOCLAW_SWITCH_INFERENCE_API: "${{ matrix.switch_inference_api }}",
    NEMOCLAW_SWITCH_MOCK_ANTHROPIC: "${{ matrix.switch_mock_anthropic }}",
  };
  for (const [name, value] of Object.entries(requiredEnv)) {
    if (job.env?.[name] !== value) errors.push(`${spec.job} must map ${name} from its mode matrix`);
  }

  const upload = job.steps?.find((step) => step.name === spec.uploadStep);
  if (upload?.with?.name !== `e2e-${spec.scenario}-\${{ matrix.mode }}`) {
    errors.push(`${spec.job} artifact name must identify its mode`);
  }
  const artifactPath = String(upload?.with?.path ?? "");
  if (!artifactPath.includes(`e2e-artifacts/live/${spec.scenario}/\${{ matrix.mode }}/`)) {
    errors.push(`${spec.job} artifact path must identify its mode`);
  }
}

function validateOpenClawDockerAuthOrder(errors: string[], job: WorkflowJob): void {
  const cleanup = job.steps?.find((step) => step.name === "Clean up Docker auth");
  if (cleanup?.if !== "always()") {
    errors.push("openclaw-inference-switch Docker auth cleanup must always run");
  }

  const stepOrder = [
    "Authenticate to Docker Hub",
    "Build CLI",
    "Run OpenClaw inference switch live test",
    "Upload OpenClaw inference switch artifacts",
    "Clean up Docker auth",
  ].map((name) => job.steps?.findIndex((step) => step.name === name) ?? -1);
  if (
    stepOrder.some(
      (index, position) => index < 0 || (position > 0 && index <= stepOrder[position - 1]),
    )
  ) {
    errors.push(
      "openclaw-inference-switch must authenticate, build, test, upload artifacts, then clean credentials",
    );
  }
}

export function readInferenceSwitchWorkflow(
  workflowPath = DEFAULT_WORKFLOW_PATH,
): InferenceSwitchWorkflow {
  return YAML.parse(readFileSync(workflowPath, "utf8")) as InferenceSwitchWorkflow;
}

export function validateInferenceSwitchWorkflow(workflow: InferenceSwitchWorkflow): string[] {
  const errors: string[] = [];
  for (const spec of JOBS) validateJob(errors, spec, workflow.jobs[spec.job] ?? {});
  validateOpenClawDockerAuthOrder(errors, workflow.jobs["openclaw-inference-switch"] ?? {});
  return errors;
}

export function validateInferenceSwitchWorkflowBoundary(
  workflowPath = DEFAULT_WORKFLOW_PATH,
): string[] {
  return validateInferenceSwitchWorkflow(readInferenceSwitchWorkflow(workflowPath));
}
