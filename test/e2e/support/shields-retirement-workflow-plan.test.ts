// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import fs from "node:fs";

import { describe, expect, it } from "vitest";

import { catalogueTarget, E2E_TARGET_CATALOGUE } from "../../../tools/e2e/target-catalogue.mts";
import { buildE2eWorkflowPlan, selectedWorkflowJobs } from "../../../tools/e2e/workflow-plan.mts";

describe("Shields retirement upgrade workflow plan", () => {
  it("invokes the restored candidate CLI directly without a global npm link", () => {
    const source = fs.readFileSync(
      new URL("../live/shields-retirement-upgrade.test.ts", import.meta.url),
      "utf8",
    );

    expect(source).toContain("shellQuote(CANDIDATE_CLI)");
    expect(source).not.toContain("npm link --ignore-scripts");
    expect(source).not.toContain("command -v nemoclaw");
  });

  it(
    "includes exactly one pinned release-migration lane in targeted and empty plans",
    {
      timeout: 30_000,
    },
    () => {
      const target = catalogueTarget("shields-retirement-upgrade");
      expect(target).toMatchObject({
        profile: "github-read",
        testFile: "test/e2e/live/shields-retirement-upgrade.test.ts",
        environment: {
          NEMOCLAW_OLD_NEMOCLAW_REF: "v0.0.115",
          NEMOCLAW_OLD_NEMOCLAW_TAG_OBJECT: "7503e700808655df1303ddc51888bb596c9afa34",
          NEMOCLAW_OLD_NEMOCLAW_COMMIT: "324a886fd05b01f6756bae0371ea503c651fbd11",
          NEMOCLAW_OLD_INSTALLER_SHA256:
            "0ed77ba8cf176641bd3b22cfd89b4977b3d9a6f47b76da8b03bf4091a20d1251",
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
      expect(E2E_TARGET_CATALOGUE).toHaveLength(65);
      expect(unfiltered.coverageMatrix).toHaveLength(90);
      expect(unfiltered.coverageMatrix.filter((row) => row.unresolvedReason === "")).toHaveLength(
        89,
      );
      expect(
        Object.values(unfiltered.catalogueMatrices)
          .flat()
          .filter((row) => row.id === "shields-retirement-upgrade"),
      ).toHaveLength(1);
      expect(E2E_TARGET_CATALOGUE.map((entry) => entry.id)).not.toEqual(
        expect.arrayContaining(["shields-config", "hermes-shields-config"]),
      );
    },
  );
});
