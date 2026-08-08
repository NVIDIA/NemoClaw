// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";

import { describe, expect, it } from "vitest";

import { type CompositeAction, readYaml, type WorkflowJob } from "./helpers/e2e-workflow-contract";

type InstallerHashWorkflow = {
  permissions?: Record<string, string>;
  jobs: Record<string, WorkflowJob>;
};

type InstallerHashAction = CompositeAction & { inputs?: Record<string, { required?: boolean }> };

function requiredWorkflowStep(job: WorkflowJob, name: string) {
  const step = job.steps?.find((candidate) => candidate.name === name);
  assert(step, `Missing workflow step: ${name}`);
  return step;
}

describe("installer hash workflow", () => {
  const workflow = readYaml<InstallerHashWorkflow>(".github/workflows/installer-hash-check.yaml");
  const action = readYaml<InstallerHashAction>(
    ".github/actions/ci-installer-hash-check/action.yaml",
  );

  // source-shape-contract: security -- Installer integrity verification must remain independent from unrelated full E2E completion
  it("keeps installer verification independent from full E2E qualification", () => {
    const baseCheckout = requiredWorkflowStep(
      workflow.jobs["check-hash"],
      "Checkout base-trusted installer hash action",
    );

    expect(workflow.permissions).toEqual({ contents: "read" });
    expect(baseCheckout.with?.["sparse-checkout"]?.trim().split("\n")).toEqual([
      ".github/actions/ci-installer-hash-check",
      "scripts/check-installer-hash.sh",
      "scripts/checks/extract-installer-pins.mts",
    ]);
    expect(action.inputs?.["repo-root"]?.required).toBe(true);
    expect(action.runs.steps.map((step) => step.name)).toEqual([
      "Verify installer hashes are current",
    ]);
    expect(JSON.stringify({ action, workflow })).not.toContain(
      "verify-openshell-e2e-qualification",
    );
  });
});
