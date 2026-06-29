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
