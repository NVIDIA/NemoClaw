// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";
import { buildE2eWorkflowPlan } from "../../../tools/e2e/workflow-plan.mts";

describe("hosted inference evidence selection", () => {
  it.each([
    ".github/workflows/e2e.yaml",
    ".github/workflows/e2e-standard-profile.yaml",
    "test/e2e/live/inference-routing-credential-scan.ts",
    "test/e2e/live/inference-routing-provider-smoke.test.ts",
    "tools/e2e/target-catalogue.mts",
    "src/lib/inference/native-provider/lifecycle.ts",
  ])("requires explicit hosted selection even when a boundary changes: %s", (changedFile) => {
    const plan = buildE2eWorkflowPlan({}, { changedFiles: [changedFile] });
    expect(plan.catalogueMatrices["hosted-inference"]).toEqual([]);
  });
});
