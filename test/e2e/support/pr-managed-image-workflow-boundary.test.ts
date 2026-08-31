// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";

import {
  readE2eOperationsWorkflow,
  validateE2eOperationsWorkflow,
} from "../../../tools/e2e/operations-workflow-boundary.mts";

describe("manual PR managed-image workflow boundary", () => {
  it("requires the exact candidate catalog resolver before candidate checkout", () => {
    const workflow = readE2eOperationsWorkflow();
    const matrixJob = workflow.jobs["generate-matrix"];
    matrixJob.steps = matrixJob.steps!.filter(
      (step) => step.id !== "resolve_pr_managed_image_catalog",
    );

    expect(validateE2eOperationsWorkflow(workflow)).toContain(
      "Manual PR managed-image catalog must be authenticated before candidate checkout",
    );
  });

  it("requires the authenticated catalog to be sealed into the CLI artifact", () => {
    const workflow = readE2eOperationsWorkflow();
    const packageStep = workflow.jobs["generate-matrix"].steps!.find(
      (step) => step.name === "Package exact-commit CLI",
    )!;
    delete packageStep.env!.MANAGED_IMAGE_CATALOG_SHA256;

    expect(validateE2eOperationsWorkflow(workflow)).toContain(
      "Manual PR managed-image catalog must be sealed into the CLI artifact",
    );
  });

  it("rejects moving exact catalog resolution after candidate checkout", () => {
    const workflow = readE2eOperationsWorkflow();
    const matrixJob = workflow.jobs["generate-matrix"];
    const resolverIndex = matrixJob.steps!.findIndex(
      (step) => step.id === "resolve_pr_managed_image_catalog",
    );
    const [resolver] = matrixJob.steps!.splice(resolverIndex, 1);
    const checkoutIndex = matrixJob.steps!.findIndex(
      (step) => step.name === "Check out E2E candidate",
    );
    matrixJob.steps!.splice(checkoutIndex + 1, 0, resolver!);

    expect(validateE2eOperationsWorkflow(workflow)).toContain(
      "Manual PR managed-image catalog must be authenticated before candidate checkout",
    );
  });
});
