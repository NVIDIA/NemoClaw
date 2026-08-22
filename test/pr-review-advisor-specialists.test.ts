// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import fs from "node:fs";

import ts from "typescript";
import { describe, expect, it } from "vitest";

import { TERMINOLOGY_TRACE_TOOL } from "../tools/pr-review-advisor/terminology.mts";
import { documentationSpecialistTools } from "../tools/pr-review-advisor/run-specialist.mts";
import {
  ADVISOR_INTERESTS,
  buildSpecialistInvestigateTurn,
  parseAdvisorInterest,
  type AdvisorInterest,
} from "../tools/pr-review-advisor/specialists.mts";
import type { InvestigateTurnContext } from "../tools/pr-review-advisor/investigate-turn.mts";

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

  it("passes terminology tracing through the production documentation specialist boundary (#9968)", () => {
    const options = { baseRef: "origin/main", headRef: "HEAD" };
    expect(
      ADVISOR_INTERESTS.map((interest) => [
        interest,
        documentationSpecialistTools(interest, options).map(({ name }) => name),
      ]),
    ).toEqual([
      ["behavior", []],
      ["trust", []],
      ["design-architecture", []],
      ["operations", []],
      ["documentation", [TERMINOLOGY_TRACE_TOOL]],
    ]);

    const source = ts.createSourceFile(
      "run-specialist.mts",
      fs.readFileSync(
        new URL("../tools/pr-review-advisor/run-specialist.mts", import.meta.url),
        "utf8",
      ),
      ts.ScriptTarget.Latest,
      true,
      ts.ScriptKind.TS,
    );
    const advisorCalls: ts.CallExpression[] = [];
    const visit = (node: ts.Node): void => {
      advisorCalls.push(
        ...(ts.isCallExpression(node) &&
        ts.isIdentifier(node.expression) &&
        node.expression.text === "runReadOnlyAdvisor"
          ? [node]
          : []),
      );
      ts.forEachChild(node, visit);
    };
    visit(source);

    expect(advisorCalls).toHaveLength(1);
    const optionsArgument = advisorCalls[0]?.arguments[0];
    expect(optionsArgument && ts.isObjectLiteralExpression(optionsArgument)).toBe(true);
    const optionsObject = optionsArgument as ts.ObjectLiteralExpression;
    const customTools = optionsObject.properties.find(
      (property): property is ts.PropertyAssignment =>
        ts.isPropertyAssignment(property) &&
        ts.isIdentifier(property.name) &&
        property.name.text === "customTools",
    );
    expect(customTools).toBeDefined();
    expect(customTools?.initializer.getText(source)).toBe(
      "documentationSpecialistTools(interest, { baseRef, headRef })",
    );
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
