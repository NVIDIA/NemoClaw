// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";
import { runGate, successfulRequiredChecks } from "./check-gates-test-fixtures.ts";

describe("maintainer merge-gate final PR snapshot", () => {
  it("rejects a required check that becomes pending in the final PR observation", () => {
    const output = JSON.parse(
      runGate({
        body: "Signed-off-by: Example User <user@example.com>",
        verified: true,
        finalPrAfterFinalCi: {
          statusCheckRollup: successfulRequiredChecks().map((check) =>
            check.name === "checks"
              ? { ...check, status: "IN_PROGRESS", conclusion: undefined }
              : check,
          ),
        },
      }).stdout,
    );

    expect(output.gates.ci).toMatchObject({ pass: false });
    expect(output.gates.ci.pendingChecks).toContain("checks");
    expect(output.allPass).toBe(false);
  });

  it.each([
    ["the status rollup is incomplete", { finalStatusCheckHasNextPage: true }],
    ["the status rollup belongs to another commit", { finalStatusCheckCommitOid: "c".repeat(40) }],
    [
      "the status rollup count does not match its returned contexts",
      { finalStatusContextTotalCount: successfulRequiredChecks().length + 1 },
    ],
  ])("fails closed when %s in the final PR observation", (_condition, finalStatusFixture) => {
    const output = JSON.parse(
      runGate({
        body: "Signed-off-by: Example User <user@example.com>",
        verified: true,
        ...finalStatusFixture,
      }).stdout,
    );

    expect(output.gates.ci).toMatchObject({
      pass: false,
      details: "Unable to verify the final PR checks",
    });
    expect(output.allPass).toBe(false);
  });

  it("verifies every final status context when the rollup spans multiple pages", () => {
    const statusChecks = [
      ...successfulRequiredChecks(),
      ...Array.from({ length: 95 }, (_, index) => ({
        __typename: "StatusContext",
        context: `optional-context-${index + 1}`,
        state: "SUCCESS",
        startedAt: "2026-01-01T00:00:00Z",
      })),
    ];
    const output = JSON.parse(
      runGate({
        body: "Signed-off-by: Example User <user@example.com>",
        verified: true,
        statusChecks,
        finalStatusCheckPageSize: 100,
      }).stdout,
    );

    expect(output).toMatchObject({
      allPass: true,
      gates: { ci: { pass: true } },
    });
  });

  it("fails closed when the complete final status snapshot changes between reads", () => {
    const output = JSON.parse(
      runGate({
        body: "Signed-off-by: Example User <user@example.com>",
        verified: true,
        finalStatusChecksAfterFirstRead: successfulRequiredChecks().map((check) =>
          check.name === "checks"
            ? { ...check, status: "IN_PROGRESS", conclusion: undefined }
            : check,
        ),
      }).stdout,
    );

    expect(output.gates.ci).toMatchObject({
      pass: false,
      details: "Unable to verify the final PR checks",
    });
    expect(output.allPass).toBe(false);
  });

  it("accepts a multi-commit PR when the final snapshot returns the PR commit SHA", () => {
    const output = JSON.parse(
      runGate({
        body: "Signed-off-by: Example User <user@example.com>",
        verified: true,
        finalCommitTotalCount: 2,
      }).stdout,
    );

    expect(output).toMatchObject({
      allPass: true,
      gates: { ci: { pass: true } },
    });
  });
});
