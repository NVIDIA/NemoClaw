// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";

import {
  assertUnchangedReviewRevision,
  type CoordinatorFinding,
  type CoordinatorSnapshot,
  decideReviewAction,
} from "../../../tools/pr-review-coordinator/decision.mts";
import { evaluateCoordinatorShadow } from "../../../tools/pr-review-coordinator/shadow.mts";

const HEAD = "1111111111111111111111111111111111111111";
const NEXT_HEAD = "3333333333333333333333333333333333333333";
const BASE = "2222222222222222222222222222222222222222";

describe("repository-owned PR review coordination", () => {
  it("proposes one consolidated changes-requested review for first-head P0/P1 blockers", () => {
    const decision = decideReviewAction(
      snapshot({
        advisor: blocked([finding("state-ownership")]),
      }),
    );

    expect(decision).toMatchObject({
      action: "would-request-changes",
      reason: "advisor-blockers-first-review",
      headSha: HEAD,
      findingIds: ["F-state-ownership"],
    });
  });

  it("stays quiet when the same frozen blocker remains on a later commit", () => {
    const prior = finding("state-ownership");
    const decision = decideReviewAction(
      snapshot({
        headSha: NEXT_HEAD,
        advisor: blocked([prior], NEXT_HEAD),
        frozenContractKeys: [prior.contractKey],
      }),
    );

    expect(decision).toMatchObject({
      action: "stay-quiet",
      reason: "repeated-contract-findings",
      findingIds: [],
    });
  });

  it("publishes only a validated material blocker newly proven by the commit delta", () => {
    const prior = finding("state-ownership");
    const newFinding = finding("credential-leak", {
      relationship: "newly-proven-on-delta",
    });
    const decision = decideReviewAction(
      snapshot({
        headSha: NEXT_HEAD,
        advisor: blocked([prior, newFinding], NEXT_HEAD),
        frozenContractKeys: [prior.contractKey],
      }),
    );

    expect(decision).toMatchObject({
      action: "would-request-changes",
      reason: "new-material-delta-blocker",
      findingIds: ["F-credential-leak"],
    });
  });

  it("does not turn ambiguous follow-up feedback into review noise", () => {
    const ambiguous = finding("possible-cleanup", {
      validation: "ambiguous",
      relationship: "newly-proven-on-delta",
    });
    const decision = decideReviewAction(
      snapshot({
        headSha: NEXT_HEAD,
        advisor: blocked([ambiguous], NEXT_HEAD),
        frozenContractKeys: ["previous-contract"],
      }),
    );

    expect(decision).toMatchObject({
      action: "stay-quiet",
      reason: "ambiguous-follow-up",
    });
  });

  it("stays quiet until a complete Advisor result matches the current head and base", () => {
    const decision = decideReviewAction(
      snapshot({
        headSha: NEXT_HEAD,
        advisor: clear(HEAD),
      }),
    );

    expect(decision).toMatchObject({
      action: "stay-quiet",
      reason: "advisor-missing-or-stale",
    });
  });

  it("stays quiet after a review has already been written for the exact head", () => {
    const decision = decideReviewAction(
      snapshot({
        advisor: clear(),
        writes: [{ headSha: HEAD, kind: "approve" }],
      }),
    );

    expect(decision).toMatchObject({
      action: "stay-quiet",
      reason: "duplicate-current-head-write",
    });
  });

  it("waits when Advisor is clear but a required readiness gate is pending", () => {
    const decision = decideReviewAction(
      snapshot({
        advisor: clear(),
        readiness: { requiredChecks: "pending" },
      }),
    );

    expect(decision).toMatchObject({
      action: "stay-quiet",
      reason: "prerequisites-not-ready",
    });
  });

  it("proposes exact-head approval only when every readiness gate is clear", () => {
    const decision = decideReviewAction(snapshot({ advisor: clear() }));

    expect(decision).toMatchObject({
      action: "would-approve",
      reason: "advisor-clear-and-ready",
      headSha: HEAD,
      findingIds: [],
    });
  });

  it("keeps reviewer and author roles separate", () => {
    const decision = decideReviewAction(
      snapshot({
        advisor: clear(),
        reviewer: "Contributor",
        author: "contributor",
      }),
    );

    expect(decision).toMatchObject({
      action: "stay-quiet",
      reason: "self-authored",
    });
  });

  it("rejects malformed evidence rather than guessing", () => {
    const malformed = snapshot({ advisor: clear() });
    const changed = {
      ...malformed,
      advisor: { ...malformed.advisor, status: "blocked", findings: [] },
    } as unknown as CoordinatorSnapshot;

    expect(() => decideReviewAction(changed)).toThrow(
      "A blocked Advisor result must contain findings",
    );
  });

  it("rejects an unsupported Advisor status before it can reach approval", () => {
    const malformed = snapshot({ advisor: clear() });
    const changed = {
      ...malformed,
      advisor: { ...malformed.advisor, status: "unknown" },
    } as unknown as CoordinatorSnapshot;

    expect(() => decideReviewAction(changed)).toThrow("Advisor status is invalid");
  });

  it("rejects non-blocking Advisor noise at the input boundary", () => {
    const noisyFinding = {
      ...finding("optional-cleanup"),
      severity: "P2",
    } as unknown as CoordinatorFinding;

    expect(() => decideReviewAction(snapshot({ advisor: blocked([noisyFinding]) }))).toThrow(
      "Coordinator accepts only P0/P1 Advisor findings",
    );
  });

  it("refuses a write when the PR moves after the decision", () => {
    expect(() =>
      assertUnchangedReviewRevision(
        { headSha: HEAD, baseSha: BASE },
        { headSha: NEXT_HEAD, baseSha: BASE },
      ),
    ).toThrow("Pull request head or base changed before the review write");
  });

  it("keeps exact-head model findings read-only and ambiguous in workflow shadow mode", () => {
    const result = evaluateCoordinatorShadow({
      context: {
        repo: "NVIDIA/NemoClaw",
        prNumber: 123,
        pullRequest: {
          state: "open",
          draft: false,
          mergeable: true,
          user: { login: "contributor" },
          head: { sha: HEAD },
          base: { sha: BASE },
        },
      },
      gate: {
        status: "blocked",
        findingCount: 1,
        unresolvedRecommendationCount: 0,
        findingInterests: ["architecture-standard-work"],
        unresolvedInterests: [],
      },
      ledgers: [
        {
          version: 1,
          revision: 1,
          identity: "exact-head",
          headSha: HEAD,
          interest: "architecture-standard-work",
          status: "findings",
          findings: [
            {
              id: "F-architecture-standard-work-123",
              interest: "architecture-standard-work",
              severity: "P1",
              kind: "design",
              summary: "A material blocker",
              path: "src/example.ts",
              line: 1,
              impact: "Impact",
              smallestSafeFix: "Fix",
              regressionTest: "Test",
              exclusions: [],
            },
          ],
          noFindingsReason: null,
        },
      ],
      prNumber: 123,
      headSha: HEAD,
      baseSha: BASE,
    });

    expect(result).toMatchObject({
      mode: "read-only-shadow",
      snapshot: {
        advisor: {
          findings: [{ validation: "ambiguous" }],
        },
        readiness: { commitsVerified: false, productScope: "missing" },
      },
      decision: { action: "stay-quiet", reason: "ambiguous-follow-up" },
    });
  });
});

