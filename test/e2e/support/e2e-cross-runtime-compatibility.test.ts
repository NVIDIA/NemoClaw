// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { createHash } from "node:crypto";

import { describe, expect, it } from "vitest";

import { buildRiskPlan } from "../../../tools/advisors/risk-plan.mts";
import { buildE2eWorkflowPlan } from "../../../tools/e2e/workflow-plan.mts";
import { buildLiveTargetMatrix } from "../registry/run.ts";

function digestOutput(value: unknown): string {
  return createHash("sha256")
    .update(`${JSON.stringify(value)}\n`)
    .digest("hex");
}

describe("cross-runtime foundation compatibility", () => {
  it("preserves the exact canonical Docker live matrix output", () => {
    expect(digestOutput(buildLiveTargetMatrix())).toBe(
      "1e9b8aa3f3435e32398f8a6e13b8daf97e6fa89be263d9b9f99d13694c143f1b",
    );
    expect(
      digestOutput(
        buildLiveTargetMatrix([
          "ubuntu-repo-cloud-langchain-deepagents-code",
          "ubuntu-repo-docker-post-reboot-recovery",
        ]),
      ),
    ).toBe("6272aab16cf4b9555bdc4b3f4c0cdd24b5faa55118cbd61cbb4b30a3d418a63a");
    expect(digestOutput(buildE2eWorkflowPlan())).toBe(
      "e766590c5f964482bef98b5ce44ff1d487eb74ae6a1c73072e951f4247b435e4",
    );
  });

  it("preserves exact risk-plan outputs for established policy cases", () => {
    const headSha = "0123456789abcdef0123456789abcdef01234567";
    const cases = [
      { headSha, changedFiles: [] },
      { headSha, changedFiles: ["test/e2e/registry/run.ts"] },
      {
        headSha,
        changedFiles: ["src/lib/onboard.ts", "src/lib/inference/foo.ts"],
      },
    ];

    expect(digestOutput(cases.map(buildRiskPlan))).toBe(
      "323a6eab7df534424f3b94a7f43c92234750b680855d8b67354941f6eb8a4a7a",
    );
  });
});
