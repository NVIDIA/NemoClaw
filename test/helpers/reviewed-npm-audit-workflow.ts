// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import fs from "node:fs";
import path from "node:path";
import YAML from "yaml";

type Workflow = {
  jobs?: Record<string, { steps?: Array<{ uses?: string }>; "timeout-minutes"?: number }>;
};

export function reviewedNpmAuditWorkflowDeadlines(workflowDirectory: string) {
  const callers: Array<{ job: string; timeoutMinutes: number; workflow: string }> = [];
  const workflowFiles = fs.readdirSync(workflowDirectory).filter((file) => /\.ya?ml$/u.test(file));
  for (const workflow of workflowFiles) {
    const parsed = YAML.parse(
      fs.readFileSync(path.join(workflowDirectory, workflow), "utf-8"),
    ) as Workflow;
    for (const [job, definition] of Object.entries(parsed.jobs ?? {})) {
      if (definition.steps?.some((step) => step.uses?.includes("ci-reviewed-npm-audit"))) {
        callers.push({ job, timeoutMinutes: definition["timeout-minutes"] ?? 0, workflow });
      }
    }
  }
  return callers;
}
