// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";

import { catalogueTarget, E2E_TARGET_CATALOGUE } from "../../../tools/e2e/target-catalogue.mts";
import { buildE2eWorkflowPlan, selectedWorkflowJobs } from "../../../tools/e2e/workflow-plan.mts";

describe("Shields retirement upgrade workflow plan", () => {
  it("includes exactly one pinned release-migration lane in targeted and empty plans", () => {
    const target = catalogueTarget("shields-retirement-upgrade");
    expect(target).toMatchObject({
      profile: "github-read",
      testFile: "test/e2e/live/shields-retirement-upgrade.test.ts",
      environment: {
        NEMOCLAW_OLD_NEMOCLAW_REF: "v0.0.118",
        NEMOCLAW_OLD_NEMOCLAW_TAG_OBJECT: "ec5f13073736597a18ce33f9ef6e322fa9180673",
        NEMOCLAW_OLD_NEMOCLAW_COMMIT: "c3f309f2f344a4b25e58d204e0b423e54a4cb379",
        NEMOCLAW_OLD_INSTALLER_SHA256:
          "0ed77ba8cf176641bd3b22cfd89b4977b3d9a6f47b76da8b03bf4091a20d1251",
        NEMOCLAW_OLD_SANDBOX_BASE_IMAGE_REF:
          "ghcr.io/nvidia/nemoclaw/sandbox-base@sha256:0c2b7ec8fbf9c04fb73feeca1fe52a9620fee7e1f46d90d04c8aba48145aae68",
      },
    });

    const targeted = buildE2eWorkflowPlan({
      targets: "shields-retirement-upgrade",
    });
    expect(targeted.catalogueMatrices["github-read"]).toEqual([
      expect.objectContaining({ id: "shields-retirement-upgrade" }),
    ]);
    expect(selectedWorkflowJobs(targeted)).toEqual(["catalogue-github-read"]);

    const unfiltered = buildE2eWorkflowPlan();
    expect(E2E_TARGET_CATALOGUE).toHaveLength(66);
    expect(unfiltered.coverageMatrix).toHaveLength(91);
    expect(unfiltered.coverageMatrix.filter((row) => row.unresolvedReason === "")).toHaveLength(90);
    expect(
      Object.values(unfiltered.catalogueMatrices)
        .flat()
        .filter((row) => row.id === "shields-retirement-upgrade"),
    ).toHaveLength(1);
    expect(E2E_TARGET_CATALOGUE.map((entry) => entry.id)).not.toEqual(
      expect.arrayContaining(["shields-config", "hermes-shields-config"]),
    );
  });
});
