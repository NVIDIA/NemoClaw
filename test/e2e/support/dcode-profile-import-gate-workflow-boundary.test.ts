// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { describe, expect, it } from "vitest";
import YAML from "yaml";

import { validateE2eWorkflowBoundary } from "../../../tools/e2e/workflow-boundary.mts";

const WORKFLOW_PATH = path.join(process.cwd(), ".github/workflows/e2e.yaml");
const GATE_STEP_NAME = "Verify DCode profile import gate rejects missing base dependencies";
const CLEANUP_STEP_NAME = "Clean up Docker auth";

type WorkflowStep = {
  env?: Record<string, string>;
  if?: string;
  name?: string;
  run?: string;
  shell?: string;
};

type Workflow = {
  jobs: Record<string, { steps: WorkflowStep[] }>;
};

function readWorkflow(): Workflow {
  return YAML.parse(fs.readFileSync(WORKFLOW_PATH, "utf8")) as Workflow;
}

function validateMutation(mutate: (workflow: Workflow) => void): string[] {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "dcode-profile-import-gate-workflow-"));
  const workflowPath = path.join(tmp, "workflow.yaml");
  const workflow = readWorkflow();
  mutate(workflow);
  fs.writeFileSync(workflowPath, YAML.stringify(workflow));
  try {
    return validateE2eWorkflowBoundary(workflowPath);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}

function liveGateStep(workflow: Workflow): WorkflowStep {
  return workflow.jobs.live.steps.find((step) => step.name === GATE_STEP_NAME)!;
}

describe("DCode missing-dependency profile import gate workflow boundary", () => {
  it("rejects replacing the reviewed gate with a mutable registry base", () => {
    const errors = validateMutation((workflow) => {
      liveGateStep(workflow).run =
        "docker pull ghcr.io/nvidia/nemoclaw/langchain-deepagents-code-sandbox-base:latest && docker tag ghcr.io/nvidia/nemoclaw/langchain-deepagents-code-sandbox-base:latest nemoclaw-dcode-profile-source-base:mutable";
    });

    expect(errors).toContain(
      "live DCode profile import gate must run the reviewed negative-build script",
    );
  });

  it("rejects widening the negative build beyond the typed DCode target", () => {
    const errors = validateMutation((workflow) => {
      liveGateStep(workflow).if = "${{ always() }}";
    });

    expect(errors).toContain(
      "live DCode profile import gate must be scoped to the typed DCode target",
    );
  });

  it("rejects a mutable registry base override", () => {
    const errors = validateMutation((workflow) => {
      liveGateStep(workflow).env = {
        NEMOCLAW_DCODE_PROFILE_GATE_BASE_IMAGE:
          "ghcr.io/nvidia/nemoclaw/langchain-deepagents-code-sandbox-base:latest",
      };
    });

    expect(errors).toContain(
      "live DCode profile import gate must build the reviewed repository base without an override",
    );
  });

  it("rejects moving the import gate after live inference", () => {
    const errors = validateMutation((workflow) => {
      const steps = workflow.jobs.live.steps;
      const gate = liveGateStep(workflow);
      steps.splice(steps.indexOf(gate), 1);
      steps.push(gate);
    });

    expect(errors).toContain("live DCode profile import gate must run before live E2E tests");
  });

  it("rejects moving the import gate before workspace prep", () => {
    const errors = validateMutation((workflow) => {
      const steps = workflow.jobs.live.steps;
      const gate = liveGateStep(workflow);
      steps.splice(steps.indexOf(gate), 1);
      steps.unshift(gate);
    });

    expect(errors).toContain("live DCode profile import gate must run after workspace prep");
  });

  it("rejects moving Docker auth cleanup before the import gate", () => {
    const errors = validateMutation((workflow) => {
      const steps = workflow.jobs.live.steps;
      const cleanup = steps.find((step) => step.name === CLEANUP_STEP_NAME)!;
      steps.splice(steps.indexOf(cleanup), 1);
      steps.splice(steps.indexOf(liveGateStep(workflow)), 0, cleanup);
    });

    expect(errors).toContain("live Docker Hub cleanup must be the final job step");
  });

  it("rejects running the import gate with a non-bash shell", () => {
    const errors = validateMutation((workflow) => {
      liveGateStep(workflow).shell = "sh";
    });

    expect(errors).toContain("live DCode profile import gate must use bash");
  });
});
