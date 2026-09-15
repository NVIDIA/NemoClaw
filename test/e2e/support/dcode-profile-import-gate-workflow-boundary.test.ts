// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import fs from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";
import YAML from "yaml";

import { readWorkflow as readMainWorkflow } from "../../helpers/e2e-workflow-contract";

import { validateStandardProfileWorkflowBoundary } from "../../../tools/e2e/standard-profile-workflow-boundary.mts";

const WORKFLOW_PATH = path.join(process.cwd(), ".github/workflows/e2e-standard-profile.yaml");
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

function liveGateStep(workflow: Workflow): WorkflowStep {
  return workflow.jobs.run.steps.find((step) => step.name === GATE_STEP_NAME)!;
}

describe("DCode missing-dependency profile import gate workflow boundary", () => {
  it("rejects replacing the reviewed gate with a mutable registry base", () => {
    const workflow = readWorkflow();
    liveGateStep(workflow).run =
      "docker pull ghcr.io/nvidia/nemoclaw/langchain-deepagents-code-sandbox-base:latest && docker tag ghcr.io/nvidia/nemoclaw/langchain-deepagents-code-sandbox-base:latest nemoclaw-dcode-profile-source-base:mutable";
    const errors = validateStandardProfileWorkflowBoundary(readMainWorkflow(), workflow);

    expect(errors).toContain(
      "live DCode profile import gate must run the reviewed negative-build script",
    );
  });

  it("rejects widening the negative build beyond the typed DCode target", () => {
    const workflow = readWorkflow();
    liveGateStep(workflow).if = "${{ always() }}";
    const errors = validateStandardProfileWorkflowBoundary(readMainWorkflow(), workflow);

    expect(errors).toContain(
      "live DCode profile import gate must be scoped to the typed DCode target",
    );
  });

  it("rejects a mutable registry base override", () => {
    const workflow = readWorkflow();
    liveGateStep(workflow).env = {
      NEMOCLAW_DCODE_PROFILE_GATE_BASE_IMAGE:
        "ghcr.io/nvidia/nemoclaw/langchain-deepagents-code-sandbox-base:latest",
    };
    const errors = validateStandardProfileWorkflowBoundary(readMainWorkflow(), workflow);

    expect(errors).toContain(
      "live DCode profile import gate must build the reviewed repository base without an override",
    );
  });

  it("rejects routing the local image chain through a containerized Buildx builder", () => {
    const workflow = readWorkflow();
    const steps = workflow.jobs.run.steps;
    steps.splice(steps.indexOf(liveGateStep(workflow)), 0, {
      if: "${{ inputs.target_id == 'ubuntu-repo-cloud-langchain-deepagents-code' && inputs.runtime_provider == 'docker' }}",
      name: "Route DCode builds through Buildx",
      run: "printf 'BUILDX_BUILDER=%s\\n' external >> \"${GITHUB_ENV}\"",
    });
    const errors = validateStandardProfileWorkflowBoundary(readMainWorkflow(), workflow);

    expect(errors).toContain(
      "live DCode profile import gate must keep its local image chain on the Docker engine",
    );
  });

  it("rejects multiline environment-file routing through a containerized Buildx builder", () => {
    const workflow = readWorkflow();
    const steps = workflow.jobs.run.steps;
    steps.splice(steps.indexOf(liveGateStep(workflow)), 0, {
      if: "${{ inputs.target_id == 'ubuntu-repo-cloud-langchain-deepagents-code' && inputs.runtime_provider == 'docker' }}",
      name: "Persist DCode Buildx through the environment file",
      run: "printf '%s\\n' 'BUILDX_BUILDER<<EOF' 'external' 'EOF' >> \"$GITHUB_ENV\"",
    });
    const errors = validateStandardProfileWorkflowBoundary(readMainWorkflow(), workflow);

    expect(errors).toContain(
      "live DCode profile import gate must keep its local image chain on the Docker engine",
    );
  });

  it("rejects selecting a persistent Buildx builder before the local image chain", () => {
    const workflow = readWorkflow();
    const steps = workflow.jobs.run.steps;
    steps.splice(steps.indexOf(liveGateStep(workflow)), 0, {
      if: "${{ inputs.target_id == 'ubuntu-repo-cloud-langchain-deepagents-code' && inputs.runtime_provider == 'docker' }}",
      name: "Select DCode Buildx builder",
      run: "docker buildx use external",
    });
    const errors = validateStandardProfileWorkflowBoundary(readMainWorkflow(), workflow);

    expect(errors).toContain(
      "live DCode profile import gate must keep its local image chain on the Docker engine",
    );
  });

  it("rejects moving the import gate after live inference", () => {
    const workflow = readWorkflow();
    const steps = workflow.jobs.run.steps;
    const gate = liveGateStep(workflow);
    steps.splice(steps.indexOf(gate), 1);
    steps.push(gate);
    const errors = validateStandardProfileWorkflowBoundary(readMainWorkflow(), workflow);

    expect(errors).toContain("live DCode profile import gate must run before live E2E tests");
  });

  it("rejects moving the import gate before workspace prep", () => {
    const workflow = readWorkflow();
    const steps = workflow.jobs.run.steps;
    const gate = liveGateStep(workflow);
    steps.splice(steps.indexOf(gate), 1);
    steps.unshift(gate);
    const errors = validateStandardProfileWorkflowBoundary(readMainWorkflow(), workflow);

    expect(errors).toContain("live DCode profile import gate must run after workspace prep");
  });

  it("rejects moving Docker auth cleanup before the import gate", () => {
    const workflow = readWorkflow();
    const steps = workflow.jobs.run.steps;
    const cleanup = steps.find((step) => step.name === CLEANUP_STEP_NAME)!;
    steps.splice(steps.indexOf(cleanup), 1);
    steps.splice(steps.indexOf(liveGateStep(workflow)), 0, cleanup);
    const errors = validateStandardProfileWorkflowBoundary(readMainWorkflow(), workflow);

    expect(errors).toContain(
      "standard E2E profile must always clean up Docker authentication last",
    );
  });

  it("rejects running the import gate with a non-bash shell", () => {
    const workflow = readWorkflow();
    liveGateStep(workflow).shell = "sh";
    const errors = validateStandardProfileWorkflowBoundary(readMainWorkflow(), workflow);

    expect(errors).toContain("live DCode profile import gate must use bash");
  });
});
