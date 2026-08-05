// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";
import {
  coordinationCheck,
  runGate,
  successfulRequiredChecks,
} from "./check-gates-test-fixtures.ts";

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
  const orderedCheckIds = checkRuns
    .map((check) => (check as { id: number }).id)
    .sort((left, right) => left - right);
  const timingWindowStart = Date.parse("2026-01-01T00:01:31Z");
  const slotDuration = 60_000 / orderedCheckIds.length;
  const checkRunsWithTiming = checkRuns.map((check) => {
    const record = check as Record<string, unknown> & { id: number };
    const position = orderedCheckIds.indexOf(record.id);
    return {
      ...record,
      started_at: new Date(timingWindowStart + position * slotDuration).toISOString(),
      completed_at: new Date(timingWindowStart + (position + 1) * slotDuration).toISOString(),
    };
  });
  const currentCheckId = orderedCheckIds.at(-1)!;
  return JSON.parse(
    runGate({
      body: SIGNED_BODY,
      verified: true,
      statusChecks: successfulRequiredChecks().map((check) =>
        check.name === "E2E / PR Gate"
          ? {
              ...check,
              detailsUrl: `https://github.com/NVIDIA/NemoClaw/runs/${currentCheckId}`,
            }
          : check,
      ),
      coordinationCheckPages: [
        { total_count: checkRunsWithTiming.length, check_runs: checkRunsWithTiming },
      ],
    }).stdout,
  );
}

function expectIncompleteEvidence(checkRuns: unknown[]) {
  expect(gateOutput(checkRuns).gates.ci).toMatchObject({
    pass: false,
    failingChecks: [
      "E2E / PR Gate: latest attempt evidence incomplete",
      "initialize: latest attempt evidence incomplete",
    ],
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

  it("accepts retry history with more than 60 completed checks", () => {
    const retryHistory = Array.from({ length: 61 }, (_value, index) =>
      retryableFailure(8001 + index, "prerequisite-ci"),
    );
    const output = gateOutput([coordinationCheck({ id: 8062 }), ...retryHistory]);

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
