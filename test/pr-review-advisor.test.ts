// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import fs from "node:fs";
import path from "node:path";
import Ajv2020 from "ajv/dist/2020.js";
import { afterEach, describe, expect, it, vi } from "vitest";
import YAML from "yaml";

import { buildComment } from "../tools/pr-review-advisor/comment.mts";
import { classifyTestDepth, deriveGateStatus, normalizeReviewResult, renderSummary } from "../tools/pr-review-advisor/analyze.mts";
import { githubGraphql } from "../tools/advisors/github.mts";

const ROOT = path.resolve(import.meta.dirname, "..");
type ReviewMetadata = Parameters<typeof normalizeReviewResult>[1];

function metadata(overrides: Partial<ReviewMetadata> = {}): ReviewMetadata {
  const deterministic = {
    diffStat: "1 file changed",
    commits: ["abc123 feat: add review advisor"],
    riskyAreas: [],
    testDepth: {
      verdict: "unit_sufficient",
      rationale: "deterministic fallback",
      suggestedTests: ["run unit tests"],
    },
    gateStatus: {
      ci: { status: "unknown", evidence: "No statusCheckRollup data was available." },
      mergeability: { status: "unknown", evidence: "Merge state was unavailable." },
      reviewThreads: { status: "unknown", evidence: "No review thread state was available." },
      riskyCodeTested: { status: "pass", evidence: "No risky code areas detected by path heuristics." },
    },
    workflowSignals: [],
    monolithDeltas: [],
    github: null,
  };
  return {
    baseRef: "origin/main",
    headRef: "HEAD",
    headSha: "abc123def456",
    changedFiles: ["tools/pr-review-advisor/analyze.mts"],
    deterministic,
    ...overrides,
  } as ReviewMetadata;
}

function validResult(overrides = {}) {
  return {
    version: 1,
    baseRef: "wrong",
    headRef: "wrong",
    headSha: "wrong",
    changedFiles: [],
    summary: {
      recommendation: "merge_after_fixes",
      confidence: "high",
      oneLine: "Review found one fixable issue.",
    },
    gateStatus: {
      ci: { status: "pass", evidence: "checks passed" },
      mergeability: { status: "pass", evidence: "clean" },
      reviewThreads: { status: "pass", evidence: "none unresolved" },
      riskyCodeTested: { status: "warning", evidence: "risky workflow touched" },
    },
    findings: [
      {
        severity: "blocker",
        category: "workflow",
        file: ".github/workflows/pr-review-advisor.yaml",
        line: 42,
        title: "trusted-code boundary",
        description: "Workflow must execute trusted advisor code only.",
        recommendation: "Keep implementation checkout pinned to main.",
        evidence: "advisor scripts are invoked from ADVISOR_DIR",
      },
    ],
    acceptanceCoverage: [
      { clause: "post a sticky advisory comment", status: "met", evidence: "comment.mts uses marker" },
    ],
    securityCategories: [
      { category: "Secrets and Credentials", verdict: "pass", justification: "No secrets in diff." },
    ],
    testDepth: {
      verdict: "mocks_recommended",
      rationale: "GitHub API and filesystem paths are mocked in unit tests.",
      suggestedTests: ["comment builder test"],
    },
    e2eAdvisorStatus: {
      found: false,
      requiredJobs: [],
      passedForHeadSha: [],
      missingForHeadSha: [],
      verdict: "not_found",
    },
    positives: ["Uses a sticky marker for idempotent comments."],
    reviewCompleteness: {
      limitations: ["Automated review only."],
      requiresHumanReview: true,
    },
    ...overrides,
  };
}

