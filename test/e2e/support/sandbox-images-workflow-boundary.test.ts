// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";

import {
  readSandboxImagesWorkflow,
  validateSandboxImagesWorkflow,
} from "../../../tools/e2e/sandbox-images-workflow-boundary.mts";

function readWorkflows() {
  return {
    imageWorkflow: readSandboxImagesWorkflow(),
    mainWorkflow: readSandboxImagesWorkflow(".github/workflows/main.yaml"),
  };
}

describe("sandbox image workflow boundary", () => {
  it("reuses one guarded auth mapping and ends every image build with cleanup", () => {
    const { imageWorkflow } = readWorkflows();
    const jobNames = [
      "build-sandbox-images",
      "build-hermes-sandbox-image",
      "build-sandbox-images-arm64",
    ];
    const canonicalAuth = imageWorkflow.jobs["build-sandbox-images"].steps?.find(
      (step) => step.name === "Authenticate to Docker Hub",
    );
    expect(canonicalAuth).toBeDefined();

    for (const jobName of jobNames) {
      const job = imageWorkflow.jobs[jobName];
      const auth = job.steps?.find((step) => step.name === "Authenticate to Docker Hub");
      expect(auth, `${jobName} auth alias`).toBe(canonicalAuth);
      expect(job.steps?.at(-1)).toEqual({
        name: "Clean up Docker auth",
        if: "always()",
        shell: "bash",
        run: "bash .github/scripts/docker-auth-cleanup.sh",
      });
    }
  });

  it("rejects auth ordering drift, incomplete cleanup, and registry writes", () => {
    const { imageWorkflow, mainWorkflow } = readWorkflows();
    const hermes = imageWorkflow.jobs["build-hermes-sandbox-image"];
    const cleanup = hermes.steps!.pop()!;
    hermes.steps!.splice(2, 0, cleanup);
    const arm = imageWorkflow.jobs["build-sandbox-images-arm64"];
    const auth = arm.steps!.splice(1, 1)[0];
    arm.steps!.splice(3, 0, auth);
    const build = imageWorkflow.jobs["build-sandbox-images"].steps!.find(
      (step) => step.name === "Build production image",
    )!;
    build.run = `${build.run}\ndocker push registry.example.invalid/nemoclaw:test`;

    expect(validateSandboxImagesWorkflow(imageWorkflow, mainWorkflow)).toEqual(
      expect.arrayContaining([
        "build-hermes-sandbox-image Docker Hub cleanup must be the final step",
        "build-sandbox-images-arm64 Docker Hub auth must run immediately after checkout",
        "build-sandbox-images step 'Build production image' must not write images to a registry",
      ]),
    );
  });

  it("rejects an undersized timeout, rebuilding, or failing to reuse the OpenClaw image", () => {
    const { imageWorkflow, mainWorkflow } = readWorkflows();
    const openClaw = imageWorkflow.jobs["build-sandbox-images"];
    openClaw["timeout-minutes"] = 15;
    const runtime = openClaw.steps!.find(
      (step) => step.name === "Run runtime overrides test against production image",
    )!;
    runtime.env!.NEMOCLAW_TEST_IMAGE = "nemoclaw-runtime-overrides-rebuilt";
    runtime.run = `${runtime.run}\ndocker build -t nemoclaw-runtime-overrides-rebuilt .`;

    expect(validateSandboxImagesWorkflow(imageWorkflow, mainWorkflow)).toEqual(
      expect.arrayContaining([
        "build-sandbox-images timeout must cover the 45-minute runtime override budget",
        "runtime overrides must consume the prebuilt OpenClaw production image",
        "runtime overrides step must not rebuild the prebuilt image",
      ]),
    );
  });

  it("rejects rebuilding or failing to reuse the Hermes production image", () => {
    const { imageWorkflow, mainWorkflow } = readWorkflows();
    const rootEntrypoint = imageWorkflow.jobs["build-hermes-sandbox-image"].steps!.find(
      (step) => step.name === "Run Hermes root entrypoint smoke Vitest test",
    )!;
    rootEntrypoint.env!.NEMOCLAW_HERMES_TEST_IMAGE = "nemoclaw-hermes-rebuilt";
    rootEntrypoint.run = `${rootEntrypoint.run}\ndocker build -f agents/hermes/Dockerfile -t nemoclaw-hermes-rebuilt .`;

    expect(validateSandboxImagesWorkflow(imageWorkflow, mainWorkflow)).toEqual(
      expect.arrayContaining([
        "Hermes production image must have exactly one source build",
        "Hermes root entrypoint must consume the prebuilt Hermes production image",
        "Hermes root entrypoint step must not rebuild the prebuilt image",
      ]),
    );
  });

  it("removes duplicate runtime-only jobs from the general E2E workflow and scorecard", () => {
    const e2eWorkflow = readSandboxImagesWorkflow(".github/workflows/e2e.yaml");
    const removedJobs = [
      "runtime-overrides",
      "hermes-root-entrypoint-smoke",
      "hermes-sandbox-secret-boundary",
    ];

    for (const jobName of removedJobs) {
      expect(e2eWorkflow.jobs).not.toHaveProperty(jobName);
      expect(e2eWorkflow.jobs["report-to-pr"].needs).not.toContain(jobName);
    }
  });
});
