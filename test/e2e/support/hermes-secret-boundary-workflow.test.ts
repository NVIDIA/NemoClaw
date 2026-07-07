// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";

import {
  readSandboxImagesWorkflow,
  validateSandboxImagesWorkflow,
  validateSandboxImagesWorkflowBoundary,
} from "../../../tools/e2e/sandbox-images-workflow-boundary.mts";

function readWorkflows() {
  return {
    imageWorkflow: readSandboxImagesWorkflow(),
    mainWorkflow: readSandboxImagesWorkflow(".github/workflows/main.yaml"),
  };
}

describe("Hermes image workflow secret boundary", () => {
  it("keeps the consolidated image workflow inside its audited boundary", () => {
    expect(validateSandboxImagesWorkflowBoundary()).toEqual([]);
  });

  it("rejects broad Hermes job and test-step secret scope", () => {
    const { imageWorkflow, mainWorkflow } = readWorkflows();
    const job = imageWorkflow.jobs["build-hermes-sandbox-image"];
    job.env = {
      NVIDIA_INFERENCE_API_KEY: "${{ secrets.NVIDIA_INFERENCE_API_KEY }}",
      DOCKERHUB_USERNAME: "${{ secrets.DOCKERHUB_USERNAME }}",
      DOCKERHUB_TOKEN: "${{ secrets.DOCKERHUB_TOKEN }}",
    };
    const secretBoundary = job.steps?.find(
      (step) => step.name === "Run Hermes sandbox secret boundary test",
    );
    expect(secretBoundary).toBeDefined();
    secretBoundary!.env = {
      ...secretBoundary!.env,
      NVIDIA_INFERENCE_API_KEY: "${{ secrets.NVIDIA_INFERENCE_API_KEY }}",
      DOCKERHUB_TOKEN: "${{ secrets.DOCKERHUB_TOKEN }}",
    };

    expect(validateSandboxImagesWorkflow(imageWorkflow, mainWorkflow)).toEqual(
      expect.arrayContaining([
        "build-hermes-sandbox-image must not expose NVIDIA_INFERENCE_API_KEY at job scope",
        "build-hermes-sandbox-image must not expose DOCKERHUB_USERNAME at job scope",
        "build-hermes-sandbox-image must not expose DOCKERHUB_TOKEN at job scope",
        "build-hermes-sandbox-image step 'Run Hermes sandbox secret boundary test' must not receive NVIDIA_INFERENCE_API_KEY",
        "build-hermes-sandbox-image step 'Run Hermes sandbox secret boundary test' must not receive DOCKERHUB_TOKEN",
      ]),
    );
  });

  it("rejects branch-visible Docker Hub credentials and broad reusable-workflow forwarding", () => {
    const { imageWorkflow, mainWorkflow } = readWorkflows();
    const auth = imageWorkflow.jobs["build-sandbox-images"].steps?.find(
      (step) => step.name === "Authenticate to Docker Hub",
    );
    expect(auth).toBeDefined();
    auth!.env = {
      ...auth!.env,
      DOCKERHUB_TOKEN: "${{ secrets.DOCKERHUB_TOKEN }}",
    };
    auth!.run = auth!.run?.replaceAll("exit 1", "exit 0");
    mainWorkflow.jobs["sandbox-images-and-e2e"].secrets = {
      inherit: true,
    };

    expect(validateSandboxImagesWorkflow(imageWorkflow, mainWorkflow)).toEqual(
      expect.arrayContaining([
        "sandbox image Docker Hub credentials must be gated to trusted main push/manual runs",
        "sandbox image Docker Hub auth must fail closed on missing credentials and retries",
        "main sandbox image caller must map only the optional Docker Hub secrets explicitly",
      ]),
    );
  });
});
