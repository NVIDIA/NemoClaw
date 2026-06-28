// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { describe, expect, it } from "vitest";
import YAML from "yaml";

import { validateE2eWorkflowBoundary } from "../../../tools/e2e/workflow-boundary.mts";

const WORKFLOW_PATH = path.join(process.cwd(), ".github/workflows/e2e.yaml");

interface WorkflowStep {
  name?: string;
  run?: string;
}

interface Workflow {
  jobs: Record<string, { steps: WorkflowStep[] }>;
}

function readWorkflow(): Workflow {
  return YAML.parse(fs.readFileSync(WORKFLOW_PATH, "utf8")) as Workflow;
}

describe("inline E2E host dependency boundary", () => {
  it.each([
    {
      jobName: "network-policy",
      stepName: "Install network-policy host dependencies",
      expected:
        "network-policy host dependency install must be exactly 'sudo apt-get install -y --no-install-recommends expect'",
    },
    {
      jobName: "issue-4434-tui-unreachable-inference",
      stepName: "Install issue #4434 host dependencies",
      expected:
        "issue-4434-tui-unreachable-inference host dependency install must be exactly 'sudo apt-get install -y --no-install-recommends expect iptables'",
    },
  ])("rejects package allowlist drift in $jobName", ({ jobName, stepName, expected }) => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "e2e-workflow-apt-allowlist-"));
    const workflowPath = path.join(tmp, "workflow.yaml");
    const workflow = readWorkflow();
    const install = workflow.jobs[jobName]?.steps.find((step) => step.name === stepName)!;
    install.run = (install.run ?? "").replace(/(sudo apt-get install[^\n]+)/u, "$1 curl");
    fs.writeFileSync(workflowPath, YAML.stringify(workflow));

    try {
      expect(validateE2eWorkflowBoundary(workflowPath)).toContain(expected);
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });
});
