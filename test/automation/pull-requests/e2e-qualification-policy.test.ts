// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";
import policy from "../../../ci/e2e-assertion-growth-exceptions.json";
import census from "../../../ci/e2e-assertion-budget.json";
import {
  parseE2eAssertionBudget,
  type E2eAssertionBudget,
} from "../../../scripts/checks/e2e-assertion-census.mts";
import { e2eAssertionBudgetGrowthViolations } from "../../helpers/growth-guardrail-checks";
import type { GrowthGuardrailDiff } from "../../helpers/growth-guardrail-diff";

const budgetPath = "ci/e2e-assertion-budget.json";
const policyPath = "ci/e2e-assertion-growth-exceptions.json";
const gpuPath = "test/e2e/live/gpu-e2e.test.ts";
const approved = {
  11918: { other: 11919, live: 0, direct: [2, 4], unique: [2, 4] },
  11919: { other: 11918, live: 1, direct: [44, 61], unique: [70, 87] },
} as const;
type ApprovedPullRequest = keyof typeof approved;
interface QualificationRecord {
  pullRequest: number;
  paths: readonly string[];
}
const activeRecords: readonly QualificationRecord[] = policy.exceptions;

// Keep both merge-order fixtures anchored to the reviewed pre-qualification census.
const current = parseE2eAssertionBudget(JSON.stringify(census));
const reviewedBase: E2eAssertionBudget = {
  ...current,
  limits: {
    ...current.limits,
    liveFileCount: 193,
    direct: { ...current.limits.direct, expectCalls: 1442, assertionPoints: 2261 },
    unique: { ...current.limits.unique, expectCalls: 1890, assertionPoints: 3510 },
    files: { ...current.limits.files, [gpuPath]: [39, 44, 72, 90, 3] },
  },
};

function addQualification(
  source: E2eAssertionBudget,
  pullRequest: ApprovedPullRequest,
  count = 1,
): E2eAssertionBudget {
  const delta = approved[pullRequest];
  const before = source.limits.files[gpuPath]!;
  return {
    ...source,
    limits: {
      ...source.limits,
      liveFileCount: source.limits.liveFileCount + count * delta.live,
      direct: {
        ...source.limits.direct,
        expectCalls: source.limits.direct.expectCalls + count * delta.direct[0],
        assertionPoints: source.limits.direct.assertionPoints + count * delta.direct[1],
      },
      unique: {
        ...source.limits.unique,
        expectCalls: source.limits.unique.expectCalls + count * delta.unique[0],
        assertionPoints: source.limits.unique.assertionPoints + count * delta.unique[1],
      },
      files: {
        ...source.limits.files,
        [gpuPath]: [
          before[0] + count * delta.direct[0],
          before[1] + count * delta.direct[1],
          before[2] + count * delta.unique[0],
          before[3] + count * delta.unique[1],
          before[4],
        ],
      },
    },
  };
}

function qualificationDiff(record: QualificationRecord, otherMerged: number): GrowthGuardrailDiff {
  const pullRequest = record.pullRequest as ApprovedPullRequest;
  const base = addQualification(reviewedBase, approved[pullRequest].other, otherMerged);
  const head = addQualification(base, pullRequest);
  const before = new Map([
    [budgetPath, JSON.stringify(base)],
    [policyPath, JSON.stringify(policy)],
  ]);
  const after = new Map([[budgetPath, JSON.stringify(head)]]);
  return {
    pullRequestNumber: pullRequest,
    files: [...record.paths, budgetPath].map((filename) => ({ filename })),
    readBase: async (paths) => new Map(paths.map((file) => [file, before.get(file) ?? null])),
    readHead: async (paths) => new Map(paths.map((file) => [file, after.get(file) ?? null])),
  };
}

// Retired allowances leave this table; the generic guardrail tests remain in place.
describe.each(activeRecords)("active qualification allowance for PR $pullRequest", (record) => {
  it.each([0, 1])(
    "permits only its own delta with the other qualification merged=%s",
    async (merged) => {
      const diff = qualificationDiff(record, merged);
      expect(await e2eAssertionBudgetGrowthViolations(diff)).toEqual([]);
      const head = JSON.parse(
        (await diff.readHead([budgetPath])).get(budgetPath)!,
      ) as E2eAssertionBudget;
      const [de, dp, ue, up, blocks] = head.limits.files[gpuPath]!;
      const oversized: E2eAssertionBudget = {
        ...head,
        limits: {
          ...head.limits,
          direct: {
            ...head.limits.direct,
            assertionPoints: head.limits.direct.assertionPoints + 1,
          },
          unique: {
            ...head.limits.unique,
            assertionPoints: head.limits.unique.assertionPoints + 1,
          },
          files: { ...head.limits.files, [gpuPath]: [de, dp + 1, ue, up + 1, blocks] },
        },
      };
      expect(
        await e2eAssertionBudgetGrowthViolations({
          ...diff,
          readHead: async () => new Map([[budgetPath, JSON.stringify(oversized)]]),
        }),
      ).not.toEqual([]);
    },
  );

  it("rejects another PR using its approved paths and census", async () => {
    const diff = qualificationDiff(record, 0);
    const violations = await e2eAssertionBudgetGrowthViolations({
      ...diff,
      pullRequestNumber: 11920,
    });
    expect(violations).toContain(
      `direct.assertionPoints increased from 2261 to ${2261 + approved[record.pullRequest as ApprovedPullRequest].direct[1]}`,
    );
  });

  it("rejects an unrelated live path alongside its approved qualification", async () => {
    const diff = qualificationDiff(record, 0);
    expect(
      await e2eAssertionBudgetGrowthViolations({
        ...diff,
        files: [...diff.files, { filename: "test/e2e/live/unrelated.ts" }],
      }),
    ).not.toEqual([]);
  });

  // Candidate-only policy rejection is owned by growth-guardrail-parsers.test.ts.
});

it("restores ordinary no-growth after the final allowance is retired", async () => {
  const diff = qualificationDiff({ pullRequest: 11918, paths: [gpuPath] }, 0);
  const base = await diff.readBase([budgetPath]);
  const empty = JSON.stringify({ schemaVersion: 1, exceptions: [] });
  const violations = await e2eAssertionBudgetGrowthViolations({
    ...diff,
    readBase: async (paths) =>
      new Map(paths.map((file) => [file, file === policyPath ? empty : (base.get(file) ?? null)])),
  });
  expect(violations).toContain("direct.assertionPoints increased from 2261 to 2265");
});
