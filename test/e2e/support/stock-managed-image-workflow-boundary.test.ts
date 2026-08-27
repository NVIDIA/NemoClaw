// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";

import {
  type OperationsWorkflow,
  validateBaseImagePublicationGate,
  validateStockOnboardingPublicationBoundary,
} from "../../../tools/e2e/operations-workflow-boundary.mts";
import { readWorkflow } from "../../helpers/e2e-workflow-contract";

const STOCK_JOBS = [
  "live",
  "mcp-bridge",
  "openshell-credential-generation-window",
  "mcp-bridge-dev",
  "hermes-e2e",
  "hermes-gpu-startup",
  "cloud-onboard",
  "messaging-providers",
] as const;

const CATALOGUE_JOBS = [
  "catalogue-standard",
  "catalogue-nvidia-api",
  "catalogue-nvidia-inference",
  "catalogue-github-read",
  "catalogue-brave-nvidia-inference",
] as const;

function workflow(): OperationsWorkflow {
  return structuredClone(readWorkflow()) as unknown as OperationsWorkflow;
}

describe("stock onboarding managed-image publication boundary", () => {
  it("passes one selected cohort receipt to every stock onboarding job", () => {
    expect(validateStockOnboardingPublicationBoundary(workflow())).toEqual([]);
  });

  it.each(STOCK_JOBS)("rejects %s without the publication dependency and receipt", (jobName) => {
    const value = workflow();
    value.jobs[jobName].needs = [];
    delete value.jobs[jobName].env?.E2E_MANAGED_IMAGE_REVISION;
    delete value.jobs[jobName].env?.E2E_MANAGED_IMAGE_COHORT_RECEIPT;

    expect(validateStockOnboardingPublicationBoundary(value)).toEqual(
      expect.arrayContaining([
        expect.stringContaining(`${jobName} must depend on base-image-publication`),
        expect.stringContaining(
          `${jobName} must receive the selected managed-image cohort revision`,
        ),
        expect.stringContaining(
          `${jobName} must receive the complete selected managed-image cohort receipt`,
        ),
      ]),
    );
  });

  it.each(CATALOGUE_JOBS)(
    "rejects %s without the publication dependency and receipt inputs",
    (jobName) => {
      const value = workflow();
      value.jobs[jobName].needs = [];
      delete value.jobs[jobName].with?.managed_image_revision;
      delete value.jobs[jobName].with?.managed_image_receipt;

      expect(validateStockOnboardingPublicationBoundary(value)).toEqual(
        expect.arrayContaining([
          expect.stringContaining(`${jobName} must depend on base-image-publication`),
          expect.stringContaining(
            `${jobName} must pass the selected managed-image cohort revision`,
          ),
          expect.stringContaining(
            `${jobName} must pass the complete selected managed-image cohort receipt`,
          ),
        ]),
      );
    },
  );

  it("blocks matrix generation when any publication architecture fails", () => {
    const value = workflow();
    value.jobs["generate-matrix"].needs = [];

    expect(validateBaseImagePublicationGate(value)).toContain(
      "generate-matrix must wait for complete managed-image publication",
    );
  });
});
