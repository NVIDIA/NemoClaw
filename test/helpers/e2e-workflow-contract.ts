// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import YAML from "yaml";

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");

export type WorkflowJob = {
  "runs-on"?: string;
  "timeout-minutes"?: number;
  uses?: string;
  secrets?: Record<string, string>;
  steps?: WorkflowStep[];
  with?: Record<string, string>;
  strategy?: {
    "fail-fast"?: boolean;
    matrix?: Record<string, unknown>;
  };
};

export type WorkflowStep = {
  id?: string;
  name?: string;
  if?: string;
  uses?: string;
  with?: Record<string, unknown>;
  env?: Record<string, string>;
  run?: string;
};

export type NightlyWorkflow = {
  jobs: Record<string, WorkflowJob>;
};

export type RunnerWorkflow = {
  on?: {
    workflow_call?: {
      inputs?: Record<string, { default?: unknown }>;
    };
  };
  true?: {
    workflow_call?: {
      inputs?: Record<string, { default?: unknown }>;
    };
  };
  jobs: {
    run: {
      steps: WorkflowStep[];
    };
  };
};

export type CompositeAction = {
  inputs?: Record<string, { default?: unknown }>;
  runs: {
    steps: WorkflowStep[];
  };
};

export function readYaml<T>(path: string): T {
  return YAML.parse(readFileSync(join(REPO_ROOT, path), "utf-8")) as T;
}

export function loadE2eWorkflowContract(): {
  runnerWorkflow: RunnerWorkflow;
  nightlyWorkflow: NightlyWorkflow;
  action: CompositeAction;
  cliCoverageShardAction: CompositeAction;
} {
  return {
    runnerWorkflow: readYaml<RunnerWorkflow>(".github/workflows/e2e-script.yaml"),
    nightlyWorkflow: readYaml<NightlyWorkflow>(".github/workflows/nightly-e2e.yaml"),
    action: readYaml<CompositeAction>(".github/actions/run-e2e-script/action.yaml"),
    cliCoverageShardAction: readYaml<CompositeAction>(
      ".github/actions/ci-cli-coverage-shard/action.yaml",
    ),
  };
}

export function reusableNightlyJobs(
  nightlyWorkflow: NightlyWorkflow,
): Array<[string, WorkflowJob]> {
  return Object.entries(nightlyWorkflow.jobs).filter(
    ([, job]) => job.uses === "./.github/workflows/e2e-script.yaml",
  );
}
