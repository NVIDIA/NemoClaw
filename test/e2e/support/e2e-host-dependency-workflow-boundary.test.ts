// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";

import { validateE2eWorkflow } from "../../../tools/e2e/workflow-boundary.mts";
import { readWorkflow as readE2eWorkflow } from "../../helpers/e2e-workflow-contract.ts";

interface WorkflowStep {
  name?: string;
  run?: string;
}

interface Workflow {
  jobs: Record<string, { steps: WorkflowStep[] }>;
}

function readWorkflow(): Workflow {
  return readE2eWorkflow() as unknown as Workflow;
}

function throwMissingStep(stepName: string): never {
  throw new Error(`${stepName} step is missing`);
}

function requireStepIndex(steps: WorkflowStep[], stepName: string): number {
  const index = steps.findIndex((step) => step.name === stepName);
  return index >= 0 ? index : throwMissingStep(stepName);
}

describe("inline E2E host dependency boundary", () => {
  it.each([
    {
      jobName: "live",
      stepName: "Install Deep Agents Code TUI host dependencies",
      expected:
        "live host dependency install must be exactly 'sudo apt-get install -y --no-install-recommends expect'",
    },
    {
      jobName: "network-policy",
      stepName: "Install network-policy host dependencies",
      expected:
        "network-policy host dependency install must be exactly 'sudo apt-get install -y --no-install-recommends expect'",
    },
    {
      jobName: "cloud-onboard",
      stepName: "Install cloud-onboard DCode TUI host dependencies",
      expected:
        "cloud-onboard host dependency install must be exactly 'sudo apt-get install -y --no-install-recommends expect'",
    },
    {
      jobName: "issue-4434-tui-unreachable-inference",
      stepName: "Install issue #4434 host dependencies",
      expected:
        "issue-4434-tui-unreachable-inference host dependency install must be exactly 'sudo apt-get install -y --no-install-recommends expect iptables'",
    },
    {
      jobName: "openclaw-tui-chat-correlation",
      stepName: "Install OpenClaw TUI host dependencies",
      expected:
        "openclaw-tui-chat-correlation host dependency install must be exactly 'sudo apt-get install -y --no-install-recommends expect'",
    },
  ])("rejects package allowlist drift in $jobName", ({ jobName, stepName, expected }) => {
    const workflow = readWorkflow();
    const install = workflow.jobs[jobName]?.steps.find((step) => step.name === stepName)!;
    install.run = (install.run ?? "").replace(/(sudo apt-get install[^\n]+)/u, "$1 curl");
    expect(validateE2eWorkflow(workflow)).toContain(expected);
  });

  it("rejects installing the OpenClaw TUI host dependency after workspace preparation", () => {
    const workflow = readWorkflow();
    const steps = workflow.jobs["openclaw-tui-chat-correlation"].steps;
    const installIndex = requireStepIndex(steps, "Install OpenClaw TUI host dependencies");
    const prepareIndex = requireStepIndex(steps, "Prepare E2E workspace");
    [steps[installIndex], steps[prepareIndex]] = [steps[prepareIndex]!, steps[installIndex]!];
    expect(validateE2eWorkflow(workflow)).toContain(
      "openclaw-tui-chat-correlation host dependencies must be installed before workspace prep",
    );
  });

  it("keeps cloud-onboard host dependencies before workspace preparation", () => {
    const workflow = readWorkflow();
    const steps = workflow.jobs["cloud-onboard"].steps;
    const installIndex = requireStepIndex(
      steps,
      "Install cloud-onboard DCode TUI host dependencies",
    );
    const install = steps.splice(installIndex, 1)[0]!;
    const prepareIndex = requireStepIndex(steps, "Prepare E2E workspace");
    steps.splice(prepareIndex + 1, 0, install);
    expect(validateE2eWorkflow(workflow)).toContain(
      "cloud-onboard DCode TUI host dependencies must precede workspace prep",
    );
  });
});
