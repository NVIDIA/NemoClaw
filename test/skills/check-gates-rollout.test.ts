// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";
import { coordinationCheck, runGate } from "./check-gates-test-fixtures.ts";

describe("maintainer merge-gate check-name rollout", () => {
  it("prefers the current exact-diff E2E check when both rollout names exist", () => {
    const output = JSON.parse(
      runGate({
        body: "Signed-off-by: Example User <user@example.com>",
        verified: true,
        coordinationCheckPages: [{ total_count: 1, check_runs: [coordinationCheck({ id: 8000 })] }],
        formerCoordinationCheckPages: [
          {
            total_count: 1,
            check_runs: [
              coordinationCheck({
                id: 8001,
                name: "E2E / PR Gate Coordination",
                conclusion: "failure",
              }),
            ],
          },
        ],
      }).stdout,
    );

    expect(output).toMatchObject({
      allPass: true,
      gates: { ci: { pass: true, trustedCustomCheckId: 8000 } },
    });
  });
});
