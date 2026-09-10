// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { buildReviewQueueResult } from "../../../tools/e2e/review-queue-result.mts";

const identity = {
  repository: "NVIDIA/NemoClaw",
  prNumber: 11489,
  candidateSha: "a".repeat(40),
  baseSha: "b".repeat(40),
  workflowSha: "c".repeat(40),
  workflowRunId: "123",
  workflowRunAttempt: 2,
};
const needs = {
  "generate-matrix": { result: "success" },
  live: { result: "success" },
  "catalogue-standard": { result: "success" },
};

describe("Review queue E2E results", () => {
  it("matches the consumer result fixture (#11489)", () => {
    const fixture = JSON.parse(
      readFileSync(new URL("../../fixtures/review-queue-e2e-pass.json", import.meta.url), "utf8"),
    );
    expect(buildReviewQueueResult(identity, ["live", "catalogue-standard"], needs)).toEqual(
      fixture,
    );
  });
  it("requires every selected matrix group and preserves run identity (#11489)", () => {
    expect(buildReviewQueueResult(identity, ["live", "catalogue-standard"], needs)).toMatchObject({
      ...identity,
      status: "pass",
      results: [
        { job: "generate-matrix", result: "success" },
        { job: "live", result: "success" },
        { job: "catalogue-standard", result: "success" },
      ],
    });
  });
  it("reports a failed selected group (#11489)", () => {
    expect(
      buildReviewQueueResult(identity, ["live", "catalogue-standard"], {
        ...needs,
        live: { result: "failure" },
      }).status,
    ).toBe("fail");
  });
  it.each(["cancelled", "skipped"])("does not pass a %s matrix group (#11489)", (result) => {
    expect(buildReviewQueueResult(identity, ["live"], { ...needs, live: { result } }).status).toBe(
      "unknown",
    );
  });
  it.each([
    { selected: null },
    { selected: [] },
    { selected: ["generate-matrix"] },
    { selected: ["live", "live"] },
    { selected: ["unrecorded"] },
  ])("rejects invalid selection evidence $selected (#11489)", ({ selected }) => {
    expect(() => buildReviewQueueResult(identity, selected, needs)).toThrow();
  });
  it("rejects invalid identity and incomplete workflow results (#11489)", () => {
    expect(() =>
      buildReviewQueueResult({ ...identity, workflowRunAttempt: 0 }, ["live"], needs),
    ).toThrow("identity");
    expect(() =>
      buildReviewQueueResult({ ...identity, candidateSha: "main" }, ["live"], needs),
    ).toThrow("identity");
    expect(() =>
      buildReviewQueueResult(identity, ["live"], { live: { result: "success" } }),
    ).toThrow("generate-matrix");
  });
});
