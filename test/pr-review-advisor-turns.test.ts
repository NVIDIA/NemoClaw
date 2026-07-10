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
      previousAdvisorReview: null,
      workflowSignals: [],
      localizedPatchSignals: [],
      monolithDeltas: [],
      driftEvidence: [],
      github: null,
    },
  };
}

function schema(): Record<string, unknown> {
  return JSON.parse(
    fs.readFileSync(path.join(ROOT, "tools/pr-review-advisor/schema.json"), "utf8"),
  ) as Record<string, unknown>;
}

describe("PR review advisor turn trace", () => {
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
      diff: "diff --git a/x b/x",
      schema: schema(),
    });
    const riskBytes = turns
      .flatMap((turn) => turn.contextToolResults ?? [])
      .filter((result) => result.contentType === "json" && result.content.includes('"riskPlan"'))
      .reduce((total, result) => total + Buffer.byteLength(result.content, "utf8"), 0);
    const exactMetadata = turns
      .at(-1)
      ?.contextToolResults?.find(
        (result) => result.toolName === "pr_review_exact_metadata",
      )?.content;

    expect(reviewContext.changedFiles).toMatchObject({ count: 3000, omitted: 2980 });
    expect(reviewContext.changedFiles.sample).toHaveLength(20);
    expect(reviewContext.changedFiles.sample.every((file) => file.length <= 240)).toBe(true);
    expect(riskBytes).toBeLessThan(192 * 1024);
    expect(exactMetadata).toContain("runner restores all 3000 deterministic changed-file path(s)");
    expect(exactMetadata).not.toContain(changedFiles[0]);
  });

  it("derives ordered prompt artifact names from arbitrary stages (#6446)", () => {
    const tmp = fs.mkdtempSync(path.join(ROOT, ".tmp-pr-advisor-prompts-"));
    const promptDir = path.join(tmp, "prompts");
    const turns = [
      { name: "first-stage", prompt: "first", contextToolResults: [] },
      {
        name: "final-stage",
        prompt: "final",
        contextToolResults: [
          { toolName: "final_context", content: "{}", contentType: "json" as const },
        ],
      },
    ];
    try {
      writePromptArtifacts({ promptDir, systemPrompt: "system prompt", promptTurns: turns });
      expect(fs.readdirSync(promptDir).sort((left, right) => left.localeCompare(right))).toEqual([
        "00-system.md",
        "01-first-stage.md",
        "02-final-stage.md",
        "02-final-stage.tool-results",
      ]);
      expect(
        fs.existsSync(path.join(promptDir, "02-final-stage.tool-results", "01-final_context.md")),
      ).toBe(true);
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  it("persists settled turns and fails closed on provider or artifact errors (#6446)", async () => {
    const tmp = fs.mkdtempSync(path.join(ROOT, ".tmp-pr-advisor-turns-"));
    const artifact = writeTurnArtifact(path.join(tmp, "turns"), {
      index: 1,
      total: 1,
      name: "../../escape",
      text: "partial notes",
      status: "failed",
      error: "provider\nmessage",
    });
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

    try {
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

      expect(path.dirname(artifact)).toBe(path.join(tmp, "turns"));
      const artifactText = fs.readFileSync(artifact, "utf8");
      expect(artifactText).toContain("status: failed");
      expect(artifactText).toContain("partial notes");
      expect(artifactText).toContain("error: provider message");
      expect(fs.existsSync(path.join(tmp, "escape.txt"))).toBe(false);
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
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });
});
