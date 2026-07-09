// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import type { ToolDefinition } from "@earendil-works/pi-coding-agent";
import { describe, expect, it } from "vitest";
import {
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

describe("PR review ledger tools", () => {
  it("binds mutations to the runner stage and exposes the canonical snapshot", async () => {
    const ledger = createReviewFindingLedger();
    const controller = createReviewLedgerToolController(ledger);
    const update = tool(controller.tools, REVIEW_LEDGER_UPDATE_TOOL);
    const read = tool(controller.tools, REVIEW_LEDGER_READ_TOOL);
    controller.setStage("correctness-state");

    const updated = await update.execute(
      "update-1",
      {
        operation: "add",
        finding: finding(),
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

  it("records an explicit no-change receipt without mutating the ledger", async () => {
    const ledger = createReviewFindingLedger();
    const controller = createReviewLedgerToolController(ledger);
    controller.setStage("security-trust");
    const result = await tool(controller.tools, REVIEW_LEDGER_UPDATE_TOOL).execute(
      "update-none",
      { operation: "none", reason: "All nine security categories passed." },
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

  it("detects synthesis drift and publishes the ledger's canonical finding", () => {
    const ledger = createReviewFindingLedger();
    ledger.apply({ operation: "add", finding: finding() }, "correctness-state");
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

  it("requires a reason and new evidence to change a conclusion", () => {
    const ledger = createReviewFindingLedger();
    ledger.apply({ operation: "add", finding: finding() }, "correctness-state");
    const update = {
      operation: "update" as const,
      id: "F-001",
      patch: { severity: "blocker" as const },
    };

    expect(() => ledger.apply(update, "reconcile-findings")).toThrow("requires a reason");
    expect(() =>
      ledger.apply(
        { ...update, reason: "Tests found higher impact.", evidence: ["new test evidence"] },
        "tests-regressions",
      ),
    ).toThrow("Only reconcile-findings may reclassify");
    expect(() =>
      ledger.apply(
        { operation: "update", id: "F-001", patch: { title: "Reworded conclusion" } },
        "correctness-state",
      ),
    ).toThrow("requires a reason");
    expect(() =>
      ledger.apply(
        { ...update, reason: "Acceptance makes this blocking.", evidence: finding().evidence },
        "reconcile-findings",
      ),
    ).toThrow("requires new evidence");
    ledger.apply(
      {
        ...update,
        reason: "Acceptance makes this blocking.",
        evidence: ["Issue #6466 requires nonzero refusal status"],
      },
      "reconcile-findings",
    );
    expect(ledger.snapshot().findings[0]).toMatchObject({ id: "F-001", severity: "blocker" });
    expect(ledger.snapshot().history.at(-1)?.addedEvidence).toEqual([
      "Issue #6466 requires nonzero refusal status",
    ]);
  });
});
