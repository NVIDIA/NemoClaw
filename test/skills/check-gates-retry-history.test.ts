// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";
import { coordinationCheck, runGate } from "./check-gates-test-fixtures.ts";

const SIGNED_BODY = "Signed-off-by: Example User <user@example.com>";

function retryableFailure(id: number, reason: string, title = "Retryable E2E failure") {
  return coordinationCheck({
    id,
    conclusion: "failure",
    output: {
      title,
      summary: `Retryable failure.\n\n<!-- nemoclaw-pr-e2e-retry:v1:${reason} -->`,
    },
  });
}

function gateOutput(checkRuns: unknown[]) {
  return JSON.parse(
    runGate({
      body: SIGNED_BODY,
      verified: true,
      coordinationCheckPages: [{ total_count: checkRuns.length, check_runs: checkRuns }],
    }).stdout,
  );
}

function expectIncompleteEvidence(checkRuns: unknown[]) {
  expect(gateOutput(checkRuns).gates.ci).toMatchObject({
    pass: false,
    failingChecks: ["E2E / PR Gate: latest attempt evidence incomplete"],
  });
}

describe("maintainer merge-gate E2E retry history", () => {
  it.each([
    "prerequisite-ci",
    "child-cancelled",
    "evidence-download",
  ])("accepts a later successful coordination check after a %s retry failure", (reason) => {
    const output = gateOutput([coordinationCheck({ id: 8002 }), retryableFailure(8001, reason)]);

    expect(output).toMatchObject({ allPass: true, gates: { ci: { pass: true } } });
  });

  it.each([
    ["an older success", [coordinationCheck({ id: 8002 }), coordinationCheck({ id: 8001 })]],
    [
      "an older unmarked failure",
      [
        coordinationCheck({ id: 8002 }),
        coordinationCheck({
          id: 8001,
          conclusion: "failure",
          output: { title: "Unknown failure", summary: "No retry marker." },
        }),
      ],
    ],
    [
      "an unsupported retry reason",
      [coordinationCheck({ id: 8002 }), retryableFailure(8001, "product-failure")],
    ],
    [
      "trailing content after the retry marker",
      [
        coordinationCheck({ id: 8002 }),
        coordinationCheck({
          id: 8001,
          conclusion: "failure",
          output: {
            title: "Prerequisite CI failed",
            summary: "Failure.\n\n<!-- nemoclaw-pr-e2e-retry:v1:prerequisite-ci --> trailing",
          },
        }),
      ],
    ],
    [
      "a never-retry title carrying a supported marker",
      [
        coordinationCheck({ id: 8002 }),
        retryableFailure(8001, "child-cancelled", "Authorized E2E run requires reconciliation"),
      ],
    ],
    [
      "an older active check",
      [
        coordinationCheck({ id: 8002 }),
        coordinationCheck({ id: 8001, status: "in_progress", conclusion: null }),
      ],
    ],
    [
      "multiple active checks",
      [
        coordinationCheck({ id: 8002, status: "in_progress", conclusion: null }),
        coordinationCheck({ id: 8001, status: "in_progress", conclusion: null }),
      ],
    ],
    [
      "an older check from another GitHub App",
      [
        coordinationCheck({ id: 8002 }),
        { ...retryableFailure(8001, "prerequisite-ci"), app: { id: 1234 } },
      ],
    ],
    [
      "an older check reported on another head",
      [
        coordinationCheck({ id: 8002 }),
        { ...retryableFailure(8001, "prerequisite-ci"), head_sha: "c".repeat(40) },
      ],
    ],
    [
      "any non-retryable check in older history",
      [
        coordinationCheck({ id: 8003 }),
        coordinationCheck({
          id: 8002,
          conclusion: "failure",
          output: { title: "Unknown failure", summary: "No retry marker." },
        }),
        retryableFailure(8001, "prerequisite-ci"),
      ],
    ],
  ])("fails closed with %s in the exact coordination history", (_name, checks) => {
    expectIncompleteEvidence(checks);
  });
});
