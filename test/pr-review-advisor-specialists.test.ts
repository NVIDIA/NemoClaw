// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

import type { ToolDefinition } from "@earendil-works/pi-coding-agent";
import { describe, expect, it, onTestFinished, vi } from "vitest";

import { TERMINOLOGY_TRACE_TOOL } from "../tools/pr-review-advisor/terminology.mts";
import { runSpecialistAdvisor } from "../tools/pr-review-advisor/run-specialist.mts";
import type { RunAdvisorResult, RunReadOnlyAdvisorOptions } from "../tools/advisors/session.mts";
import {
  ADVISOR_INTERESTS,
  buildSpecialistInvestigateTurn,
  parseAdvisorInterest,
  type AdvisorInterest,
} from "../tools/pr-review-advisor/specialists.mts";
import type { InvestigateTurnContext } from "../tools/pr-review-advisor/investigate-turn.mts";

type CallableTool = ToolDefinition & {
  execute(
    toolCallId: string,
    params: Record<string, unknown>,
    signal: AbortSignal | undefined,
    onUpdate: undefined,
    context: never,
  ): Promise<{ content: Array<{ type: string; text?: string }> }>;
};

const context: InvestigateTurnContext = {
  scopeRisk: { riskPlan: { invariants: ["preserve identity"] } },
  diff: "diff --git a/source.ts b/source.ts",
  controlledWords: "controlled words",
  terminology: { candidates: [] },
  correctness: { state: "context" },
  security: { riskyAreas: [] },
  tests: { testDepth: "unit" },
  operations: { workflowSignals: [] },
  reconciliation: { linkedIssues: [] },
  metadata: "baseRef=origin/main",
};

const DOMAIN_TERMS: Record<AdvisorInterest, readonly string[]> = {
  behavior: ["binding acceptance", "state transitions", "caller and callee contracts"],
  trust: ["all nine security categories", "credentials", "workflow trust boundaries"],
  "design-architecture": ["duplicated authority", "dependency width", "reduction case"],
  operations: ["E2E architecture", "retries", "release operations"],
  documentation: ["user documentation", "test titles", "terminology candidates semantically"],
};

