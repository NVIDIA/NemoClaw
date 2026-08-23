// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import path from "node:path";

import { describe, expect, it } from "vitest";
import { buildRiskPlan } from "../tools/advisors/risk-plan.mts";
import { settleAdvisorTurn } from "../tools/advisors/session.mts";
import { advisorExecutionErrors, buildPromptTurns } from "../tools/pr-review-advisor/analyze.mts";
import { artifactPaths } from "../tools/pr-review-advisor/artifacts.mts";
import { buildRiskPlanReviewContext } from "../tools/pr-review-advisor/turn-context.mts";

const ROOT = path.resolve(import.meta.dirname, "..");
type ReviewMetadata = Parameters<typeof buildPromptTurns>[0]["metadata"];

function metadata(
  changedFiles = ["tools/pr-review-advisor/analyze.mts"],
  riskPlan = buildRiskPlan({ headSha: "abc123def456", changedFiles: [] }),
): ReviewMetadata {
  return {
    baseRef: "origin/main",
    headRef: "HEAD",
    headSha: "abc123def456",
    changedFiles,
    deterministic: {
      diffStat: "1 file changed",
      commits: ["abc123 feat: add review advisor"],
      riskyAreas: [],
      riskPlan,
      testDepth: {
        verdict: "unit_sufficient",
        rationale: "deterministic fallback",
        suggestedTests: ["run unit tests"],
      },
      staticTestInventory: {
        changedTestFiles: [],
        nearbyTestNames: [],
        candidateExistingCoverage: [],
      },
      simplificationSignals: [],
      workflowSignals: [],
      localizedPatchSignals: [],
      driftEvidence: [],
      github: null,
    },
  };
}

describe("PR review advisor turn trace", () => {
  it("keeps the HTML session as the only debugging transcript", () => {
    expect(artifactPaths("artifacts/pr-review-advisor")).toEqual({
      result: path.join("artifacts/pr-review-advisor", "pr-review-advisor-result.json"),
      finalResult: path.join("artifacts/pr-review-advisor", "pr-review-advisor-final-result.json"),
      summary: path.join("artifacts/pr-review-advisor", "pr-review-advisor-summary.md"),
      sessionHtml: path.join("artifacts/pr-review-advisor", "pr-review-advisor-session.html"),
    });
  });
  it("keeps repeated risk-plan stage context bounded for broad PRs (#6446)", () => {
    const changedFiles = Array.from(
      { length: 3000 },
      (_, index) => `src/lib/actions/sandbox/${"x".repeat(180)}-${index}.ts`,
    );
    const riskPlan = buildRiskPlan({ headSha: "a".repeat(40), changedFiles });
    const reviewContext = buildRiskPlanReviewContext(riskPlan) as {
      changedFiles: { count: number; sample: string[]; omitted: number };
    };
    const turns = buildPromptTurns({
      metadata: metadata(changedFiles, riskPlan),
      diffPath: ".pr-review-advisor-context/diff.patch",
    });
    const riskBytes = turns
      .flatMap((turn) => turn.contextToolResults ?? [])
      .filter((result) => result.contentType === "json" && result.content.includes('"riskPlan"'))
      .reduce((total, result) => total + Buffer.byteLength(result.content, "utf8"), 0);
    const investigationContext = turns
      .find((turn) => turn.name === "investigate")
      ?.contextToolResults?.find((result) => result.toolName === "pr_review_metadata")?.content;

    expect(reviewContext.changedFiles).toMatchObject({ count: 3000, omitted: 2980 });
    expect(reviewContext.changedFiles.sample).toHaveLength(20);
    expect(reviewContext.changedFiles.sample.every((file) => file.length <= 240)).toBe(true);
    expect(riskBytes).toBeLessThan(192 * 1024);
    expect(investigationContext).toContain(
      "runner restores all 3000 deterministic changed-file path(s)",
    );
    expect(investigationContext).not.toContain(changedFiles[0]);
  });

  it("settles turns and reports provider or callback errors (#6446)", async () => {
    const settle = (overrides: Partial<Parameters<typeof settleAdvisorTurn>[0]>) =>
      settleAdvisorTurn({
        index: 1,
        total: 1,
        name: "stage",
        run: async () => {},
        readText: () => "partial notes",
        readError: () => undefined,
        ...overrides,
      });

    const [timedOut, reasonless, syncArtifact, asyncArtifact, reasonlessArtifact] =
      await Promise.all([
        settle({ run: async () => Promise.reject(new Error("timed out after 100 ms")) }),
        settle({ run: () => Promise.reject(undefined) }),
        settle({
          onTurnComplete: () => {
            throw new Error("artifact disk full");
          },
        }),
        settle({
          onTurnComplete: async () => {
            throw new Error("async artifact disk full");
          },
        }),
        settle({ onTurnComplete: () => Promise.reject(undefined) }),
      ]);

    expect(timedOut.turn).toMatchObject({
      status: "timed_out",
      text: "partial notes",
      error: "timed out after 100 ms",
    });
    expect(reasonless.turn.error).toBe("unknown advisor turn failure");
    expect(reasonless.didThrow).toBe(true);
    expect(reasonless).toHaveProperty("thrown", undefined);
    let completedText: string | undefined;
    const completed = await settle({
      onTurnComplete: (turn) => {
        completedText = turn.text;
      },
    });
    expect(completed.didThrow).toBe(false);
    expect(completedText).toBe("partial notes");
    expect([
      syncArtifact.callbackError,
      asyncArtifact.callbackError,
      reasonlessArtifact.callbackError,
    ]).toEqual([
      "artifact disk full",
      "async artifact disk full",
      "unknown advisor turn callback failure",
    ]);
    expect(
      advisorExecutionErrors({
        text: "partial",
        raw: "raw transcript\n",
        turnTexts: ["partial"],
        turnErrors: ["stage: provider rejected"],
        turnCallbackErrors: ["stage: disk full"],
        fatalError: "timed out after 100 ms",
      }),
    ).toEqual([
      "session: timed out after 100 ms",
      "turn: stage: provider rejected",
      "artifact: stage: disk full",
    ]);
  });
});
