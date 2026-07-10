// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import type { ToolDefinition } from "@earendil-works/pi-coding-agent";
import { Check } from "typebox/value";
import { describe, expect, it } from "vitest";
import { buildRiskPlan } from "../tools/advisors/risk-plan.mts";
import {
  canonicalRetryFallback,
  normalizeReviewResult,
  partialLedgerFailureResult,
  reviewLedgerConsistencyIssues,
  withCanonicalReviewLedgerFindings,
} from "../tools/pr-review-advisor/analyze.mts";
import {
  createReviewFindingLedger,
  createReviewLedgerToolController,
  REVIEW_LEDGER_READ_TOOL,
  REVIEW_LEDGER_UPDATE_TOOL,
} from "../tools/pr-review-advisor/review-ledger.mts";

type CallableTool = ToolDefinition & {
  execute(
    toolCallId: string,
    params: Record<string, unknown>,
    signal: AbortSignal | undefined,
    onUpdate: undefined,
    context: never,
  ): Promise<{
    content: Array<{ type: string; text?: string }>;
    details: unknown;
    terminate?: boolean;
  }>;
};

function tool(tools: ToolDefinition[], name: string): CallableTool {
  const match = tools.find((candidate) => candidate.name === name);
  expect(match, `Missing tool ${name}`).toBeDefined();
  return match as CallableTool;
}

function contentJson(result: { content: Array<{ type: string; text?: string }> }): unknown {
  return JSON.parse(result.content[0]?.text ?? "null");
}

function finding() {
  return {
    severity: "warning" as const,
    category: "correctness" as const,
    file: "src/lib/runner.ts",
    line: 42,
    title: "Refusal status is masked",
    description: "The refusal path returns success.",
    impact: "Automation can treat a rejected action as successful.",
    recommendation: "Propagate the refusal status.",
    verificationHint: "Read the refusal return at src/lib/runner.ts:42.",
    missingRegressionTest: "Assert that refusal returns a nonzero status.",
    evidence: ["src/lib/runner.ts:42 returns zero on refusal"],
  };
}

function addition(overrides: Record<string, unknown> = {}) {
  return {
    ...finding(),
    basis: {
      kind: "behavior_mismatch",
      observed: "The refusal path returns success.",
      expected: "The refusal path returns a nonzero status.",
    },
    ...overrides,
  };
}

function ledgerCommit(
  overrides: Partial<{
    additions: unknown[];
    updates: unknown[];
    resolutions: unknown[];
    supersessions: unknown[];
    noChangesReason: string | null;
  }> = {},
) {
  return {
    additions: [],
    updates: [],
    resolutions: [],
    supersessions: [],
    noChangesReason: null,
    ...overrides,
  };
}

function reviewMetadata(): Parameters<typeof normalizeReviewResult>[1] {
  return {
    baseRef: "origin/main",
    headRef: "HEAD",
    headSha: "abc123def456",
    changedFiles: ["src/lib/runner.ts"],
    deterministic: {
      diffStat: "1 file changed",
      commits: [],
      riskyAreas: [],
      riskPlan: buildRiskPlan({ headSha: "abc123def456", changedFiles: [] }),
      testDepth: {
        verdict: "unit_sufficient",
        rationale: "deterministic fallback",
        suggestedTests: [],
      },
      staticTestInventory: {
        changedTestFiles: [],
        nearbyTestNames: [],
        candidateExistingCoverage: [],
      },
      simplificationSignals: [],
      workflowSignals: [],
      localizedPatchSignals: [],
      monolithDeltas: [],
      driftEvidence: [],
      previousAdvisorReview: null,
      github: null,
    },
  };
}

