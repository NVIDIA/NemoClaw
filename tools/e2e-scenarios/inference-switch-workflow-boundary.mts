// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { isDeepStrictEqual } from "node:util";
import YAML from "yaml";

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const DEFAULT_WORKFLOW_PATH = join(REPO_ROOT, ".github", "workflows", "e2e-vitest-scenarios.yaml");

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
    job: "hermes-inference-switch-vitest",
    scenario: "hermes-inference-switch",
    uploadStep: "Upload Hermes inference switch artifacts",
  },
  {
    agent: "openclaw",
    job: "openclaw-inference-switch-vitest",
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
    E2E_ARTIFACT_DIR: `\${{ github.workspace }}/e2e-artifacts/vitest/${spec.scenario}/\${{ matrix.mode }}`,
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
  if (upload?.with?.name !== `e2e-vitest-scenarios-${spec.scenario}-\${{ matrix.mode }}`) {
    errors.push(`${spec.job} artifact name must identify its mode`);
  }
  const artifactPath = String(upload?.with?.path ?? "");
  if (!artifactPath.includes(`e2e-artifacts/vitest/${spec.scenario}/\${{ matrix.mode }}/`)) {
    errors.push(`${spec.job} artifact path must identify its mode`);
  }
}

function validateOpenClawDockerAuth(errors: string[], job: WorkflowJob): void {
  const configure = job.steps?.find(
    (step) => step.name === "Configure isolated Docker auth directory",
  );
  const cleanup = job.steps?.find((step) => step.name === "Clean up Docker auth");
  const matrixPath = "docker-config-openclaw-inference-switch-${{ matrix.mode }}";
  if (!configure?.run?.includes(matrixPath)) {
    errors.push("openclaw-inference-switch-vitest Docker auth path must identify its mode");
  }
  if (!cleanup?.run?.includes(matrixPath) || !cleanup.run.includes('rm -rf "${docker_config}"')) {
    errors.push(
      "openclaw-inference-switch-vitest must always remove its mode-specific Docker auth",
    );
  }
  if (cleanup?.if !== "always()") {
    errors.push("openclaw-inference-switch-vitest Docker auth cleanup must always run");
  }

  const stepOrder = [
    "Build CLI",
    "Configure isolated Docker auth directory",
    "Authenticate to Docker Hub",
    "Run OpenClaw inference switch live test",
    "Clean up Docker auth",
    "Upload OpenClaw inference switch artifacts",
  ].map((name) => job.steps?.findIndex((step) => step.name === name) ?? -1);
  if (
    stepOrder.some(
      (index, position) => index < 0 || (position > 0 && index <= stepOrder[position - 1]),
    )
  ) {
    errors.push(
      "openclaw-inference-switch-vitest must build, authenticate, test, clean credentials, then upload",
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
  validateOpenClawDockerAuth(errors, workflow.jobs["openclaw-inference-switch-vitest"] ?? {});
  return errors;
}

export function validateInferenceSwitchWorkflowBoundary(
  workflowPath = DEFAULT_WORKFLOW_PATH,
): string[] {
  return validateInferenceSwitchWorkflow(readInferenceSwitchWorkflow(workflowPath));
}