describe("PR review advisor", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });
  it("normalizes advisor output into the schema-owned metadata", () => {
    const result = normalizeReviewResult(validResult(), metadata());

    expect(result.baseRef).toBe("origin/main");
    expect(result.headSha).toBe("abc123def456");
    expect(result.summary.recommendation).toBe("merge_after_fixes");
    expect(result.findings[0]?.severity).toBe("blocker");
    expect(result.reviewCompleteness.requiresHumanReview).toBe(true);
  });

  it("sanitizes malformed enum values and preserves deterministic fallback gates", () => {
    const result = normalizeReviewResult(
      {
        summary: { recommendation: "ship_it", confidence: "certain", oneLine: "bad enum" },
        gateStatus: { ci: { status: "green", evidence: "bad enum" } },
        findings: [{ severity: "critical", category: "style", title: "x" }],
        testDepth: { verdict: "integration_only" },
        e2eAdvisorStatus: { verdict: "shrug" },
        reviewCompleteness: {},
      },
      metadata(),
    );

    expect(result.summary.recommendation).toBe("info_only");
    expect(result.summary.confidence).toBe("medium");
    expect(result.gateStatus.ci.status).toBe("unknown");
    expect(result.findings[0]).toMatchObject({ severity: "suggestion", category: "correctness" });
    expect(result.testDepth.verdict).toBe("unit_sufficient");
    expect(result.e2eAdvisorStatus.verdict).toBe("not_found");
  });

  it("classifies sandbox and workflow changes as requiring deeper validation", () => {
    expect(classifyTestDepth(["nemoclaw-blueprint/policies/presets/slack.yaml"]).verdict).toBe("e2e_required");
    expect(classifyTestDepth(["src/lib/credentials.ts"]).verdict).toBe("mocks_recommended");
    expect(classifyTestDepth(["docs/get-started/quickstart.mdx"]).verdict).toBe("unit_sufficient");
  });

  it("treats mergeable-but-not-ready GitHub merge states as warnings", () => {
    for (const mergeStateStatus of ["UNSTABLE", "HAS_HOOKS", "unstable"]) {
      const gates = deriveGateStatus(
        { graphQl: { data: { repository: { pullRequest: { mergeStateStatus } } } } } as never,
        [],
        [],
      );

      expect(gates.mergeability).toMatchObject({ status: "warning", evidence: `mergeStateStatus=${mergeStateStatus}` });
    }

    const clean = deriveGateStatus(
      { graphQl: { data: { repository: { pullRequest: { mergeStateStatus: "CLEAN" } } } } } as never,
      [],
      [],
    );
    expect(clean.mergeability.status).toBe("pass");
  });

  it("surfaces GitHub GraphQL errors even when the HTTP status is successful", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValueOnce({
      ok: true,
      json: async () => ({ data: { repository: null }, errors: [{ message: "rate limit" }] }),
    } as Response);

    await expect(githubGraphql("token", "query { viewer { login } }", {})).rejects.toThrow(
      "GitHub GraphQL returned errors: rate limit",
    );
  });

  it("renders summaries and sticky comments with human-review framing", () => {
    const result = normalizeReviewResult(validResult(), metadata());
    const summary = renderSummary(result);
    const comment = buildComment({ summary, result, runUrl: "https://example.invalid/run" });

    expect(summary).toContain("# PR Review Advisor");
    expect(summary).toContain("trusted-code boundary");
    expect(comment).toContain("<!-- nemoclaw-pr-review-advisor -->");
    expect(comment).toContain("A human maintainer must make the final merge decision");
    expect(comment).toContain("abc123def456");
  });

  it("normalizes output that validates against the JSON schema", () => {
    const schema = JSON.parse(fs.readFileSync(path.join(ROOT, "tools/pr-review-advisor/schema.json"), "utf8"));
    const ajv = new Ajv2020({ strict: false });
    const validate = ajv.compile(schema);
    const result = normalizeReviewResult(validResult(), metadata());

    expect(schema["SPDX-License-Identifier"]).toBe("Apache-2.0");
    expect(validate(result)).toBe(true);
  });

  it("keeps the workflow inside the same trusted-code boundary as the E2E advisor", () => {
    const workflow = YAML.parse(
      fs.readFileSync(path.join(ROOT, ".github/workflows/pr-review-advisor.yaml"), "utf8"),
    );
    const steps = workflow.jobs.review.steps;
    const trustedCheckout = steps.find((step: { name?: string }) =>
      step.name === "Checkout trusted advisor code (main)"
    );
    const prCheckout = steps.find((step: { name?: string }) =>
      step.name === "Checkout PR workspace (read-only data)"
    );
    const installStep = steps.find((step: { name?: string }) => step.name === "Install Pi SDK");
    const analyzeStep = steps.find((step: { name?: string }) => step.name === "Run PR review advisor");

    expect(workflow.on).toHaveProperty("pull_request");
    expect(workflow.on).not.toHaveProperty("pull_request_target");
    expect(trustedCheckout).toMatchObject({
      with: { repository: "NVIDIA/NemoClaw", ref: "main", path: "advisor", "persist-credentials": false },
    });
    expect(prCheckout).toMatchObject({ with: { path: "pr-workdir", "persist-credentials": false } });
    const commentStep = steps.find((step: { name?: string }) => step.name === "Post PR review advisor comment");

    for (const step of steps.filter((step: { uses?: string }) => step.uses)) {
      expect(step.uses).toMatch(/@[0-9a-f]{40}(?:\s*#.*)?$/);
    }
    expect(installStep.run.includes("--ignore-scripts")).toBe(true);
    expect(analyzeStep.run.includes("$ADVISOR_DIR/tools/pr-review-advisor/analyze.mts")).toBe(true);
    expect(analyzeStep.run).toContain("trusted main checkout does not yet contain analyze.mts");
    expect(analyzeStep.run).toContain("pr-review-advisor-final-result.json");
    expect(commentStep.run).toContain("trusted main checkout does not yet contain comment.mts");
  });
});
