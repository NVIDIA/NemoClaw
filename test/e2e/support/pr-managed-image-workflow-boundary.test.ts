// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";

import {
  readE2eOperationsWorkflow,
  validateE2eOperationsWorkflow,
} from "../../../tools/e2e/operations-workflow-boundary.mts";

describe("manual PR managed-image workflow boundary", () => {
  it.each([
    ["workflow", (workflow: ReturnType<typeof readE2eOperationsWorkflow>) => workflow],
    [
      "generate-matrix job",
      (workflow: ReturnType<typeof readE2eOperationsWorkflow>) => workflow.jobs["generate-matrix"],
    ],
  ])("rejects obsolete catalog inputs inherited from the %s environment", (_scope, target) => {
    const workflow = readE2eOperationsWorkflow();
    target(workflow).env = {
      MANAGED_IMAGE_CATALOG: "candidate catalog",
      MANAGED_IMAGE_CATALOG_SHA256: "candidate digest",
    };

    expect(validateE2eOperationsWorkflow(workflow)).toContain(
      "Manual PR CLI packaging must not accept obsolete managed-image catalog authority",
    );
  });

  it("rejects an obsolete staged catalog reference in CLI packaging", () => {
    const workflow = readE2eOperationsWorkflow();
    const packageStep = workflow.jobs["generate-matrix"].steps!.find(
      (step) => step.name === "Package exact-commit CLI",
    )!;
    packageStep.run = `${packageStep.run ?? ""}\ncat pr-managed-image-catalog.json\n`;

    expect(validateE2eOperationsWorkflow(workflow)).toContain(
      "Manual PR CLI packaging must not accept obsolete managed-image catalog authority",
    );
  });

  it("rejects restoration of the obsolete manual PR catalog resolver", () => {
    const workflow = readE2eOperationsWorkflow();
    const matrixJob = workflow.jobs["generate-matrix"];
    matrixJob.outputs!.managed_image_catalog =
      "${{ steps.resolve_pr_managed_image_catalog.outputs.catalog }}";
    const checkoutIndex = matrixJob.steps!.findIndex(
      (step) => step.name === "Check out E2E candidate",
    );
    matrixJob.steps!.splice(checkoutIndex, 0, {
      id: "resolve_pr_managed_image_catalog",
      name: "Resolve exact PR managed-image catalog",
      shell: "bash",
      run: "node tools/e2e/pr-managed-image-publication.mts catalog.json",
    });
    const packageStep = matrixJob.steps!.find((step) => step.name === "Package exact-commit CLI")!;
    packageStep.env!.MANAGED_IMAGE_CATALOG =
      "${{ steps.resolve_pr_managed_image_catalog.outputs.catalog }}";

    expect(validateE2eOperationsWorkflow(workflow)).toEqual(
      expect.arrayContaining([
        "Manual PR E2E must not resolve an exact candidate managed-image catalog",
        "Manual PR CLI packaging must not accept obsolete managed-image catalog authority",
      ]),
    );
  });
});