describe("PR review advisor specialist prompts", () => {
  it("parses exactly the five supported interests (#9949)", () => {
    expect(ADVISOR_INTERESTS).toEqual([
      "behavior",
      "trust",
      "design-architecture",
      "operations",
      "documentation",
    ]);
    expect(ADVISOR_INTERESTS.map(parseAdvisorInterest)).toEqual(ADVISOR_INTERESTS);
    expect(() => parseAdvisorInterest("security")).toThrowError(
      "interest must be one of: behavior, trust, design-architecture, operations, documentation",
    );
  });

  it.each(ADVISOR_INTERESTS)(
    "builds an investigation-only %s turn with the full deterministic context (#9949)",
    (interest) => {
      const turn = buildSpecialistInvestigateTurn(interest, context);
      const contextToolNames = turn.contextToolResults?.map(({ toolName }) => toolName) ?? [];

      expect(turn.name).toBe(`investigate-${interest}`);
      expect(contextToolNames).toEqual([
        "pr_review_scope_risk_context",
        "pr_review_git_diff",
        "pr_review_controlled_words",
        "pr_review_terminology_pr_context",
        "pr_review_correctness_state_context",
        "pr_review_security_trust_context",
        "pr_review_tests_regressions_context",
        "pr_review_ci_operations_context",
        "pr_review_reconciliation_context",
        "pr_review_metadata",
      ]);
      expect(turn.requiredToolNames).toEqual(contextToolNames);
      expect(turn.requireToolsBeforeText).toEqual(contextToolNames);
      expect(turn.requireAssistantText).toBe(true);
      expect(turn.atomicTerminalToolName).toBeUndefined();
      expect(turn.terminalSubmitToolName).toBeUndefined();
      expect(turn.prompt).toContain("investigation-only specialist turn");
      expect(turn.prompt).toContain("Do not emit a final result schema");
      expect(DOMAIN_TERMS[interest].every((term) => turn.prompt.includes(term))).toBe(true);
    },
  );

  it("keeps large specialist context in ordinary-read-sized Pi trace lines (#9986)", () => {
    const largeDiff = "diff --git a/file b/file\n" + "+changed\n".repeat(80_000);
    const largeWords = "word\n".repeat(20_000) + "a".repeat(16_376) + "🦀";
    const turn = buildSpecialistInvestigateTurn("behavior", {
      ...context,
      diff: largeDiff,
      controlledWords: largeWords,
    });
    const results = turn.contextToolResults ?? [];

    expect(
      results.filter(({ toolName }) => toolName.startsWith("pr_review_git_diff_part_")).length,
    ).toBeGreaterThan(1);
    expect(
      results.filter(({ toolName }) => toolName.startsWith("pr_review_controlled_words_part_"))
        .length,
    ).toBeGreaterThan(1);
    expect(
      results.every(({ content }) => Buffer.byteLength(JSON.stringify(content)) <= 16 * 1024),
    ).toBe(true);
    expect(
      results
        .filter(({ toolName }) => toolName.startsWith("pr_review_git_diff_part_"))
        .map(({ content }) => content)
        .join(""),
    ).toBe(largeDiff);
    const wordChunks = results.filter(({ toolName }) =>
      toolName.startsWith("pr_review_controlled_words_part_"),
    );
    expect(wordChunks.map(({ content }) => content).join("")).toBe(largeWords);
    expect(wordChunks.every(({ content }) => !/[\uD800-\uDBFF]$/u.test(content))).toBe(true);
    const toolNames = results.map(({ toolName }) => toolName);
    expect(turn.requiredToolNames).toEqual(toolNames);
    expect(turn.requireToolsBeforeText).toEqual(toolNames);
  });

  it("passes terminology tracing only to the documentation specialist runner (#9968)", async () => {
    const directory = fs.mkdtempSync(path.join(process.cwd(), ".tmp-specialist-runner-"));
    onTestFinished(() => fs.rmSync(directory, { recursive: true, force: true }));
    const git = (args: string[]) =>
      execFileSync("git", args, { cwd: directory, encoding: "utf8" }).trim();
    git(["init", "--quiet"]);
    git(["config", "user.name", "Specialist Test"]);
    git(["config", "user.email", "specialist@example.invalid"]);
    fs.writeFileSync(path.join(directory, "guide.md"), "# Guide\n");
    git(["add", "guide.md"]);
    git(["-c", "commit.gpgsign=false", "commit", "--quiet", "-m", "base"]);
    const baseRef = git(["rev-parse", "HEAD"]);
    fs.appendFileSync(path.join(directory, "guide.md"), "Checkout-bound terminology.\n");
    git(["add", "guide.md"]);
    git(["-c", "commit.gpgsign=false", "commit", "--quiet", "-m", "head"]);
    const headRef = git(["rev-parse", "HEAD"]);
    const captured: Array<[AdvisorInterest, ToolDefinition[]]> = [];
    const result: RunAdvisorResult = {
      text: "",
      raw: "",
      turnTexts: [],
      turnErrors: [],
      turnCallbackErrors: [],
    };
    const options: Omit<RunReadOnlyAdvisorOptions, "customTools"> = {
      cwd: directory,
      promptTurns: [],
      systemPrompt: "system",
      configDir: "/tmp/advisor-config",
      htmlExportPath: "/tmp/advisor.html",
      timeoutMs: 1,
      heartbeatMs: 1,
      maxCaptureBytes: 1,
      credentialEnv: "ADVISOR_TEST_KEY",
      logPrefix: "test",
      logProgress: vi.fn(),
    };

    await Promise.all(
      ADVISOR_INTERESTS.map((interest) =>
        runSpecialistAdvisor(interest, { baseRef, headRef }, options, async (runnerOptions) => {
          captured.push([interest, runnerOptions.customTools ?? []]);
          return result;
        }),
      ),
    );

    expect(
      Object.fromEntries(
        captured.map(([interest, tools]) => [interest, tools.map(({ name }) => name)]),
      ),
    ).toEqual({
      behavior: [],
      trust: [],
      "design-architecture": [],
      operations: [],
      documentation: [TERMINOLOGY_TRACE_TOOL],
    });
    const documentationTools =
      captured.find(([interest]) => interest === "documentation")?.[1] ?? [];
    const trace = documentationTools[0] as CallableTool;
    const evidence = await trace.execute(
      "trace-1",
      { term: "checkout-bound" },
      undefined,
      undefined,
      undefined as never,
    );
    const evidenceText = evidence.content.find((item) => item.type === "text")?.text;
    expect(evidenceText).toContain("Checkout-bound terminology.");
  });

  it.each(ADVISOR_INTERESTS)(
    "limits %s tools and reserves terminology tracing for documentation (#9949)",
    (interest) => {
      const turn = buildSpecialistInvestigateTurn(interest, context);
      const expected =
        interest === "documentation"
          ? ["read", "grep", "find", "ls", TERMINOLOGY_TRACE_TOOL]
          : ["read", "grep", "find", "ls"];

      expect(turn.activeToolNames).toEqual(expected);
      expect(turn.activeToolNames).not.toContain("record_findings");
      expect(turn.activeToolNames).not.toContain("record_review_receipt");
      expect(turn.activeToolNames).not.toContain("recommend_e2e");
      expect(turn.activeToolNames).not.toContain("submit_review");
    },
  );
});