function snapshot(
  options: {
    headSha?: string;
    advisor?: CoordinatorSnapshot["advisor"];
    frozenContractKeys?: readonly string[];
    writes?: CoordinatorSnapshot["history"]["writes"];
    readiness?: Partial<CoordinatorSnapshot["readiness"]>;
    reviewer?: string;
    author?: string;
  } = {},
): CoordinatorSnapshot {
  const headSha = options.headSha ?? HEAD;
  return {
    version: 1,
    pullRequest: {
      number: 123,
      state: "OPEN",
      draft: false,
      author: options.author ?? "contributor",
      reviewer: options.reviewer ?? "nemoclaw-review-coordinator",
      headSha,
      baseSha: BASE,
    },
    advisor: options.advisor ?? null,
    readiness: {
      requiredChecks: "pass",
      mergeability: "mergeable",
      commitsVerified: true,
      productScope: "accepted",
      ...options.readiness,
    },
    history: {
      frozenContractKeys: options.frozenContractKeys ?? [],
      writes: options.writes ?? [],
    },
  };
}

function clear(headSha = HEAD): NonNullable<CoordinatorSnapshot["advisor"]> {
  return {
    identity: "exact-head",
    headSha,
    baseSha: BASE,
    status: "clear",
    findings: [],
  };
}

function blocked(
  findings: readonly CoordinatorFinding[],
  headSha = HEAD,
): NonNullable<CoordinatorSnapshot["advisor"]> {
  return {
    identity: "exact-head",
    headSha,
    baseSha: BASE,
    status: "blocked",
    findings,
  };
}

function finding(key: string, overrides: Partial<CoordinatorFinding> = {}): CoordinatorFinding {
  return {
    id: `F-${key}`,
    contractKey: key,
    severity: "P1",
    summary: `Material blocker: ${key}`,
    path: "src/example.ts",
    validation: "validated",
    relationship: "existing-contract",
    ...overrides,
  };
}