describe("PR review ledger tools", () => {
  it("requires every source-of-truth review item to declare findingId", () => {
    expect(() =>
      normalizeReviewResult(
        {
          sourceOfTruthReview: [{ surface: "resolved cleanup", status: "satisfied" }],
        },
        reviewMetadata(),
      ),
    ).toThrow("sourceOfTruthReview[1] must include findingId");
  });

  it("keeps source-of-truth prose from creating findings outside the ledger", () => {
    const ledger = createReviewFindingLedger();
    ledger.applyBatch([{ operation: "add", finding: finding() }], "correctness-state");
    const result = normalizeReviewResult(
      {
        findings: [{ ...finding(), evidence: finding().evidence.join("\n") }],
        sourceOfTruthReview: [
          {
            surface: "best-effort refusal cleanup",
            status: "needs_followup",
            findingId: "F-001",
            invalidState: "A refusal can be reported as success.",
            sourceBoundary: "Runner refusal handling.",
            whyNotSourceFix: "Not established.",
            regressionTest: finding().missingRegressionTest,
            removalCondition: "Remove the cleanup when refusal state is impossible.",
            evidence: finding().evidence[0],
          },
        ],
      },
      reviewMetadata(),
    );

    expect(result.findings).toHaveLength(1);
    expect(reviewLedgerConsistencyIssues(result, ledger.snapshot())).toEqual([]);
  });

  it("rejects unresolved source-of-truth review without an open ledger finding", () => {
    const result = normalizeReviewResult(
      {
        findings: [],
        sourceOfTruthReview: [
          {
            surface: "best-effort cleanup",
            status: "missing",
            findingId: null,
            invalidState: "A failed resource may remain allocated.",
            sourceBoundary: "Resource creation lifecycle.",
            whyNotSourceFix: "Not established.",
            regressionTest: "Missing.",
            removalCondition: "Unknown.",
            evidence: "The cleanup suppresses deletion failures.",
          },
        ],
      },
      reviewMetadata(),
    );

    const snapshot = createReviewFindingLedger().snapshot();
    expect(reviewLedgerConsistencyIssues(result, snapshot)).toEqual([
      "sourceOfTruthReview[1] best-effort cleanup must reference an open ledger finding",
    ]);
    expect(canonicalRetryFallback(result, snapshot)).toBeNull();
  });

  it("preserves canonical findings when a later advisor stage fails", () => {
    const ledger = createReviewFindingLedger();
    ledger.applyBatch([{ operation: "add", finding: finding() }], "correctness-state");

    const result = partialLedgerFailureResult(
      reviewMetadata(),
      "tests-regressions omitted its ledger commit",
      ledger.snapshot(),
    );

    expect(result).toMatchObject({
      summary: { confidence: "low", recommendation: "merge_after_fixes" },
      findings: [{ title: finding().title }],
      reviewCompleteness: { requiresHumanReview: true },
    });
    expect(result?.findings[0]?.title).not.toBe("PR review advisor unavailable");
    expect(result?.reviewCompleteness.limitations[0]).toContain(
      "stopped before completing all review stages",
    );
  });

  it("binds mutations to the runner stage and exposes the canonical snapshot (#6446)", async () => {
    const ledger = createReviewFindingLedger();
    const controller = createReviewLedgerToolController(ledger);
    const update = tool(controller.tools, REVIEW_LEDGER_UPDATE_TOOL);
    const read = tool(controller.tools, REVIEW_LEDGER_READ_TOOL);
    controller.setStage("correctness-state");

    const updated = await update.execute(
      "update-1",
      ledgerCommit({ additions: [addition()] }),
      undefined,
      undefined,
      undefined as never,
    );
    controller.setStage("synthesize-json");
    const snapshot = await read.execute("read-1", {}, undefined, undefined, undefined as never);

    expect(updated.details).toMatchObject({ revision: 1 });
    expect(updated.terminate).toBe(true);
    expect(snapshot.terminate).toBe(false);
    expect(ledger.snapshot().history).toMatchObject([
      { operation: "add", stage: "correctness-state" },
    ]);
    expect(ledger.snapshot().findings[0]).not.toHaveProperty("basis");
    expect(ledger.snapshot().history[0]?.change).not.toHaveProperty("basis");
    expect(contentJson(snapshot)).toMatchObject({
      revision: 1,
      findings: [{ id: "F-001", status: "open", severity: "warning" }],
    });
  });

  it("records an explicit no-change receipt without mutating the ledger (#6446)", async () => {
    const ledger = createReviewFindingLedger();
    const controller = createReviewLedgerToolController(ledger);
    controller.setStage("security-trust");
    const result = await tool(controller.tools, REVIEW_LEDGER_UPDATE_TOOL).execute(
      "update-none",
      ledgerCommit({ noChangesReason: "All nine security categories passed." }),
      undefined,
      undefined,
      undefined as never,
    );

    expect(result.details).toMatchObject({ revision: 1 });
    expect(contentJson(result)).toMatchObject({
      revision: 1,
      findings: [],
    });
    expect(ledger.snapshot().history).toMatchObject([
      { operation: "none", stage: "security-trust" },
    ]);
  });

  it("commits every independent stage finding in one atomic terminating batch (#6446)", async () => {
    const ledger = createReviewFindingLedger();
    const controller = createReviewLedgerToolController(ledger);
    controller.setStage("correctness-state");
    const result = await tool(controller.tools, REVIEW_LEDGER_UPDATE_TOOL).execute(
      "update-many",
      ledgerCommit({
        additions: [
          addition(),
          addition({
            file: "src/lib/timeout.ts",
            line: 17,
            title: "Timeout status is masked",
            evidence: ["src/lib/timeout.ts:17 returns success after timeout"],
          }),
        ],
      }),
      undefined,
      undefined,
      undefined as never,
    );

    expect(result.terminate).toBe(true);
    expect(result.details).toMatchObject({ revision: 2 });
    expect(ledger.snapshot().findings).toMatchObject([
      { id: "F-001", title: "Refusal status is masked" },
      { id: "F-002", title: "Timeout status is masked" },
    ]);
  });

  it("shows synthesis only open findings while preserving the full audit ledger (#6446)", async () => {
    const ledger = createReviewFindingLedger();
    ledger.applyBatch(
      [
        { operation: "add", finding: finding() },
        {
          operation: "add",
          finding: {
            ...finding(),
            title: "Independent open finding",
            evidence: ["src/lib/runner.ts:52 has a second independent defect"],
          },
        },
      ],
      "correctness-state",
    );
    const controller = createReviewLedgerToolController(ledger);
    controller.setStage("reconcile-findings");
    const reconciled = await tool(controller.tools, REVIEW_LEDGER_UPDATE_TOOL).execute(
      "resolve-one",
      ledgerCommit({
        resolutions: [
          {
            id: "F-001",
            reason: "The reconciliation evidence proves the refusal is propagated.",
            evidence: ["src/lib/runner.ts:42 now returns the refusal status"],
          },
        ],
      }),
      undefined,
      undefined,
      undefined as never,
    );
    controller.setStage("synthesize-json");

    const result = await tool(controller.tools, REVIEW_LEDGER_READ_TOOL).execute(
      "read-open",
      {},
      undefined,
      undefined,
      undefined as never,
    );

    expect(contentJson(reconciled)).toMatchObject({
      revision: 3,
      findings: [{ id: "F-002", status: "open", title: "Independent open finding" }],
    });
    expect(contentJson(result)).toMatchObject({
      revision: 3,
      findings: [{ id: "F-002", status: "open", title: "Independent open finding" }],
    });
    expect(ledger.snapshot().findings).toMatchObject([
      { id: "F-001", status: "resolved" },
      { id: "F-002", status: "open" },
    ]);
  });

  it("translates flat reconciliation updates and supersessions atomically (#6446)", async () => {
    const ledger = createReviewFindingLedger();
    ledger.applyBatch(
      [
        { operation: "add", finding: finding() },
        {
          operation: "add",
          finding: { ...finding(), title: "Duplicate refusal symptom" },
        },
      ],
      "correctness-state",
    );
    const controller = createReviewLedgerToolController(ledger);
    controller.setStage("reconcile-findings");

    const result = await tool(controller.tools, REVIEW_LEDGER_UPDATE_TOOL).execute(
      "reconcile-flat",
      ledgerCommit({
        updates: [
          {
            id: "F-001",
            patch: { title: "Refusal status and duplicate symptom are masked" },
            reason: "Both citations reach the same refusal return.",
            evidence: ["src/lib/runner.ts:43 shares the refusal return"],
          },
        ],
        supersessions: [
          {
            id: "F-002",
            supersededBy: "F-001",
            reason: "The second symptom has the same root cause.",
            evidence: ["src/lib/runner.ts:43 reaches the F-001 return"],
          },
        ],
      }),
      undefined,
      undefined,
      undefined as never,
    );

    expect(result.details).toMatchObject({ revision: 4 });
    expect(contentJson(result)).toMatchObject({
      findings: [{ id: "F-001", title: "Refusal status and duplicate symptom are masked" }],
    });
    expect(ledger.snapshot().findings).toMatchObject([
      { id: "F-001", status: "open" },
      { id: "F-002", status: "superseded", supersededBy: "F-001" },
    ]);
  });

  it("rolls back the entire stage batch when a later operation fails (#6446)", () => {
    const ledger = createReviewFindingLedger();

    expect(() =>
      ledger.applyBatch(
        [
          { operation: "add", finding: finding() },
          { operation: "update", id: "F-999", patch: { title: "Cannot exist" } },
        ],
        "correctness-state",
      ),
    ).toThrow("Finding F-999 does not exist");
    expect(ledger.snapshot()).toMatchObject({ revision: 0, findings: [], history: [] });
  });

  it("accepts only the flat exact commit contract and strips internal fields (#6446)", () => {
    const ledger = createReviewFindingLedger();
    const controller = createReviewLedgerToolController(ledger);
    const update = tool(controller.tools, REVIEW_LEDGER_UPDATE_TOOL);
    const validBatch = ledgerCommit({ additions: [addition()] });

    expect(Check(update.parameters, validBatch)).toBe(true);
    expect(
      Check(update.parameters, {
        operations: [{ operation: "add", finding: finding() }],
      }),
    ).toBe(false);
    expect(
      Check(update.parameters, { ...validBatch, additions: JSON.stringify([addition()]) }),
    ).toBe(false);
    const { noChangesReason: _noChangesReason, ...missingField } = validBatch;
    expect(Check(update.parameters, missingField)).toBe(false);
    expect(Check(update.parameters, { ...validBatch, rogue: true })).toBe(false);
    expect(
      Check(update.parameters, {
        ...validBatch,
        additions: [{ ...addition(), rogue: true }],
      }),
    ).toBe(false);
    expect(
      Check(update.parameters, {
        ...validBatch,
        additions: [{ ...addition(), status: "resolved" }],
      }),
    ).toBe(false);
    expect(
      Check(update.parameters, {
        ...validBatch,
        additions: [{ ...addition(), line: 0 }],
      }),
    ).toBe(false);
    expect(
      Check(update.parameters, {
        ...validBatch,
        additions: [],
        updates: [
          {
            id: "F-001",
            patch: { status: "resolved" },
            reason: "Invalid patch.",
            evidence: ["new evidence"],
          },
        ],
      }),
    ).toBe(false);
    expect(
      Check(update.parameters, {
        ...validBatch,
        additions: [],
        updates: [
          {
            id: "F-001",
            patch: { file: null, line: null },
            reason: "Invalid location removal.",
            evidence: ["new evidence"],
          },
        ],
      }),
    ).toBe(false);

    ledger.applyBatch(
      [
        {
          operation: "add",
          finding: { ...finding(), status: "resolved", rogue: true },
        } as never,
      ],
      "correctness-state",
    );
    ledger.applyBatch(
      [
        {
          operation: "update",
          id: "F-001",
          patch: { title: "Updated title", status: "resolved" },
          reason: "New evidence changes the title.",
          evidence: ["src/lib/runner.ts:43 confirms the updated title"],
        } as never,
      ],
      "correctness-state",
    );
    expect(ledger.snapshot().findings[0]).toMatchObject({
      id: "F-001",
      status: "open",
      title: "Updated title",
    });
    expect(ledger.snapshot().findings[0]).not.toHaveProperty("rogue");
    expect(ledger.snapshot().history[0]?.change).not.toHaveProperty("status");
    expect(ledger.snapshot().history[0]?.change).not.toHaveProperty("rogue");
    expect(ledger.snapshot().history[1]?.change).not.toHaveProperty("status");
  });

  it.each([
    [
      "mixing a no-change receipt with a mutation",
      "correctness-state",
      ledgerCommit({ additions: [addition()], noChangesReason: "Nothing changed." }),
      "noChangesReason is mutually exclusive",
    ],
    [
      "an empty commit without a no-change receipt",
      "correctness-state",
      ledgerCommit(),
      "requires a mutation or a non-null noChangesReason",
    ],
    [
      "a transition outside reconciliation",
      "correctness-state",
      ledgerCommit({
        resolutions: [{ id: "F-001", reason: "Resolved.", evidence: ["new evidence"] }],
      }),
      "Only reconcile-findings may transition",
    ],
    [
      "a new finding during reconciliation",
      "reconcile-findings",
      ledgerCommit({ additions: [addition()] }),
      "reconcile-findings may not add",
    ],
    [
      "a category owned by another stage",
      "security-trust",
      ledgerCommit({ additions: [addition()] }),
      "security-trust may not add category=correctness",
    ],
    [
      "a basis owned by another stage",
      "security-trust",
      ledgerCommit({
        additions: [addition({ category: "security", basis: addition().basis })],
      }),
      "security-trust may not add basis.kind=behavior_mismatch",
    ],
  ])("rejects %s atomically", async (_label, stage, commit, message) => {
    const ledger = createReviewFindingLedger();
    const controller = createReviewLedgerToolController(ledger);
    controller.setStage(stage);

    await expect(
      tool(controller.tools, REVIEW_LEDGER_UPDATE_TOOL).execute(
        "invalid-commit",
        commit,
        undefined,
        undefined,
        undefined as never,
      ),
    ).rejects.toThrow(message);
    expect(ledger.snapshot()).toMatchObject({ revision: 0, findings: [], history: [] });
  });

  it("rejects a candidate whose observed and expected states are the same", async () => {
    const ledger = createReviewFindingLedger();
    const controller = createReviewLedgerToolController(ledger);
    controller.setStage("security-trust");
    const candidate = addition({
      category: "security",
      title: "Argv authentication tightened and blocks spoofing",
      basis: {
        kind: "security_violation",
        observed: "The implementation validates the requested identity.",
        expected: "  the implementation VALIDATES the requested identity.  ",
      },
    });

    await expect(
      tool(controller.tools, REVIEW_LEDGER_UPDATE_TOOL).execute(
        "ineligible-finding",
        ledgerCommit({ additions: [candidate] }),
        undefined,
        undefined,
        undefined as never,
      ),
    ).rejects.toThrow("basis.observed and basis.expected must describe different states");
    expect(ledger.snapshot()).toMatchObject({ revision: 0, findings: [], history: [] });
  });

  it.each([
    [
      "provider timeout handling",
      "correctness-state",
      addition({
        title: "Provider timeout is reported as success",
        description: "The timeout branch returns a successful result.",
        basis: {
          kind: "behavior_mismatch",
          observed: "A provider timeout returns success.",
          expected: "A provider timeout returns a failure.",
        },
      }),
    ],
    [
      "open-PR overlap detection",
      "scope-risk-map",
      addition({
        category: "scope",
        title: "Open PR overlap detection ignores renamed files",
        description: "The detector compares only destination paths.",
        basis: {
          kind: "behavior_mismatch",
          observed: "A renamed source path is absent from overlap detection.",
          expected: "Overlap detection compares both sides of a rename.",
        },
      }),
    ],
    [
      "checked-in E2E job validation",
      "tests-regressions",
      addition({
        category: "tests",
        title: "Cloud-onboard job omits the failure-path assertion",
        recommendation: "Update the checked-in job to assert the failing exit code.",
        basis: {
          kind: "missing_regression",
          observed: "The job covers only the successful exit path.",
          expected: "The job asserts both successful and failing exit paths.",
        },
      }),
    ],
  ])("keeps a concrete %s defect eligible", async (_label, stage, candidate) => {
    const ledger = createReviewFindingLedger();
    const controller = createReviewLedgerToolController(ledger);
    controller.setStage(stage);

    await expect(
      tool(controller.tools, REVIEW_LEDGER_UPDATE_TOOL).execute(
        "eligible-finding",
        ledgerCommit({ additions: [candidate] }),
        undefined,
        undefined,
        undefined as never,
      ),
    ).resolves.toMatchObject({ details: { revision: 1 }, terminate: true });
    expect(ledger.snapshot().findings).toMatchObject([
      { id: "F-001", title: candidate.title, status: "open" },
    ]);
  });

  it("detects synthesis drift and publishes the ledger's canonical finding (#6446)", () => {
    const ledger = createReviewFindingLedger();
    ledger.applyBatch([{ operation: "add", finding: finding() }], "correctness-state");
    const drifted = {
      summary: {
        recommendation: "merge_as_is",
        confidence: "high",
        oneLine: "No findings.",
      },
      findings: [
        {
          severity: "suggestion",
          category: "correctness",
          file: "src/lib/runner.ts",
          line: 42,
          title: "Refusal status is masked",
          description: "The refusal path returns success.",
          impact: "Automation can treat a rejected action as successful.",
          recommendation: "Propagate the refusal status.",
          verificationHint: "Read the refusal return at src/lib/runner.ts:42.",
          missingRegressionTest: "Assert that refusal returns a nonzero status.",
          evidence: "src/lib/runner.ts:42 returns zero on refusal",
        },
      ],
    } as unknown as Parameters<typeof reviewLedgerConsistencyIssues>[0];

    expect(reviewLedgerConsistencyIssues(drifted, ledger.snapshot())).toEqual([
      "final findings[1] diverges from canonical ledger finding F-001",
    ]);
    expect(
      withCanonicalReviewLedgerFindings(drifted, ledger.snapshot()).findings[0]?.severity,
    ).toBe("warning");
    expect(withCanonicalReviewLedgerFindings(drifted, ledger.snapshot()).summary).toMatchObject({
      recommendation: "merge_after_fixes",
      topItem: "Refusal status is masked",
    });
  });

  it("requires a reason and new evidence to change a conclusion (#6446)", () => {
    const ledger = createReviewFindingLedger();
    ledger.applyBatch([{ operation: "add", finding: finding() }], "correctness-state");
    const update = {
      operation: "update" as const,
      id: "F-001",
      patch: { severity: "blocker" as const },
    };

    expect(() => ledger.applyBatch([update], "reconcile-findings")).toThrow("requires a reason");
    expect(() =>
      ledger.applyBatch(
        [{ ...update, reason: "Tests found higher impact.", evidence: ["new test evidence"] }],
        "tests-regressions",
      ),
    ).toThrow("Only reconcile-findings may reclassify");
    expect(() =>
      ledger.applyBatch(
        [{ operation: "update", id: "F-001", patch: { title: "Reworded conclusion" } }],
        "correctness-state",
      ),
    ).toThrow("requires a reason");
    expect(() =>
      ledger.applyBatch(
        [{ ...update, reason: "Acceptance makes this blocking.", evidence: finding().evidence }],
        "reconcile-findings",
      ),
    ).toThrow("requires new evidence");
    ledger.applyBatch(
      [
        {
          ...update,
          reason: "Acceptance makes this blocking.",
          evidence: ["Issue #6466 requires nonzero refusal status"],
        },
      ],
      "reconcile-findings",
    );
    expect(ledger.snapshot().findings[0]).toMatchObject({ id: "F-001", severity: "blocker" });
    expect(ledger.snapshot().history.at(-1)?.addedEvidence).toEqual([
      "Issue #6466 requires nonzero refusal status",
    ]);
  });
});
