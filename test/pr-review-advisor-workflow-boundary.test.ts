// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import YAML from "yaml";
import {
  fetchLivePullFromGh,
  validateAdvisorArtifacts,
} from "../tools/pr-review-advisor/validate-artifacts.mts";
import { validatePrReviewAdvisorWorkflowBoundary } from "../tools/pr-review-advisor/workflow-boundary.mts";

const ROOT = path.resolve(import.meta.dirname, "..");
const WORKFLOW_PATH = path.join(ROOT, ".github/workflows/pr-review-advisor.yaml");
const HEAD_SHA = "b".repeat(40);
const BASE_SHA = "a".repeat(40);

function workflow(): Record<string, any> {
  return YAML.parse(fs.readFileSync(WORKFLOW_PATH, "utf8")) as Record<string, any>;
}

function validateMutation(mutate: (value: Record<string, any>) => void): string[] {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "advisor-workflow-"));
  const file = path.join(directory, "workflow.yaml");
  const value = workflow();
  mutate(value);
  fs.writeFileSync(file, YAML.stringify(value));
  try {
    return validatePrReviewAdvisorWorkflowBoundary(file);
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
}

function validResult(): Record<string, unknown> {
  return {
    version: 1,
    baseRef: "target/base",
    headRef: "HEAD",
    headSha: HEAD_SHA,
    changedFiles: [],
    summary: { recommendation: "info_only", confidence: "high", oneLine: "No findings." },
    findings: [],
    terminologyReview: {
      status: "clear",
      decisions: [],
      noChangesReason: "No terminology changes.",
    },
    acceptanceCoverage: [],
    securityCategories: [],
    sourceOfTruthReview: [],
    e2e: {
      coverage: {
        classifiedDomains: [],
        requiredTests: [],
        optionalTests: [],
        newE2eRecommendations: [],
        noE2eReason: "No E2E coverage is needed.",
        confidence: "high",
      },
      targets: {
        relevantChangedFiles: [],
        changedCredentialFreeTests: [],
        required: [],
        optional: [],
        noTargetE2eReason: "No target E2E coverage is needed.",
        confidence: "high",
      },
    },
    testDepth: {
      verdict: "unit_sufficient",
      rationale: "The boundary test covers this fixture.",
      suggestedTests: [],
    },
    positives: [],
    reviewCompleteness: { limitations: [], requiresHumanReview: true },
  };
}

function withArtifacts(run: (directory: string, result: Record<string, unknown>) => void): void {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "advisor-artifacts-"));
  const result = validResult();
  fs.writeFileSync(path.join(directory, "pr-review-advisor-result.json"), JSON.stringify(result));
  fs.writeFileSync(
    path.join(directory, "pr-review-advisor-final-result.json"),
    JSON.stringify(result),
  );
  fs.writeFileSync(path.join(directory, "pr-review-advisor-summary.md"), "# Review\n");
  try {
    run(directory, result);
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
}

function validateArtifacts(directory: string): void {
  validateAdvisorArtifacts(
    {
      repository: "NVIDIA/NemoClaw",
      prNumber: "6736",
      expectedHeadSha: HEAD_SHA,
      expectedBaseSha: BASE_SHA,
      trustedWorkflowSha: "c".repeat(40),
      primaryArtifactDir: directory,
      maxResultBytes: 2_097_152,
      maxSummaryBytes: 1_048_576,
    },
    { fetchLivePull: () => ({ headSha: HEAD_SHA, baseSha: BASE_SHA }) },
  );
}

describe("PR review advisor workflow boundary", () => {
  it("accepts the five-specialist synthesis workflow", () => {
    expect(validatePrReviewAdvisorWorkflowBoundary()).toEqual([]);
  });

  it("keeps model jobs read-only and the publisher separate", () => {
    const errors = validateMutation((value) => {
      value.jobs["review-specialists"].permissions["pull-requests"] = "write";
      value.jobs.review.permissions["pull-requests"] = "write";
      value.jobs.publish.env.PR_REVIEW_ADVISOR_API_KEY = "secret";
      value.jobs.publish.env.ADVISOR_WORKDIR = "/tmp/pr";
    });
    expect(errors).toEqual(
      expect.arrayContaining([
        "review-specialists job permissions.pull-requests must be read",
        "review job permissions.pull-requests must be read",
        "publish job must not receive the advisor model credential",
        "publish job must not receive the untrusted analysis worktree",
      ]),
    );
  });

  it("requires discovered specialists before synthesis and publication", () => {
    const errors = validateMutation((value) => {
      value.jobs["review-specialists"].strategy.matrix.advisor = [];
      value.jobs["review-specialists"].needs = "publish";
      value.jobs["review-specialists"]["continue-on-error"] = true;
      value.jobs.review.needs = "publish";
      value.jobs.publish.needs = "review-specialists";
    });
    expect(errors).toEqual(
      expect.arrayContaining([
        "specialist matrix must use the discovered specialist prompts",
        "specialist matrix must depend on prompt discovery",
        "specialist failures must block synthesis",
        "review synthesis must depend on the specialist matrix",
        "publisher must depend on review synthesis",
      ]),
    );
  });

  it("keeps trusted code and same-run artifacts", () => {
    const errors = validateMutation((value) => {
      const checkout = value.jobs.review.steps.find(
        (step: Record<string, any>) =>
          step.name === "Checkout trusted advisor code (workflow revision)",
      );
      checkout.with.ref = "main";
      const download = value.jobs.publish.steps.find(
        (step: Record<string, any>) => step.name === "Download primary advisor artifact",
      );
      download.uses = "actions/download-artifact@v8";
      download.with["run-id"] = "other-run";
    });
    expect(errors.some((error) => error.includes("with.ref"))).toBe(true);
    expect(errors.some((error) => error.includes("full commit SHA"))).toBe(true);
    expect(errors).toContain("Download primary advisor artifact must not set with.run-id");
  });

  it("validates one synthesis result against live PR identity", () => {
    withArtifacts((directory) => expect(() => validateArtifacts(directory)).not.toThrow());
  });

  it("rejects stale synthesis results", () => {
    withArtifacts((directory, result) => {
      fs.writeFileSync(
        path.join(directory, "pr-review-advisor-final-result.json"),
        JSON.stringify({ ...result, headSha: "d".repeat(40) }),
      );
      expect(() => validateArtifacts(directory)).toThrow();
    });
  });

  it("reads live head and base in one GitHub request", () => {
    const calls: string[][] = [];
    const live = fetchLivePullFromGh("NVIDIA/NemoClaw", "6736", (_command, args) => {
      calls.push(args);
      return JSON.stringify({ head: { sha: HEAD_SHA }, base: { sha: BASE_SHA } });
    });
    expect(live).toEqual({ headSha: HEAD_SHA, baseSha: BASE_SHA });
    expect(calls).toEqual([["api", "repos/NVIDIA/NemoClaw/pulls/6736"]]);
  });

  it("reports unreadable workflows", () => {
    expect(validatePrReviewAdvisorWorkflowBoundary("/missing/workflow.yaml")).toEqual([
      "failed to read or parse workflow: /missing/workflow.yaml",
    ]);
  });
});
