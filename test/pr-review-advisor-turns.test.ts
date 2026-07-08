// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import fs from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";
import { buildRiskPlan } from "../tools/advisors/risk-plan.mts";
import { settleAdvisorTurn } from "../tools/advisors/session.mts";
import {
  advisorExecutionErrors,
  buildPromptTurns,
  buildRiskPlanReviewContext,
  writePromptArtifacts,
  writeTurnArtifact,
} from "../tools/pr-review-advisor/analyze.mts";

const ROOT = path.resolve(import.meta.dirname, "..");
type ReviewMetadata = Parameters<typeof buildPromptTurns>[0]["metadata"];

function metadata(overrides: Partial<ReviewMetadata> = {}): ReviewMetadata {
  const deterministic = {
    diffStat: "1 file changed",
    commits: ["abc123 feat: add review advisor"],
    riskyAreas: [],
    riskPlan: buildRiskPlan({ headSha: "abc123def456", changedFiles: [] }),
    testDepth: {
      verdict: "unit_sufficient" as const,
      rationale: "deterministic fallback",
      suggestedTests: ["run unit tests"],
    },
    staticTestInventory: {
      changedTestFiles: [],
      nearbyTestNames: [],
      candidateExistingCoverage: [],
    },
    simplificationSignals: [],
    previousAdvisorReview: null,
    workflowSignals: [],
    localizedPatchSignals: [],
    monolithDeltas: [],
    driftEvidence: [],
    github: null,
  };
  return {
    baseRef: "origin/main",
    headRef: "HEAD",
    headSha: "abc123def456",
    changedFiles: ["tools/pr-review-advisor/analyze.mts"],
    deterministic,
    ...overrides,
  };
}

function loadAdvisorSchema(): Record<string, unknown> {
  return JSON.parse(
    fs.readFileSync(path.join(ROOT, "tools", "pr-review-advisor", "schema.json"), "utf8"),
  ) as Record<string, unknown>;
}

