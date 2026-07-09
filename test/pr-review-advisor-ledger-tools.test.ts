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
      {
        operations: [
          {
            operation: "add",
            finding: finding(),
          },
        ],
      },
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
      { operations: [{ operation: "none", reason: "All nine security categories passed." }] },
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
      {
        operations: [
          { operation: "add", finding: finding() },
          {
            operation: "add",
            finding: {
              ...finding(),
              file: "src/lib/timeout.ts",
              line: 17,
              title: "Timeout status is masked",
              evidence: ["src/lib/timeout.ts:17 returns success after timeout"],
            },
          },
        ],
      },
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
      {
        operations: [
          {
            operation: "resolve",
            id: "F-001",
            reason: "The reconciliation evidence proves the refusal is propagated.",
            evidence: ["src/lib/runner.ts:42 now returns the refusal status"],
          },
        ],
      },
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

  it("rejects surplus tool fields and strips internal fields from direct operations (#6446)", () => {
    const ledger = createReviewFindingLedger();
    const controller = createReviewLedgerToolController(ledger);
    const update = tool(controller.tools, REVIEW_LEDGER_UPDATE_TOOL);
    const validBatch = { operations: [{ operation: "add", finding: finding() }] };

    expect(Check(update.parameters, validBatch)).toBe(true);
    expect(Check(update.parameters, { ...validBatch, rogue: true })).toBe(false);
    expect(
      Check(update.parameters, {
        operations: [{ operation: "add", finding: finding(), rogue: true }],
      }),
    ).toBe(false);
    expect(
      Check(update.parameters, {
        operations: [{ operation: "add", finding: { ...finding(), status: "resolved" } }],
      }),
    ).toBe(false);
    expect(
      Check(update.parameters, {
        operations: [{ operation: "update", id: "F-001", patch: { status: "resolved" } }],
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
