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

  it("builds Hermes once, reuses that image for both probes, and cleans up last", () => {
    const steps = workflow.jobs["build-hermes-sandbox-image"].steps ?? [];
    const build = requireStep(steps, "Build Hermes production image");
    const secretBoundary = requireStep(steps, "Run Hermes sandbox secret boundary test");
    const secretArtifacts = requireStep(steps, "Upload Hermes sandbox secret boundary artifacts");
    const rootEntrypoint = requireStep(steps, "Run Hermes root entrypoint smoke Vitest test");
    const rootArtifacts = requireStep(steps, "Upload Hermes root entrypoint smoke artifacts");
    const cleanup = requireStep(steps, "Clean up Docker auth");
    const buildCommand = 'docker build "${build_args[@]}" -t nemoclaw-hermes-production .';

    expect(steps.filter((step) => step.run?.includes(buildCommand))).toHaveLength(1);
    expect(build.step.run).toContain("build_args=(-f agents/hermes/Dockerfile");
    expect(build.step.run).toContain('scripts/check-production-build-args.sh "${build_args[@]}"');
    expect(build.step.run).toContain(buildCommand);
    expect(secretBoundary.step.env?.NEMOCLAW_HERMES_TEST_IMAGE).toBe("nemoclaw-hermes-production");
    expect(rootEntrypoint.step.env?.NEMOCLAW_HERMES_TEST_IMAGE).toBe("nemoclaw-hermes-production");
    expect(build.index).toBeLessThan(secretBoundary.index);
    expect(secretBoundary.index).toBeLessThan(secretArtifacts.index);
    expect(secretArtifacts.index).toBeLessThan(rootEntrypoint.index);
    expect(rootEntrypoint.index).toBeLessThan(rootArtifacts.index);
    expect(rootArtifacts.index).toBeLessThan(cleanup.index);
    expect(cleanup.index).toBe(steps.length - 1);
    expect(cleanup.step.if).toBe("always()");
  });
});
