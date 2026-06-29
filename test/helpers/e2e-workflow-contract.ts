// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import YAML from "yaml";

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");

export type WorkflowJob = {
  if?: string;
  needs?: string | string[];
  "runs-on"?: string;
  "timeout-minutes"?: number;
  uses?: string;
  env?: Record<string, string>;
  secrets?: Record<string, string>;
  steps?: WorkflowStep[];
  with?: Record<string, string>;
  strategy?: {
    "fail-fast"?: boolean;
    matrix?: Record<string, unknown>;
  };
};

export type WorkflowStep = {
  "continue-on-error"?: boolean;
  id?: string;
  name?: string;
  if?: string;
  uses?: string;
  with?: Record<string, unknown>;
  env?: Record<string, string>;
  run?: string;
};

export type Workflow = {
  jobs: Record<string, WorkflowJob>;
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

export function readWorkflow(): Record<string, unknown> {
  return readYaml(".github/workflows/e2e.yaml");
}

export function removeJobNeed(source: string, ownerJob: string, dependency: string): string {
  const ownerHeader = `  ${ownerJob}:\n`;
  const ownerStart = source.indexOf(ownerHeader);
  if (ownerStart < 0) {
    throw new Error(`workflow is missing job ${ownerJob}`);
  }
  const prefix = source.slice(0, ownerStart);
  const afterOwnerHeader = ownerStart + ownerHeader.length;
  const nextJobOffset = source.slice(afterOwnerHeader).search(/^  [\w-]+:\n/mu);
  const ownerEnd = nextJobOffset < 0 ? source.length : afterOwnerHeader + nextJobOffset;
  const ownerBlock = source.slice(ownerStart, ownerEnd);
  const needle = `        ${dependency},\n`;
  if (!ownerBlock.includes(needle)) {
    throw new Error(`${ownerJob} does not need ${dependency}`);
  }
  return prefix + ownerBlock.replace(needle, "") + source.slice(ownerEnd);
}
