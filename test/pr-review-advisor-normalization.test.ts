// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { afterEach, describe, expect, it, vi } from "vitest";
import { buildRiskPlan } from "../tools/advisors/risk-plan.mts";
import {
  ADVISOR_OPENAI_COMPATIBLE_BASE_URL,
  DEFAULT_ADVISOR_MODEL,
  DEFAULT_ADVISOR_PROVIDER,
  NEMOTRON_ULTRA_ADVISOR_MODEL,
  openAiAdvisorProviderConfig,
} from "../tools/advisors/session.mts";
import { normalizeReviewResult, renderSummary } from "../tools/pr-review-advisor/analyze.mts";
import { buildComment } from "../tools/pr-review-advisor/comment.mts";
import { metadata, validResult } from "./helpers/pr-review-advisor-test-fixtures.ts";
import { testTimeoutOptions } from "./helpers/timeouts";

describe("PR review advisor", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("configures the advisor through the hosted OpenAI-compatible service", () => {
    const config = openAiAdvisorProviderConfig("PR_REVIEW_ADVISOR_API_KEY") as {
      apiKey: string;
      baseUrl: string;
      models: Array<{
        id: string;
        compat?: Record<string, unknown>;
        reasoning: boolean;
      }>;
    };

    expect(DEFAULT_ADVISOR_PROVIDER).toBe("openai");
    expect(DEFAULT_ADVISOR_MODEL).toBe("azure/openai/gpt-5.6-terra");
    expect(NEMOTRON_ULTRA_ADVISOR_MODEL).toBe("nvidia/nvidia/nemotron-3-ultra");
    expect(config.apiKey).toBe("PR_REVIEW_ADVISOR_API_KEY");
    expect(config.baseUrl).toBe(ADVISOR_OPENAI_COMPATIBLE_BASE_URL);
    const defaultModel = config.models.find((model) => model.id === DEFAULT_ADVISOR_MODEL);
    const nemotronModel = config.models.find((model) => model.id === NEMOTRON_ULTRA_ADVISOR_MODEL);
    expect(defaultModel?.reasoning).toBe(false);
    expect(defaultModel?.compat).toMatchObject({
      supportsDeveloperRole: false,
      supportsReasoningEffort: false,
      supportsStore: false,
      supportsStrictMode: false,
      supportsUsageInStreaming: false,
      maxTokensField: "max_tokens",
    });
    expect(nemotronModel?.reasoning).toBe(false);
    expect(nemotronModel?.compat).toMatchObject(defaultModel?.compat || {});
  });

  it("normalizes advisor output into the schema-owned metadata", () => {
    const result = normalizeReviewResult(
      validResult({ reviewCompleteness: { limitations: [], requiresHumanReview: false } }),
      metadata(),
    );

    expect(result.baseRef).toBe("origin/main");
    expect(result.headSha).toBe("abc123def456");
    expect(result.summary.recommendation).toBe("merge_after_fixes");
    expect(result.findings[0]?.severity).toBe("blocker");
    expect(result.reviewCompleteness.requiresHumanReview).toBe(true);
  });

  it("normalizes combined E2E guidance with deterministic floors and canonical selectors", () => {
    const changedFiles = ["src/lib/actions/upgrade-sandboxes.ts"];
    const reviewMetadata = metadata({ changedFiles });
    reviewMetadata.deterministic.riskPlan = buildRiskPlan({
      headSha: reviewMetadata.headSha,
      changedFiles,
    });
    const result = normalizeReviewResult(
      validResult({
        e2e: {
          coverage: {
            requiredTests: [],
            optionalTests: [
              {
                id: "rebuild-openclaw",
                reason: "The model tried to downgrade the deterministic job.",
              },
            ],
            confidence: "low",
          },
          targets: {
            required: [
              {
                id: "unknown;rm-rf",
                workflow: "e2e.yaml",
                selectorType: "target",
                reason: "Untrusted invented selector.",
              },
            ],
            optional: [
              {
                id: "rebuild-openclaw",
                workflow: "e2e.yaml",
                selectorType: "job",
                reason: "The model tried to downgrade the deterministic job.",
              },
            ],
            confidence: "low",
          },
        },
      }),
      reviewMetadata,
    );

    expect(result.e2e.coverage.requiredTests.map((test) => test.id)).toEqual([
      "rebuild-openclaw",
      "state-backup-restore",
    ]);
    expect(result.e2e.coverage.optionalTests).toEqual([]);
    expect(result.e2e.targets.required.map((target) => target.id)).toEqual([
      "rebuild-openclaw",
      "state-backup-restore",
    ]);
    expect(result.e2e.targets.optional).toEqual([]);
    expect(result.e2e.targets.required[1]).not.toHaveProperty("dispatchCommand");
    expect(JSON.stringify(result.e2e)).not.toContain("rm -rf");
    expect(result.e2e.coverage.confidence).toBe("medium");
    expect(result.e2e.targets.confidence).toBe("medium");

    const comment = buildComment({ summary: renderSummary(result), result });
    expect(comment).toContain("### E2E guidance");
    expect(comment).toContain(
      "Advisory only. A maintainer can dispatch the default E2E suite for the commit under review.",
    );
    expect(comment).toContain("<code>rebuild-openclaw</code>");
    expect(comment).toContain("**Recommended E2E:**");
    expect(comment.match(/<code>rebuild-openclaw<\/code>/gu)).toHaveLength(1);
    expect(comment).not.toContain("Recommended coverage");
    expect(comment).not.toContain("Recommended selectors");
    expect(comment).not.toContain("rm -rf");
  });

  it("reconciles trusted E2E coverage and selector tiers before publication", () => {
    const normalize = (required: Array<Record<string, string>> = []) =>
      normalizeReviewResult(
        validResult({
          e2e: {
            coverage: {
              requiredTests: [],
              optionalTests: [{ id: "vllm-docker-storage", reason: "Documentation changed." }],
              confidence: "low",
            },
            targets: { required, optional: [], confidence: "low" },
          },
        }),
        metadata({ changedFiles: [] }),
      ).e2e;
    const optional = normalize();
    expect(optional.coverage.optionalTests.map(({ id }) => id)).toEqual(["vllm-docker-storage"]);
    expect(optional.targets.optional).toEqual([
      expect.objectContaining({ id: "vllm-docker-storage", selectorType: "job", required: false }),
    ]);
    const required = normalize([
      {
        id: "vllm-docker-storage",
        workflow: "e2e.yaml",
        selectorType: "job",
        reason: "The live documentation check is required.",
      },
    ]);
    expect(required.coverage.requiredTests.map(({ id }) => id)).toEqual(["vllm-docker-storage"]);
    expect(required.targets.required).toEqual([
      expect.objectContaining({ id: "vllm-docker-storage", selectorType: "job", required: true }),
    ]);
    expect([required.coverage.optionalTests, required.targets.optional]).toEqual([[], []]);
  });

  it("renders each E2E recommendation once", testTimeoutOptions(30_000), () => {
    const result = normalizeReviewResult(
      validResult({
        e2e: {
          coverage: {
            classifiedDomains: [],
            requiredTests: [
              {
                id: "inference-routing",
                reason: "The controller can run this job for the commit under review.",
              },
              {
                id: "security-posture",
                reason: "This job must run from reviewed code on main.",
              },
            ],
            optionalTests: [],
            newE2eRecommendations: [],
            noE2eReason: null,
            confidence: "high",
          },
          targets: {
            relevantChangedFiles: [],
            required: [],
            optional: [],
            noTargetE2eReason: "No live dispatch is required.",
            confidence: "high",
          },
        },
      }),
      metadata({ changedFiles: [] }),
    );

    const comment = buildComment({ summary: renderSummary(result), result });
    expect(comment).toContain("**Recommended E2E:** <code>inference-routing</code>");
    expect(comment).toContain("**Manual-only E2E:** <code>security-posture</code>");
    expect(comment.match(/<code>inference-routing<\/code>/gu)).toHaveLength(1);
    expect(comment.match(/<code>security-posture<\/code>/gu)).toHaveLength(1);

    const noE2eResult = normalizeReviewResult(validResult(), metadata());
    const noE2eComment = buildComment({
      summary: renderSummary(noE2eResult),
      result: noE2eResult,
    });
    expect(noE2eComment).toContain("**Recommended E2E:** _None_");
    expect(noE2eComment).not.toContain("Why no");
  });

  it("separates E2E for the commit under review from secret-backed manual-only coverage", () => {
    const result = {
      headSha: "abc123def456",
      e2e: {
        coverage: {
          requiredTests: [
            {
              id: "inference-routing",
              reason: "Credential-free coverage for the commit under review.",
            },
            { id: "network-policy", reason: "Secret-backed trusted-main coverage." },
          ],
          optionalTests: [],
        },
        targets: { required: [], optional: [] },
      },
    };
    const comment = buildComment({ summary: "Trusted E2E classification.", result });
    expect(comment).toContain("**Recommended E2E:** <code>inference-routing</code>");
    expect(comment).toContain("**Manual-only E2E:** <code>network-policy</code>");
    const recommendedLine = comment
      .split("\n")
      .find((line) => line.startsWith("**Recommended E2E:**"));
    expect(recommendedLine).not.toContain("<code>network-policy</code>");
    expect(comment).toContain(
      "The manual PR workflow does not run these selectors for the commit under review.",
    );
  });

  it("sanitizes malformed enum values and preserves deterministic fallback gates", () => {
    const result = normalizeReviewResult(
      {
        summary: { recommendation: "ship_it", confidence: "certain", oneLine: "bad enum" },
        findings: [{ severity: "critical", category: "style", title: "x" }],
        testDepth: { verdict: "integration_only" },
        reviewCompleteness: {},
      },
      metadata(),
    );

    expect(result.summary.recommendation).toBe("info_only");
    expect(result.summary.confidence).toBe("medium");
    expect(result.findings[0]).toMatchObject({ severity: "suggestion", category: "correctness" });
    expect(result.testDepth.verdict).toBe("unit_sufficient");
  });
});
