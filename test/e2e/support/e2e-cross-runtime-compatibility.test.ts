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
      "36795de73b09280ad17f7a6296d5690572e23dabe40b374e754836066589d145",
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
      "311bd367e8d6ee469a9ec99aba13ab9b806ac679f7e71381c09d4fc4beafd4a2",
    );
  });
});