describe("PR review advisor turn trace", () => {
  it("keeps repeated risk-plan turn context bounded for broad PRs (#6446)", () => {
    const changedFiles = Array.from(
      { length: 3000 },
      (_, index) => `src/lib/actions/sandbox/${"x".repeat(180)}-${index}.ts`,
    );
    const riskPlan = buildRiskPlan({ headSha: "a".repeat(40), changedFiles });
    const reviewContext = buildRiskPlanReviewContext(riskPlan);
    const turns = buildPromptTurns({
      metadata: metadata({
        changedFiles,
        deterministic: { ...metadata().deterministic, riskPlan },
      }),
      diff: "diff --git a/x b/x",
      schema: loadAdvisorSchema(),
    });
    const riskContextBytes = turns
      .flatMap((turn) => turn.syntheticToolResults ?? [])
      .filter((result) =>
        /scope_risk|security_trust|tests_regressions|reconciliation/u.test(result.toolName),
      )
      .reduce((total, result) => total + Buffer.byteLength(result.content, "utf8"), 0);
    const exactMetadata = turns
      .at(-1)
      ?.syntheticToolResults?.find(
        (result) => result.toolName === "pr_review_exact_metadata",
      )?.content;

    expect(Buffer.byteLength(JSON.stringify(reviewContext), "utf8")).toBeLessThan(64 * 1024);
    expect(riskContextBytes).toBeLessThan(192 * 1024);
    expect(exactMetadata).toContain("runner restores all 3000 deterministic changed-file path(s)");
    expect(exactMetadata).not.toContain(changedFiles[0]);
  });

  it("writes split prompt artifacts with stable ordered filenames (#6446)", () => {
    const tmp = fs.mkdtempSync(path.join(ROOT, ".tmp-pr-advisor-prompts-"));
    const turns = buildPromptTurns({
      metadata: metadata(),
      diff: "diff --git a/src/lib/example.ts b/src/lib/example.ts\n+export const value = 1;",
      schema: loadAdvisorSchema(),
    });

    try {
      writePromptArtifacts({
        promptDir: path.join(tmp, "prompts"),
        systemPrompt: "system prompt",
        promptTurns: turns,
      });
      const written = fs
        .readdirSync(path.join(tmp, "prompts"))
        .sort((a, b) => a.localeCompare(b))
        .map((file) => `prompts/${file}`);

      expect(written).toEqual([
        "prompts/00-system.md",
        "prompts/01-scope-risk-map.md",
        "prompts/01-scope-risk-map.synthetic-tool-results",
        "prompts/02-correctness-state.md",
        "prompts/02-correctness-state.synthetic-tool-results",
        "prompts/03-security-trust.md",
        "prompts/03-security-trust.synthetic-tool-results",
        "prompts/04-tests-regressions.md",
        "prompts/04-tests-regressions.synthetic-tool-results",
        "prompts/05-ci-operations.md",
        "prompts/05-ci-operations.synthetic-tool-results",
        "prompts/06-reconcile-findings.md",
        "prompts/06-reconcile-findings.synthetic-tool-results",
        "prompts/07-synthesize-json.md",
        "prompts/07-synthesize-json.synthetic-tool-results",
      ]);
      expect(fs.readFileSync(path.join(tmp, "prompts", "00-system.md"), "utf8")).toContain(
        "system prompt",
      );
      expect(fs.readFileSync(path.join(tmp, "prompts", "07-synthesize-json.md"), "utf8")).toContain(
        "<pr_review_advisor_json>",
      );
      expect(
        fs.readFileSync(
          path.join(
            tmp,
            "prompts",
            "07-synthesize-json.synthetic-tool-results",
            "02-pr-review-advisor-json-schema.md",
          ),
          "utf8",
        ),
      ).toContain("Synthetic tool result");
      expect(fs.existsSync(path.join(tmp, "pr-review-advisor-prompt.md"))).toBe(false);
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  it("writes each settled advisor turn to a stable traversal-safe text artifact (#6446)", () => {
    const tmp = fs.mkdtempSync(path.join(ROOT, ".tmp-pr-advisor-turns-"));
    const turnDir = path.join(tmp, "turns");
    try {
      const first = writeTurnArtifact(turnDir, {
        index: 1,
        total: 7,
        name: "scope-risk-map",
        text: "- literal untrusted note: ../../do-not-follow\n",
        status: "completed",
      });
      const escaped = writeTurnArtifact(turnDir, {
        index: 2,
        total: 7,
        name: "../../escape",
        text: "working note",
        status: "failed",
        error: "provider\nmessage",
      });

      expect(path.basename(first)).toBe("01-scope-risk-map.txt");
      expect(path.dirname(escaped)).toBe(turnDir);
      expect(fs.readFileSync(first, "utf8")).toContain(
        "- literal untrusted note: ../../do-not-follow",
      );
      expect(fs.readFileSync(escaped, "utf8")).toContain("error: provider message");
      expect(fs.readFileSync(escaped, "utf8")).toContain("status: failed");
      expect(fs.existsSync(path.join(tmp, "escape.txt"))).toBe(false);
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  it("settles completed, rejected, timed-out, and callback-failed turns with partial text (#6446)", async () => {
    const completed: string[] = [];
    const success = await settleAdvisorTurn({
      index: 1,
      total: 7,
      name: "scope-risk-map",
      run: async () => {},
      readText: () => "complete notes",
      readError: () => undefined,
      onTurnComplete: (turn) => {
        completed.push(`${turn.status}:${turn.text}`);
      },
    });
    const timedOut = await settleAdvisorTurn({
      index: 2,
      total: 7,
      name: "correctness-state",
      run: async () => {
        throw new Error("timed out after 100 ms");
      },
      readText: () => "partial notes before timeout",
      readError: () => undefined,
      onTurnComplete: (turn) => {
        completed.push(`${turn.status}:${turn.text}`);
      },
    });
    const rejectedWithoutReason = await settleAdvisorTurn({
      index: 3,
      total: 7,
      name: "security-trust",
      run: () => Promise.reject(undefined),
      readText: () => "partial notes before rejection",
      readError: () => undefined,
    });
    const callbackFailed = await settleAdvisorTurn({
      index: 4,
      total: 7,
      name: "tests-regressions",
      run: async () => {},
      readText: () => "test notes",
      readError: () => undefined,
      onTurnComplete: () => {
        throw new Error("artifact disk full");
      },
    });
    const asyncCallbackFailed = await settleAdvisorTurn({
      index: 5,
      total: 7,
      name: "ci-operations",
      run: async () => {},
      readText: () => "operations notes",
      readError: () => undefined,
      onTurnComplete: async () => {
        throw new Error("async artifact disk full");
      },
    });
    const callbackRejectedWithoutReason = await settleAdvisorTurn({
      index: 6,
      total: 7,
      name: "reconcile-findings",
      run: async () => {},
      readText: () => "reconciliation notes",
      readError: () => undefined,
      onTurnComplete: () => {
        return Promise.reject(undefined);
      },
    });

    expect(success.turn.status).toBe("completed");
    expect(timedOut.turn).toMatchObject({
      status: "timed_out",
      text: "partial notes before timeout",
      error: "timed out after 100 ms",
    });
    expect(timedOut.didThrow).toBe(true);
    expect(timedOut.thrown).toBeInstanceOf(Error);
    expect(rejectedWithoutReason).toMatchObject({
      didThrow: true,
      turn: { status: "failed", error: "unknown advisor turn failure" },
    });
    expect(callbackFailed.callbackError).toBe("artifact disk full");
    expect(asyncCallbackFailed.callbackError).toBe("async artifact disk full");
    expect(callbackRejectedWithoutReason.callbackError).toBe(
      "unknown advisor turn callback failure",
    );
    expect(completed).toEqual([
      "completed:complete notes",
      "timed_out:partial notes before timeout",
    ]);
  });

  it("treats session, provider-turn, and turn-artifact errors as fatal execution evidence (#6446)", () => {
    expect(
      advisorExecutionErrors({
        text: "partial",
        raw: "raw transcript\n",
        turnTexts: ["partial"],
        turnErrors: ["security-trust: provider rejected"],
        turnCallbackErrors: ["scope-risk-map: disk full"],
        fatalError: "timed out after 100 ms",
      }),
    ).toEqual([
      "session: timed out after 100 ms",
      "turn: security-trust: provider rejected",
      "artifact: scope-risk-map: disk full",
    ]);
  });
});
