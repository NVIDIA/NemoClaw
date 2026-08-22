// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

export type Step = {
  env?: Record<string, unknown>;
  id?: string;
  if?: string;
  name?: string;
  run?: string;
  uses?: string;
  with?: Record<string, unknown>;
  "working-directory"?: string;
};

export type Action = {
  outputs?: Record<string, { description?: string; value?: string }>;
  runs?: { steps?: Step[] };
};

export type MatrixEntry = {
  agent?: string;
  arch?: string;
  artifact_platform?: string;
  base_alias?: string;
  base_dockerfile?: string;
  base_image?: string;
  base_repository?: string;
  display_name?: string;
  dockerfile?: string;
  image?: string;
  repository?: string;
  platform?: string;
  required_binary?: string;
  runner?: string;
};

export type Job = {
  env?: Record<string, unknown>;
  if?: string;
  needs?: string | string[];
  outputs?: Record<string, string>;
  permissions?: Record<string, string>;
  "runs-on"?: string;
  secrets?: Record<string, string> | "inherit";
  steps?: Step[];
  strategy?: {
    "fail-fast"?: boolean;
    matrix?: { include?: MatrixEntry[]; pass?: number[] };
  };
  "timeout-minutes"?: number;
  uses?: string;
  with?: Record<string, unknown>;
};

export type Workflow = {
  concurrency?: {
    "cancel-in-progress"?: string | boolean;
    group?: string;
  };
  env?: Record<string, string>;
  jobs?: Record<string, Job>;
  on?: {
    pull_request?: {
      branches?: string[];
      paths?: string[];
    };
    push?: {
      paths?: string[];
    };
    workflow_call?: {
      inputs?: Record<
        string,
        {
          default?: string | number | boolean;
          description?: string;
          required?: boolean;
          type?: string;
        }
      >;
      outputs?: Record<string, { description?: string; value?: string }>;
      secrets?: Record<string, { description?: string; required?: boolean }>;
    };
  };
  permissions?: Record<string, string>;
};
