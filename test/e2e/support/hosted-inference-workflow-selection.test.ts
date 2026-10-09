// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";
import { buildE2eWorkflowPlan } from "../../../tools/e2e/workflow-plan.mts";
import { E2E_TARGET_CATALOGUE } from "../../../tools/e2e/target-catalogue.mts";

describe("hosted inference evidence selection", () => {
  it.each([
    ".github/workflows/e2e.yaml",
    ".github/workflows/e2e-standard-profile.yaml",
    "test/e2e/live/inference-routing-credential-scan.ts",
  ])("selects hosted-provider evidence when its credential boundary changes: %s", (changedFile) => {
    const plan = buildE2eWorkflowPlan({}, { changedFiles: [changedFile] });
    expect(plan.catalogueMatrices["hosted-inference"].map((row) => row.id).sort()).toEqual(
      E2E_TARGET_CATALOGUE.filter((target) => target.profile === "hosted-inference")
        .map((target) => target.id)
        .sort(),
    );
  });
});
