// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";

import { describe, expect, it } from "vitest";

import {
  type CompositeAction,
  readYaml,
  type WorkflowJob,
  type WorkflowStep,
} from "./helpers/e2e-workflow-contract";

type InstallerHashWorkflow = {
  permissions?: Record<string, string>;
  jobs: Record<string, WorkflowJob>;
};

type InstallerHashAction = CompositeAction & {
  inputs?: Record<string, { required?: boolean }>;
};

function requiredActionStep(action: CompositeAction, name: string): WorkflowStep {
  const step = action.runs.steps.find((candidate) => candidate.name === name);
  assert(step, `Missing action step: ${name}`);
  return step;
}

function requiredWorkflowStep(job: WorkflowJob, name: string): WorkflowStep {
  const step = job.steps?.find((candidate) => candidate.name === name);
  assert(step, `Missing workflow step: ${name}`);
  return step;
}

describe("OpenShell exact-head qualification workflow", () => {
  const workflow = readYaml<InstallerHashWorkflow>(".github/workflows/installer-hash-check.yaml");
  const action = readYaml<InstallerHashAction>(
    ".github/actions/ci-installer-hash-check/action.yaml",
  );

  // source-shape-contract: security -- OpenShell-sensitive PRs require exact-head live evidence through base-trusted code
  it("keeps OpenShell E2E qualification inside the trusted composite action", () => {
    const baseCheckout = requiredWorkflowStep(
      workflow.jobs["check-hash"],
      "Checkout base-trusted installer hash action",
    );
    const qualification = requiredActionStep(
      action,
      "Require exact-head OpenShell E2E qualification",
    );

    expect(workflow.permissions).toEqual({
      actions: "read",
      checks: "read",
      contents: "read",
      "pull-requests": "read",
    });
    for (const trustedPath of [
      ".github/workflows/e2e.yaml",
      "nemoclaw-blueprint/blueprint.yaml",
      "scripts/brev-launchable-ci-cpu.sh",
      "scripts/check-installer-hash.sh",
      "scripts/checks/extract-installer-pins.mts",
      "scripts/checks/verify-openshell-e2e-qualification.mts",
      "scripts/install-openshell.sh",
      "scripts/scorecard/read-artifact-zip.mts",
    ]) {
      expect(baseCheckout.with?.["sparse-checkout"], trustedPath).toContain(trustedPath);
    }
    expect(action.inputs?.["repo-root"]?.required).toBe(true);
    expect(qualification.if).toBe("${{ github.event_name == 'pull_request' }}");
    expect(qualification.env).toEqual({
      BASE_SHA: "${{ github.event.pull_request.base.sha }}",
      CANDIDATE_SHA: "${{ github.event.pull_request.head.sha }}",
      GITHUB_TOKEN: "${{ github.token }}",
      PR_NUMBER: "${{ github.event.pull_request.number }}",
      REPOSITORY: "${{ github.repository }}",
    });
    expect(qualification.run).toContain(
      '"${{ github.action_path }}/../../../scripts/checks/verify-openshell-e2e-qualification.mts"',
    );
    expect(qualification.run).toContain('--base-root "${{ github.action_path }}/../../.."');
    expect(qualification.run).toContain('--candidate-root "${{ inputs.repo-root }}"');
    expect(qualification.run).toContain('--candidate-sha "$CANDIDATE_SHA"');
    expect(qualification.run).toContain('--base-sha "$BASE_SHA"');
    expect(qualification.run).toContain('--workflow-sha "$BASE_SHA"');
    expect(qualification.run).not.toContain("$GITHUB_TOKEN");
    expect(
      action.runs.steps.findIndex((step) => step.name === "Verify installer hashes are current"),
    ).toBeLessThan(
      action.runs.steps.findIndex(
        (step) => step.name === "Require exact-head OpenShell E2E qualification",
      ),
    );
  });
});
