// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it, vi } from "vitest";
import reviewSchema from "../tools/pr-review-advisor/schema.json" with { type: "json" };
import {
  createReviewSubmissionController,
  RECORD_FINDINGS_TOOL,
  RECORD_REVIEW_RECEIPT_TOOL,
  RECOMMEND_E2E_TOOL,
  SECURITY_CATEGORY_NAMES,
  SUBMIT_REVIEW_TOOL,
} from "../tools/pr-review-advisor/review-submission.mts";
import type { TerminologyTrace } from "../tools/pr-review-advisor/terminology.mts";

const HEAD = "a".repeat(40);
function controller(
  traces = new Map<string, TerminologyTrace>(),
  normalizeE2e = (draft: Record<string, unknown>) => draft,
) {
  return createReviewSubmissionController({
    metadata: {
      baseRef: "origin/main",
      headRef: "HEAD",
      headSha: HEAD,
      changedFiles: ["src/example.ts"],
    },
    schema: reviewSchema,
    terminologyTraces: traces,
    normalizeE2e,
  });
}
function getTool(value: ReturnType<typeof controller>, name: string) {
  const found = value.tools.find((candidate) => candidate.name === name);
  expect(found, `Missing tool ${name}`).toBeDefined();
  return found!;
}
function execute(value: ReturnType<typeof controller>, name: string, input: unknown) {
  return getTool(value, name).execute(name, input, undefined, undefined, undefined as never);
}
function finding(title = "The refusal is hidden") {
  return {
    severity: "warning",
    category: "correctness",
    file: "src/example.ts",
    line: 7,
    title,
    description: "The changed return path reports success after a refusal.",
    impact: "Callers cannot distinguish refusal from success.",
    recommendation: "Return the refusal status.",
    verificationHint: "Assert the refusal result.",
    missingRegressionTest: "Add a refusal-path test.",
    evidence: ["src/example.ts:7 returns success"],
    basis: {
      kind: "behavior_mismatch",
      observed: "The refusal path returns success.",
      expected: "The refusal path returns refusal.",
    },
  };
}
function receipt(
  terminologyReview: unknown = {
    decisions: [],
    noChangesReason: "No changed term adds a new meaning.",
  },
) {
  return {
    summary: {
      recommendation: "merge_after_fixes",
      confidence: "high",
      oneLine: "One finding remains.",
    },
    terminologyReview,
    acceptanceCoverage: [
      { clause: "Propagate refusal", status: "missing", evidence: "src/example.ts:7" },
    ] as Array<{ clause: string; status: string; evidence: string }>,
    securityCategories: SECURITY_CATEGORY_NAMES.map((category) => ({
      category,
      verdict: "pass",
      justification: `${category} passed.`,
    })),
    sourceOfTruthReview: [] as Array<{
      surface: string;
      status: string;
      findingId: string | null;
      invalidState: string;
      sourceBoundary: string;
      whyNotSourceFix: string;
      regressionTest: string;
      removalCondition: string;
      evidence: string;
    }>,
    testDepth: {
      verdict: "unit_sufficient",
      rationale: "The behavior is deterministic.",
      suggestedTests: ["focused unit test"],
    },
    positives: ["The change keeps the interface small."],
    reviewCompleteness: { limitations: [], requiresHumanReview: true },
  };
}
function e2e() {
  return {
    coverage: {
      classifiedDomains: [],
      requiredTests: [],
      optionalTests: [],
      newE2eRecommendations: [],
      noE2eReason: "No runtime boundary changed.",
      confidence: "high",
    },
    targets: {
      relevantChangedFiles: [],
      changedCredentialFreeTests: [],
      required: [],
      optional: [],
      noTargetE2eReason: "No E2E target is needed.",
      confidence: "high",
    },
  };
}

