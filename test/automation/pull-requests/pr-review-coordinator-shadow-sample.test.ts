// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";

import { decideReviewAction } from "../../../tools/pr-review-coordinator/decision.mts";
import {
  type CoordinatorShadowResult,
  parseCoordinatorShadowResult,
  selectCoordinatorShadowSample,
} from "../../../tools/pr-review-coordinator/shadow-sample.mts";

const HEAD = "a".repeat(40);
const BASE = "b".repeat(40);

function result(prNumber = 12090): CoordinatorShadowResult {
  const snapshot = {
    version: 1 as const,
    pullRequest: {
      number: prNumber,
      state: "OPEN" as const,
      draft: false,
      author: `contributor-${prNumber}`,
      reviewer: "nemoclaw-review-coordinator[bot]",
      headSha: HEAD,
      baseSha: BASE,
    },
    advisor: {
      identity: "exact-head" as const,
      headSha: HEAD,
      baseSha: BASE,
      status: "clear" as const,
      findings: [],
    },
    readiness: {
      requiredChecks: "pass" as const,
      mergeability: "mergeable" as const,
      commitsVerified: true,
      productScope: "accepted" as const,
    },
    history: { frozenContractKeys: [], writes: [] },
  };
  return { mode: "read-only-shadow", snapshot, decision: decideReviewAction(snapshot) };
}

const sourceRun = {
  id: 3001,
  attempt: 1,
  createdAt: "2026-09-21T12:00:00Z",
};

describe("coordinator shadow rollout sample", () => {
  it("captures five distinct PR decisions and then stops", () => {
    const first = selectCoordinatorShadowSample(result(12090), [], sourceRun)!;
    const second = selectCoordinatorShadowSample(result(12091), [first], {
      ...sourceRun,
      id: 3002,
    })!;
    const third = selectCoordinatorShadowSample(result(12092), [first, second], {
      ...sourceRun,
      id: 3003,
    })!;
    const fourth = selectCoordinatorShadowSample(result(12093), [first, second, third], {
      ...sourceRun,
      id: 3004,
    })!;
    const fifth = selectCoordinatorShadowSample(result(12094), [first, second, third, fourth], {
      ...sourceRun,
      id: 3005,
    })!;
    const samples = [first, second, third, fourth, fifth];
    expect(samples.map((sample) => sample.ordinal)).toEqual([1, 2, 3, 4, 5]);
    expect(selectCoordinatorShadowSample(result(12100), samples, sourceRun)).toBeNull();
  });

  it("does not spend another slot on the same PR", () => {
    const sample = selectCoordinatorShadowSample(result(), [], sourceRun)!;
    expect(selectCoordinatorShadowSample(result(), [sample], sourceRun)).toBeNull();
  });

  it("rejects a decision that does not match its snapshot", () => {
    const tampered = structuredClone(result()) as unknown as Record<string, unknown>;
    tampered.decision = {
      ...(tampered.decision as Record<string, unknown>),
      action: "stay-quiet",
    };
    expect(() => parseCoordinatorShadowResult(tampered)).toThrow(
      "decision does not match its validated snapshot",
    );
  });

  it("rejects non-contiguous or duplicate stored samples", () => {
    const first = selectCoordinatorShadowSample(result(12090), [], sourceRun)!;
    expect(() =>
      selectCoordinatorShadowSample(result(12091), [{ ...first, ordinal: 2 }], sourceRun),
    ).toThrow("contiguous ordinals");
    expect(() =>
      selectCoordinatorShadowSample(
        result(12091),
        [first, { ...first, ordinal: 2, sourceRun: { ...sourceRun, id: 3002 } }],
        sourceRun,
      ),
    ).toThrow("distinct pull requests");
  });
});
