// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";

import {
  assertUnchangedReviewRevision,
  type CoordinatorFinding,
  type CoordinatorSnapshot,
  decideReviewAction,
  parseCoordinatorSnapshot,
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

  it("stays quiet when prior review feedback cannot be reconstructed safely", () => {
    const decision = decideReviewAction(
      snapshot({
        advisor: clear(),
        contractEvidence: "incomplete",
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

  it("waits for exact-head checks before proposing changes requested", () => {
    const decision = decideReviewAction(
      snapshot({
        advisor: blocked([finding("state-ownership")]),
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

  it("strictly validates coordinator booleans", () => {
    const valid = snapshot({ advisor: clear() });
    const unverified = {
      ...valid,
      readiness: { ...valid.readiness, commitsVerified: "false" },
    };
    const draft = {
      ...valid,
      pullRequest: { ...valid.pullRequest, draft: "false" },
    };

    expect(() => parseCoordinatorSnapshot(unverified)).toThrow(
      "readiness.commitsVerified must be a boolean",
    );
    expect(() => parseCoordinatorSnapshot(draft)).toThrow("pullRequest.draft must be a boolean");
  });

  it("rejects unsupported Advisor identity", () => {
    const valid = snapshot({ advisor: clear() });
    const changed = {
      ...valid,
      advisor: { ...valid.advisor, identity: "synthetic-head" },
    };

    expect(() => parseCoordinatorSnapshot(changed)).toThrow("Advisor identity is invalid");
  });

  it.each([
    [
      "string commit verification",
      (valid: CoordinatorSnapshot) => ({
        ...valid,
        readiness: { ...valid.readiness, commitsVerified: "false" },
      }),
      "readiness.commitsVerified must be a boolean",
    ],
    [
      "unsupported Advisor identity",
      (valid: CoordinatorSnapshot) => ({
        ...valid,
        advisor: { ...valid.advisor, identity: "synthetic-head" },
      }),
      "Advisor identity is invalid",
    ],
  ])("fails the local JSON boundary for %s", (_case, mutate, expected) => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "coordinator-input-test-"));
    try {
      const input = path.join(directory, "snapshot.json");
      fs.writeFileSync(input, `${JSON.stringify(mutate(snapshot({ advisor: clear() })))}\n`);
      const result = spawnSync(
        process.execPath,
        ["--no-warnings", path.resolve("tools/pr-review-coordinator/local.mts"), "--input", input],
        { encoding: "utf8" },
      );

      expect(result.status).toBe(1);
      expect(result.stderr).toContain(expected);
      expect(result.stdout).not.toContain("would-approve");
    } finally {
      fs.rmSync(directory, { recursive: true, force: true });
    }
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

  it("proposes one exact-head changes-requested review in workflow shadow mode", () => {
    const result = evaluateCoordinatorShadow({
      context: {
        repo: "NVIDIA/NemoClaw",
        prNumber: 123,
        commitsVerified: true,
        coordinatorHistory: {
          contractEvidence: "none",
          frozenContractKeys: [],
          writes: [],
        },
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
      requiredChecks: "pass",
    });

    expect(result).toMatchObject({
      mode: "read-only-shadow",
      snapshot: {
        advisor: {
          findings: [{ validation: "validated" }],
        },
        readiness: { commitsVerified: true, productScope: "accepted" },
      },
      decision: { action: "would-request-changes", reason: "advisor-blockers-first-review" },
    });
  });

  it("proposes exact-head approval only when every workflow shadow gate passes", () => {
    const input = {
      context: {
        repo: "NVIDIA/NemoClaw",
        prNumber: 123,
        commitsVerified: true,
        coordinatorHistory: {
          contractEvidence: "none" as const,
          frozenContractKeys: [],
          writes: [],
        },
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
        status: "clear" as const,
        findingCount: 0,
        unresolvedRecommendationCount: 0,
        findingInterests: [],
        unresolvedInterests: [],
      },
      ledgers: [],
      prNumber: 123,
      headSha: HEAD,
      baseSha: BASE,
      requiredChecks: "pass" as const,
    };

    expect(evaluateCoordinatorShadow(input).decision).toMatchObject({
      action: "would-approve",
      reason: "advisor-clear-and-ready",
    });
    expect(
      evaluateCoordinatorShadow({
        ...input,
        context: { ...input.context, commitsVerified: false },
      }).decision,
    ).toMatchObject({ action: "stay-quiet", reason: "prerequisites-not-ready" });
    expect(
      evaluateCoordinatorShadow({ ...input, requiredChecks: "pending" }).decision,
    ).toMatchObject({ action: "stay-quiet", reason: "prerequisites-not-ready" });
  });

  it("fails the approval gate when the Advisor reports missing product scope", () => {
    const result = evaluateCoordinatorShadow({
      context: {
        repo: "NVIDIA/NemoClaw",
        prNumber: 123,
        commitsVerified: true,
        coordinatorHistory: {
          contractEvidence: "none",
          frozenContractKeys: [],
          writes: [],
        },
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
        findingInterests: ["product"],
        unresolvedInterests: [],
      },
      ledgers: [
        {
          version: 1,
          revision: 1,
          identity: "exact-head",
          headSha: HEAD,
          interest: "product",
          status: "findings",
          findings: [
            {
              id: "missing-product-scope",
              interest: "product",
              severity: "P1",
              kind: "product-scope",
              summary: "The new supported surface lacks an accepted product decision.",
              path: "src/integration.ts",
              line: 1,
              impact: "Ownership and lifecycle are undefined.",
              smallestSafeFix: "Obtain an accepted product decision.",
              regressionTest: "Record the accepted scope before approval.",
              exclusions: [],
            },
          ],
          noFindingsReason: null,
        },
      ],
      prNumber: 123,
      headSha: HEAD,
      baseSha: BASE,
      requiredChecks: "pass",
    });

    expect(result.snapshot.readiness.productScope).toBe("missing");
    expect(result.decision).toMatchObject({
      action: "would-request-changes",
      reason: "advisor-blockers-first-review",
      findingIds: ["missing-product-scope"],
    });
  });

  it("reuses reconstructed review history for repeated and newly proven findings", () => {
    const repeated = evaluateCoordinatorShadow(
      workflowShadowInput({
        history: {
          contractEvidence: "complete",
          frozenContractKeys: ["F-architecture-standard-work-123"],
          writes: [{ headSha: "4".repeat(40), kind: "request-changes" }],
        },
      }),
    );
    const delta = evaluateCoordinatorShadow(
      workflowShadowInput({
        history: {
          contractEvidence: "complete",
          frozenContractKeys: ["F-architecture-standard-work-123"],
          writes: [{ headSha: "4".repeat(40), kind: "request-changes" }],
        },
        findingIds: ["F-architecture-standard-work-123", "F-security-456"],
      }),
    );

    expect(repeated.decision).toMatchObject({
      action: "stay-quiet",
      reason: "repeated-contract-findings",
    });
    expect(delta.decision).toMatchObject({
      action: "would-request-changes",
      reason: "new-material-delta-blocker",
      findingIds: ["F-security-456"],
    });
  });

  it("fails quiet for incomplete or duplicate reconstructed review history", () => {
    const incomplete = evaluateCoordinatorShadow(
      workflowShadowInput({
        history: { contractEvidence: "incomplete", frozenContractKeys: [], writes: [] },
      }),
    );
    const duplicate = evaluateCoordinatorShadow(
      workflowShadowInput({
        history: {
          contractEvidence: "none",
          frozenContractKeys: [],
          writes: [{ headSha: HEAD, kind: "request-changes" }],
        },
      }),
    );

    expect(incomplete.decision).toMatchObject({
      action: "stay-quiet",
      reason: "ambiguous-follow-up",
    });
    expect(duplicate.decision).toMatchObject({
      action: "stay-quiet",
      reason: "duplicate-current-head-write",
    });
    expect(() =>
      evaluateCoordinatorShadow({
        ...workflowShadowInput(),
        context: { ...workflowShadowInput().context, coordinatorHistory: undefined },
      }),
    ).toThrow("review history must be an object");
  });
});

function snapshot(
  options: {
    headSha?: string;
    advisor?: CoordinatorSnapshot["advisor"];
    frozenContractKeys?: readonly string[];
    contractEvidence?: CoordinatorSnapshot["history"]["contractEvidence"];
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
      contractEvidence: options.contractEvidence ?? "none",
      frozenContractKeys: options.frozenContractKeys ?? [],
      writes: options.writes ?? [],
    },
  };
}

function workflowShadowInput(
  options: {
    findingIds?: readonly string[];
    history?: CoordinatorSnapshot["history"];
  } = {},
): Parameters<typeof evaluateCoordinatorShadow>[0] {
  const findingIds = options.findingIds ?? ["F-architecture-standard-work-123"];
  return {
    context: {
      repo: "NVIDIA/NemoClaw",
      prNumber: 123,
      commitsVerified: true,
      coordinatorHistory: options.history ?? {
        contractEvidence: "none",
        frozenContractKeys: [],
        writes: [],
      },
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
      findingCount: findingIds.length,
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
        findings: findingIds.map((id) => ({
          id,
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
        })),
        noFindingsReason: null,
      },
    ],
    prNumber: 123,
    headSha: HEAD,
    baseSha: BASE,
    requiredChecks: "pass",
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
