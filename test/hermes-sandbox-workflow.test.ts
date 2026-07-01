// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";

import { readYaml, type WorkflowJob, type WorkflowStep } from "./helpers/e2e-workflow-contract";

const workflow = readYaml<{ jobs: Record<string, WorkflowJob> }>(
  ".github/workflows/sandbox-images-and-e2e.yaml",
);

function requireStep(steps: WorkflowStep[], name: string): { index: number; step: WorkflowStep } {
  const index = steps.findIndex((step) => step.name === name);
  expect(index, `missing workflow step: ${name}`).toBeGreaterThanOrEqual(0);
  return { index, step: steps[index] };
}

describe("Hermes sandbox image workflow", () => {
  it("installs pinned root dependencies before either Vitest invocation", () => {
    const steps = workflow.jobs["build-hermes-sandbox-image"].steps ?? [];
    const setup = requireStep(steps, "Set up Node");
    const install = requireStep(steps, "Install root dependencies");
    const secretBoundary = requireStep(steps, "Run Hermes sandbox secret boundary test");
    const rootEntrypoint = requireStep(steps, "Run Hermes root entrypoint smoke Vitest test");

    expect(setup.step.uses).toBe("actions/setup-node@48b55a011bda9f5d6aeb4c2d9c7362e8dae4041e");
    expect(install.step.run).toBe("npm ci --ignore-scripts");
    expect(setup.index).toBeLessThan(install.index);
    expect(install.index).toBeLessThan(secretBoundary.index);
    expect(install.index).toBeLessThan(rootEntrypoint.index);
  });
});