describe("PR review advisor submission tools", () => {
  it("exposes only the four two-turn batch tools", () => {
    expect(controller().tools.map((candidate) => candidate.name)).toEqual([
      RECORD_FINDINGS_TOOL,
      RECORD_REVIEW_RECEIPT_TOOL,
      RECOMMEND_E2E_TOOL,
      SUBMIT_REVIEW_TOOL,
    ]);
  });

  it("replaces drafts, normalizes E2E, and submits canonical state atomically", async () => {
    const normalizeE2e = vi.fn((draft: Record<string, unknown>) => ({
      ...draft,
      targets: { ...(draft.targets as object), required: [], optional: [] },
    }));
    const submission = controller(new Map(), normalizeE2e);
    await execute(submission, RECORD_FINDINGS_TOOL, { findings: [finding("Discarded draft")] });
    await execute(submission, RECORD_FINDINGS_TOOL, { findings: [finding()] });
    await execute(submission, RECORD_REVIEW_RECEIPT_TOOL, receipt());
    await execute(submission, RECOMMEND_E2E_TOOL, {
      ...e2e(),
      targets: {
        ...e2e().targets,
        required: [
          {
            id: "model-invented",
            workflow: "e2e.yaml",
            selectorType: "target",
            required: true,
            reason: "Unsupported model selector.",
          },
        ],
      },
    });
    expect(submission.findingSnapshot()).toMatchObject({ revision: 0, findings: [] });
    expect(submission.terminologySnapshot()).toMatchObject({ revision: 0 });
    expect(submission.result()).toBeNull();
    const submitted = await execute(submission, SUBMIT_REVIEW_TOOL, {});
    const payload = JSON.parse((submitted.content[0] as { text: string }).text);
    expect(submitted.terminate).toBe(true);
    expect(normalizeE2e).toHaveBeenCalledOnce();
    expect(payload.result.e2e.targets.required).toEqual([]);
    expect(payload.result.summary).toMatchObject({
      recommendation: "merge_after_fixes",
      topItem: "The refusal is hidden",
    });
    expect(payload.result).toMatchObject({
      version: 1,
      headSha: HEAD,
      findings: [{ title: "The refusal is hidden", evidence: "src/example.ts:7 returns success" }],
      terminologyReview: { status: "clear", decisions: [] },
    });
    expect(payload.result.findings[0].title).not.toBe("Discarded draft");
    expect(payload.result.findings[0]).not.toHaveProperty("basis");
    expect(payload.findingLedger).toMatchObject({
      revision: 1,
      findings: [{ id: "F-001", status: "open" }],
    });
    expect(payload.terminologyLedger).toMatchObject({ revision: 1, headSha: HEAD });
  });

  it("orders the canonical top item by severity and joins evidence with newlines", async () => {
    const submission = controller();
    await execute(submission, RECORD_FINDINGS_TOOL, {
      findings: [
        { ...finding("Suggestion first"), severity: "suggestion" },
        {
          ...finding("Blocker second"),
          severity: "blocker",
          evidence: ["src/example.ts:7 returns success", "src/caller.ts:12 trusts success"],
        },
      ],
    });
    await execute(submission, RECORD_REVIEW_RECEIPT_TOOL, receipt());
    await execute(submission, RECOMMEND_E2E_TOOL, e2e());
    const submitted = await execute(submission, SUBMIT_REVIEW_TOOL, {});
    const payload = JSON.parse((submitted.content[0] as { text: string }).text);
    expect(payload.result.summary.topItem).toBe("Blocker second");
    expect(payload.result.findings[1].evidence).toBe(
      "src/example.ts:7 returns success\nsrc/caller.ts:12 trusts success",
    );
  });

  it("fails closed before every section is present without canonical mutation", async () => {
    const submission = controller();
    await execute(submission, RECORD_FINDINGS_TOOL, { findings: [finding()] });
    await expect(execute(submission, SUBMIT_REVIEW_TOOL, {})).rejects.toThrow(
      "submit_review requires: review receipt, E2E recommendations",
    );
    expect(submission.findingSnapshot()).toMatchObject({ revision: 0, findings: [] });
    expect(submission.result()).toBeNull();
  });

  it("rejects ineligible finding basis combinations without canonical mutation", async () => {
    const submission = controller();
    await execute(submission, RECORD_FINDINGS_TOOL, {
      findings: [
        {
          ...finding(),
          basis: { kind: "security_violation", observed: "Mismatch.", expected: "Match." },
        },
      ],
    });
    await execute(submission, RECORD_REVIEW_RECEIPT_TOOL, receipt());
    await execute(submission, RECOMMEND_E2E_TOOL, e2e());
    await expect(execute(submission, SUBMIT_REVIEW_TOOL, {})).rejects.toThrow(
      "No addition policy admits category=correctness with basis.kind=security_violation; admissible pairs:",
    );
    expect(submission.findingSnapshot()).toMatchObject({ revision: 0, findings: [] });
  });

  it("accepts a finding pair admitted by one canonical policy", async () => {
    const submission = controller();
    await execute(submission, RECORD_FINDINGS_TOOL, {
      findings: [
        {
          ...finding(),
          category: "architecture",
          basis: {
            kind: "unnecessary_complexity",
            observed: "The change adds a parallel dispatcher.",
            expected: "The existing dispatcher owns the behavior.",
          },
        },
      ],
    });
    await execute(submission, RECORD_REVIEW_RECEIPT_TOOL, receipt());
    await execute(submission, RECOMMEND_E2E_TOOL, e2e());
    await expect(execute(submission, SUBMIT_REVIEW_TOOL, {})).resolves.toMatchObject({
      terminate: true,
    });
  });

  it("rejects unsupported E2E selectors through the trusted normalizer without canonical mutation", async () => {
    const submission = controller(new Map(), () => {
      throw new Error("unsupported E2E selector model-invented");
    });
    await execute(submission, RECORD_FINDINGS_TOOL, { findings: [finding()] });
    await execute(submission, RECORD_REVIEW_RECEIPT_TOOL, receipt());
    await execute(submission, RECOMMEND_E2E_TOOL, e2e());
    await expect(execute(submission, SUBMIT_REVIEW_TOOL, {})).rejects.toThrow(
      "unsupported E2E selector model-invented",
    );
    expect(submission.findingSnapshot()).toMatchObject({ revision: 0, findings: [] });
  });

  it("requires all security categories and canonical source-of-truth finding IDs", async () => {
    const missingSecurity = controller();
    await execute(missingSecurity, RECORD_FINDINGS_TOOL, { findings: [finding()] });
    await execute(missingSecurity, RECORD_REVIEW_RECEIPT_TOOL, {
      ...receipt(),
      securityCategories: receipt().securityCategories.slice(1),
    });
    await execute(missingSecurity, RECOMMEND_E2E_TOOL, e2e());
    await expect(execute(missingSecurity, SUBMIT_REVIEW_TOOL, {})).rejects.toThrow(
      "securityCategories must contain each named category exactly once",
    );

    const duplicateSecurity = controller();
    await execute(duplicateSecurity, RECORD_FINDINGS_TOOL, { findings: [finding()] });
    const duplicateReceipt = receipt();
    duplicateReceipt.securityCategories.push(duplicateReceipt.securityCategories[0]);
    await execute(duplicateSecurity, RECORD_REVIEW_RECEIPT_TOOL, duplicateReceipt);
    await execute(duplicateSecurity, RECOMMEND_E2E_TOOL, e2e());
    await expect(execute(duplicateSecurity, SUBMIT_REVIEW_TOOL, {})).rejects.toThrow(
      `unsupported or duplicate: ${SECURITY_CATEGORY_NAMES[0]}`,
    );

    const badReference = controller();
    await execute(badReference, RECORD_FINDINGS_TOOL, { findings: [finding()] });
    await execute(badReference, RECORD_REVIEW_RECEIPT_TOOL, {
      ...receipt(),
      sourceOfTruthReview: [
        {
          surface: "generated state",
          status: "missing",
          findingId: "F-999",
          invalidState: "stale",
          sourceBoundary: "source",
          whyNotSourceFix: "none",
          regressionTest: "test",
          removalCondition: "fixed",
          evidence: "src/example.ts:7",
        },
      ],
    });
    await execute(badReference, RECOMMEND_E2E_TOOL, e2e());
    await expect(execute(badReference, SUBMIT_REVIEW_TOOL, {})).rejects.toThrow(
      "sourceOfTruthReview references unknown canonical finding F-999",
    );
  });

  it.each([
    [
      "acceptance",
      (value: ReturnType<typeof receipt>) => {
        value.acceptanceCoverage = [
          { clause: "Propagate refusal", status: "missing", evidence: "src/example.ts:7" },
        ];
      },
    ],
    [
      "security",
      (value: ReturnType<typeof receipt>) => {
        value.acceptanceCoverage = [];
        value.securityCategories[0].verdict = "warning";
      },
    ],
    [
      "source of truth",
      (value: ReturnType<typeof receipt>) => {
        value.acceptanceCoverage = [];
        value.sourceOfTruthReview = [
          {
            surface: "config",
            status: "missing",
            findingId: null,
            invalidState: "stale",
            sourceBoundary: "config",
            whyNotSourceFix: "none",
            regressionTest: "test",
            removalCondition: "fixed",
            evidence: "src/example.ts:7",
          },
        ];
      },
    ],
  ])("rejects a %s concern without a canonical finding", async (_name, mutate) => {
    const submission = controller();
    const draft = receipt();
    draft.acceptanceCoverage = [];
    mutate(draft);
    await execute(submission, RECORD_FINDINGS_TOOL, { findings: [] });
    await execute(submission, RECORD_REVIEW_RECEIPT_TOOL, draft);
    await execute(submission, RECOMMEND_E2E_TOOL, e2e());
    await expect(execute(submission, SUBMIT_REVIEW_TOOL, {})).rejects.toThrow(
      "without a canonical finding",
    );
    expect(submission.result()).toBeNull();
  });

  it("resolves terminology traces lazily at submission time", async () => {
    const traces = new Map<string, TerminologyTrace>();
    const submission = createReviewSubmissionController({
      metadata: {
        baseRef: "origin/main",
        headRef: "HEAD",
        headSha: HEAD,
        changedFiles: ["src/example.ts"],
      },
      schema: reviewSchema,
      terminologyTraces: () => traces,
      normalizeE2e: (draft) => draft,
    });
    const trace: TerminologyTrace = {
      id: "lazy-trace",
      term: "review receipt",
      variants: ["review receipt"],
      baseSha: "b".repeat(40),
      headSha: HEAD,
      baseOccurrences: 0,
      headOccurrences: 1,
      baseEvidenceTruncated: false,
      headEvidenceTruncated: false,
      changedLocations: [{ file: "src/example.ts", line: 9, text: "review receipt" }],
      baseSamples: [],
      headSamples: [],
      firstCommitSha: HEAD,
    };
    traces.set(trace.id, trace);
    await execute(submission, RECORD_FINDINGS_TOOL, { findings: [finding()] });
    await execute(
      submission,
      RECORD_REVIEW_RECEIPT_TOOL,
      receipt({
        decisions: [
          {
            term: trace.term,
            change: "introduced",
            disposition: "justified",
            meaning: "The complete structured review sections.",
            contrast: "Unlike drafts, this is complete.",
            existingTerm: null,
            semanticImpact: "evidence",
            recommendation: "Keep the contrast explicit.",
            traceId: trace.id,
            source: { file: "src/example.ts", line: 9 },
          },
        ],
        noChangesReason: null,
      }),
    );
    await execute(submission, RECOMMEND_E2E_TOOL, e2e());
    await expect(execute(submission, SUBMIT_REVIEW_TOOL, {})).resolves.toMatchObject({
      terminate: true,
    });
  });

  it("preserves traced terminology provenance in the canonical result", async () => {
    const trace: TerminologyTrace = {
      id: "term-trace",
      term: "review receipt",
      variants: ["review receipt"],
      baseSha: "b".repeat(40),
      headSha: HEAD,
      baseOccurrences: 0,
      headOccurrences: 1,
      baseEvidenceTruncated: false,
      headEvidenceTruncated: false,
      changedLocations: [{ file: "src/example.ts", line: 9, text: "review receipt" }],
      baseSamples: [],
      headSamples: [],
      firstCommitSha: HEAD,
    };
    const submission = controller(new Map([[trace.id, trace]]));
    await execute(submission, RECORD_FINDINGS_TOOL, { findings: [finding()] });
    await execute(
      submission,
      RECORD_REVIEW_RECEIPT_TOOL,
      receipt({
        decisions: [
          {
            term: "review receipt",
            change: "introduced",
            disposition: "justified",
            meaning: "The complete structured review sections.",
            contrast: "Unlike drafts, this is complete.",
            existingTerm: null,
            semanticImpact: "evidence",
            recommendation: "Keep the contrast explicit.",
            traceId: trace.id,
            source: { file: "src/example.ts", line: 9 },
          },
        ],
        noChangesReason: null,
      }),
    );
    await execute(submission, RECOMMEND_E2E_TOOL, e2e());
    const submitted = await execute(submission, SUBMIT_REVIEW_TOOL, {});
    const payload = JSON.parse((submitted.content[0] as { text: string }).text);
    expect(payload.result.terminologyReview.decisions[0]).toMatchObject({
      id: "T-001",
      traceId: trace.id,
      source: { file: "src/example.ts", line: 9, headSha: HEAD },
    });
  });
});
