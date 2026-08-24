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
  it("passes one selected cohort revision to every stock onboarding job", () => {
    expect(validateStockOnboardingPublicationBoundary(workflow())).toEqual([]);
  });

  it.each(STOCK_JOBS)("rejects %s without the publication dependency and revision", (jobName) => {
    const value = workflow();
    value.jobs[jobName].needs = [];
    delete value.jobs[jobName].env?.E2E_MANAGED_IMAGE_REVISION;

    expect(validateStockOnboardingPublicationBoundary(value)).toEqual(
      expect.arrayContaining([
        expect.stringContaining(`${jobName} must depend on base-image-publication`),
        expect.stringContaining(
          `${jobName} must receive the selected managed-image cohort revision`,
        ),
      ]),
    );
  });

  it.each(CATALOGUE_JOBS)(
    "rejects %s without the publication dependency and revision input",
    (jobName) => {
      const value = workflow();
      value.jobs[jobName].needs = [];
      delete value.jobs[jobName].with?.managed_image_revision;

      expect(validateStockOnboardingPublicationBoundary(value)).toEqual(
        expect.arrayContaining([
          expect.stringContaining(`${jobName} must depend on base-image-publication`),
          expect.stringContaining(
            `${jobName} must pass the selected managed-image cohort revision`,
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
