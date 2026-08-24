// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import reviewSchema from "../tools/pr-review-advisor/schema.json" with { type: "json" };
import {
  applyReviewSubmissionTurn,
  persistSuccessfulReview,
} from "../tools/pr-review-advisor/analyze.mts";
import type { ArtifactPaths } from "../tools/pr-review-advisor/artifacts.mts";
import {
  ACCEPTANCE_FINDING_REFERENCE_PAIRS,
  createReviewSubmissionController,
  RECORD_FINDINGS_TOOL,
  RECORD_REVIEW_RECEIPT_TOOL,
  RECOMMEND_E2E_TOOL,
  SUBMIT_REVIEW_TOOL,
  type ReviewSubmissionController,
} from "../tools/pr-review-advisor/review-submission.mts";
import type { TerminologyTrace } from "../tools/pr-review-advisor/terminology.mts";
import { readParsedTrustedSecurityRubric } from "../tools/pr-review-advisor/trusted-guidance.mts";

const ROOT = path.resolve(import.meta.dirname, "..");
const HEAD = "a".repeat(40);
const SECURITY_CATEGORY_NAMES = readParsedTrustedSecurityRubric().categories;
function controller(
  traces = new Map<string, TerminologyTrace>(),
  normalizeE2e = (draft: Record<string, unknown>) => draft,
  securityCategoryNames: readonly string[] = SECURITY_CATEGORY_NAMES,
  hasOpenPrReplacement = false,
) {
  return createReviewSubmissionController({
    metadata: {
      baseRef: "origin/main",
      headRef: "HEAD",
      headSha: HEAD,
      changedFiles: ["tools/pr-review-advisor/review-submission.mts"],
      deterministic: {
        testDepth: {
          verdict: "runtime_validation_recommended",
          rationale: "A runtime boundary changed.",
          suggestedTests: ["deterministic runtime test"],
        },
        hasOpenPrReplacement,
      },
    },
    schema: reviewSchema,
    repositoryRoot: ROOT,
    securityCategoryNames,
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
    file: "tools/pr-review-advisor/review-submission.mts",
    line: 7,
    title,
    description: "The changed return path reports success after a refusal.",
    impact: "Callers cannot distinguish refusal from success.",
    recommendation: "Return the refusal status.",
    verificationHint: "Assert the refusal result.",
    missingRegressionTest: "Add a refusal-path test.",
    evidence: ["tools/pr-review-advisor/review-submission.mts:7 returns success"],
    receiptConcerns: [
      "acceptance:Propagate refusal",
      "acceptance:Cover refusal regression",
      "acceptance:Clause",
      `security:${SECURITY_CATEGORY_NAMES[0]}`,
      "source-of-truth:config",
    ],
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
      recommendation: "merge_as_is",
      confidence: "high",
      oneLine: "One finding remains.",
    },
    terminologyReview,
    acceptanceCoverage: [
      {
        clause: "Propagate refusal",
        status: "met",
        evidence: "tools/pr-review-advisor/review-submission.mts:7",
        findingId: null,
      },
    ] as Array<{ clause: string; status: string; evidence: string; findingId: string | null }>,
    securityCategories: SECURITY_CATEGORY_NAMES.map((category) => ({
      category,
      verdict: "pass",
      justification: `${category} passed.`,
      findingId: null as string | null,
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
function terminologyDecision(traceId: string) {
  return {
    term: "review receipt",
    change: "introduced",
    disposition: "justified",
    meaning: "The complete structured review sections.",
    contrast: "Unlike drafts, this is complete.",
    existingTerm: null,
    semanticImpact: "evidence",
    recommendation: "Keep the contrast explicit.",
    traceId,
    source: { file: "tools/pr-review-advisor/review-submission.mts", line: 9 },
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

const ARTIFACTS: ArtifactPaths = {
  result: "result.json",
  finalResult: "final-result.json",
  summary: "summary.md",
  sessionHtml: "session.html",
};

function completedSubmission(result: unknown): ReviewSubmissionController {
  return {
    tools: [],
    result: () => result,
    findingSnapshot: () => ({ version: 1, findings: [] }),
    terminologySnapshot: () => ({
      version: 1,
      revision: 1,
      headSha: HEAD,
      review: { status: "clear", decisions: [], noChangesReason: "No terminology changes." },
    }),
    finalize: vi.fn(),
    discard: vi.fn(),
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

  it.each(["needs_rework", "blocked"])(
    "rejects unsupported model-authored summary recommendation %s",
    async (recommendation) => {
      const submission = controller();
      await execute(submission, RECORD_FINDINGS_TOOL, { findings: [] });
      const draft = receipt() as Record<string, any>;
      draft.summary = { ...draft.summary, recommendation };
      await expect(execute(submission, RECORD_REVIEW_RECEIPT_TOOL, draft)).rejects.toThrow(
        "record_review_receipt failed schema validation",
      );
    },
  );

  it.each([
    { findings: [finding()], confidence: "high", expected: "merge_after_fixes" },
    { findings: [], confidence: "low", expected: "info_only" },
    { findings: [], confidence: "medium", expected: "merge_as_is" },
    { findings: [], confidence: "high", expected: "merge_as_is" },
  ])("derives canonical recommendation $expected", async ({ findings, confidence, expected }) => {
    const submission = controller();
    await execute(submission, RECORD_FINDINGS_TOOL, { findings });
    const draft = receipt() as Record<string, any>;
    draft.summary = { ...draft.summary, confidence };
    await execute(submission, RECORD_REVIEW_RECEIPT_TOOL, draft);
    await execute(submission, RECOMMEND_E2E_TOOL, e2e());
    await execute(submission, SUBMIT_REVIEW_TOOL, {});
    submission.finalize();
    expect((submission.result() as Record<string, any>).summary.recommendation).toBe(expected);
  });

  it("preserves superseded with deterministic open-PR overlap and no findings", async () => {
    const submission = controller(
      new Map(),
      (draft: Record<string, unknown>) => draft,
      SECURITY_CATEGORY_NAMES,
      true,
    );
    await execute(submission, RECORD_FINDINGS_TOOL, { findings: [] });
    const draft = receipt() as Record<string, any>;
    draft.summary.recommendation = "superseded";
    await execute(submission, RECORD_REVIEW_RECEIPT_TOOL, draft);
    await execute(submission, RECOMMEND_E2E_TOOL, e2e());
    await execute(submission, SUBMIT_REVIEW_TOOL, {});
    submission.finalize();
    expect((submission.result() as Record<string, any>).summary.recommendation).toBe("superseded");
  });

  it("rejects superseded without deterministic open-PR overlap atomically", async () => {
    const submission = controller();
    await execute(submission, RECORD_FINDINGS_TOOL, { findings: [] });
    const draft = receipt() as Record<string, any>;
    draft.summary.recommendation = "superseded";
    await execute(submission, RECORD_REVIEW_RECEIPT_TOOL, draft);
    await execute(submission, RECOMMEND_E2E_TOOL, e2e());
    await expect(execute(submission, SUBMIT_REVIEW_TOOL, {})).rejects.toThrow(
      "without deterministic open-PR overlap evidence",
    );
    expect(submission.result()).toBeNull();
    expect(submission.findingSnapshot()).toEqual({ version: 1, findings: [] });
    expect(submission.terminologySnapshot().revision).toBe(0);
  });

  it("overrides superseded when open findings require fixes", async () => {
    const submission = controller();
    await execute(submission, RECORD_FINDINGS_TOOL, { findings: [finding()] });
    const draft = receipt() as Record<string, any>;
    draft.summary.recommendation = "superseded";
    await execute(submission, RECORD_REVIEW_RECEIPT_TOOL, draft);
    await execute(submission, RECOMMEND_E2E_TOOL, e2e());
    await execute(submission, SUBMIT_REVIEW_TOOL, {});
    submission.finalize();
    expect((submission.result() as Record<string, any>).summary.recommendation).toBe(
      "merge_after_fixes",
    );
  });

  it("requires findings before recording a review receipt", async () => {
    const submission = controller();
    await expect(execute(submission, RECORD_REVIEW_RECEIPT_TOOL, receipt())).rejects.toThrow(
      "record_review_receipt requires record_findings first",
    );
  });

  it("invalidates a receipt after findings replacement until rerecorded", async () => {
    const submission = controller();
    const first = await execute(submission, RECORD_FINDINGS_TOOL, { findings: [finding("First")] });
    expect(JSON.parse((first.content[0] as { text: string }).text)).toMatchObject({
      findingsRevision: 1,
      findings: [{ id: "F-001", title: "First" }],
    });
    await execute(submission, RECORD_REVIEW_RECEIPT_TOOL, receipt());
    await execute(submission, RECOMMEND_E2E_TOOL, e2e());

    const second = await execute(submission, RECORD_FINDINGS_TOOL, {
      findings: [finding("Replacement")],
    });
    expect(JSON.parse((second.content[0] as { text: string }).text)).toMatchObject({
      findingsRevision: 2,
      findings: [{ id: "F-001", title: "Replacement" }],
    });
    await expect(execute(submission, SUBMIT_REVIEW_TOOL, {})).rejects.toThrow(
      "review receipt (missing or stale for current findings revision)",
    );

    await execute(submission, RECORD_REVIEW_RECEIPT_TOOL, receipt());
    await expect(execute(submission, SUBMIT_REVIEW_TOOL, {})).resolves.toMatchObject({
      terminate: true,
    });
  });

  it("invalidates positional receipt links when compatible findings are reordered", async () => {
    const submission = controller();
    const first = finding("First");
    const second = { ...finding("Second"), line: 8 };
    await execute(submission, RECORD_FINDINGS_TOOL, { findings: [first, second] });
    await execute(submission, RECORD_REVIEW_RECEIPT_TOOL, receipt());
    await execute(submission, RECOMMEND_E2E_TOOL, e2e());
    await execute(submission, RECORD_FINDINGS_TOOL, { findings: [second, first] });

    await expect(execute(submission, SUBMIT_REVIEW_TOOL, {})).rejects.toThrow(
      "review receipt (missing or stale for current findings revision)",
    );
  });

  it("returns ordered draft IDs for the model to link in its subsequent receipt", async () => {
    const submission = controller();
    const findingsResponse = await execute(submission, RECORD_FINDINGS_TOOL, {
      findings: [
        {
          ...finding("Acceptance behavior is missing"),
          severity: "blocker",
          category: "correctness",
          basis: { ...finding().basis, kind: "behavior_mismatch" },
        },
        {
          ...finding("Regression coverage is missing"),
          category: "tests",
          basis: { ...finding().basis, kind: "missing_regression" },
        },
      ],
    });
    const returned = JSON.parse((findingsResponse.content[0] as { text: string }).text) as {
      findingsRevision: number;
      findings: Array<{ id: string; title: string; category: string; basisKind: string }>;
    };
    expect(returned.findingsRevision).toBe(1);
    const returnedFindings = returned.findings;
    expect(returnedFindings).toEqual([
      {
        id: "F-001",
        title: "Acceptance behavior is missing",
        category: "correctness",
        basisKind: "behavior_mismatch",
      },
      {
        id: "F-002",
        title: "Regression coverage is missing",
        category: "tests",
        basisKind: "missing_regression",
      },
    ]);

    const draft = receipt();
    draft.acceptanceCoverage = [
      {
        clause: "Propagate refusal",
        status: "partial",
        evidence: "tools/pr-review-advisor/review-submission.mts:7",
        findingId: returnedFindings[0]!.id,
      },
      {
        clause: "Cover refusal regression",
        status: "partial",
        evidence: "tools/pr-review-advisor/review-submission.mts:7",
        findingId: returnedFindings[1]!.id,
      },
    ];
    await execute(submission, RECORD_REVIEW_RECEIPT_TOOL, draft);
    await execute(submission, RECOMMEND_E2E_TOOL, e2e());
    await expect(execute(submission, SUBMIT_REVIEW_TOOL, {})).resolves.toMatchObject({
      terminate: true,
    });
  });

  it("discards pending canonical state after a rejected terminal flow", async () => {
    const submission = controller();
    await execute(submission, RECORD_FINDINGS_TOOL, { findings: [finding()] });
    await execute(submission, RECORD_REVIEW_RECEIPT_TOOL, receipt());
    await execute(submission, RECOMMEND_E2E_TOOL, e2e());
    const response = await execute(submission, SUBMIT_REVIEW_TOOL, {});
    const responseText = (response.content[0] as { text: string }).text;
    expect(JSON.parse(responseText)).toEqual({ validated: true, pending: true });
    expect(responseText).not.toContain("The refusal is hidden");
    expect(responseText).not.toContain("acceptanceCoverage");
    expect(responseText).not.toContain("findingLedger");
    expect(responseText).not.toContain("terminologyLedger");
    applyReviewSubmissionTurn(submission, {
      index: 2,
      total: 2,
      name: "challenge-and-record",
      text: responseText,
      status: "failed",
      error: "terminal flow rejected",
    });
    expect(submission.result()).toBeNull();
    expect(submission.findingSnapshot()).toEqual({ version: 1, findings: [] });
    expect(submission.terminologySnapshot()).toMatchObject({ revision: 0 });
  });

  it("keeps one pending result after failed duplicate submit calls (#9963)", async () => {
    const submission = controller();
    await execute(submission, RECORD_FINDINGS_TOOL, { findings: [finding()] });
    await execute(submission, RECORD_REVIEW_RECEIPT_TOOL, receipt());
    await execute(submission, RECOMMEND_E2E_TOOL, e2e());
    await execute(submission, SUBMIT_REVIEW_TOOL, {});

    await expect(execute(submission, SUBMIT_REVIEW_TOOL, {})).rejects.toThrow(
      "Review already submitted",
    );
    await expect(execute(submission, SUBMIT_REVIEW_TOOL, {})).rejects.toThrow(
      "Review already submitted",
    );
    applyReviewSubmissionTurn(submission, {
      index: 2,
      total: 2,
      name: "challenge-and-record",
      text: "",
      status: "completed",
    });

    expect(submission.result()).not.toBeNull();
    expect(submission.findingSnapshot()).toMatchObject({
      version: 1,
      findings: [{ id: "F-001" }],
    });
  });

  it("finalizes a repaired pending submission exactly once", async () => {
    const submission = controller();
    await execute(submission, RECORD_FINDINGS_TOOL, { findings: [finding()] });
    await execute(submission, RECORD_REVIEW_RECEIPT_TOOL, receipt());
    await execute(submission, RECOMMEND_E2E_TOOL, e2e());
    await execute(submission, SUBMIT_REVIEW_TOOL, {});
    applyReviewSubmissionTurn(submission, {
      index: 1,
      total: 2,
      name: "investigate",
      text: "",
      status: "completed",
    });
    expect(submission.result()).toBeNull();
    expect(submission.findingSnapshot()).toEqual({ version: 1, findings: [] });
    applyReviewSubmissionTurn(submission, {
      index: 2,
      total: 2,
      name: "challenge-and-record",
      text: "",
      status: "completed",
    });
    expect(submission.result()).not.toBeNull();
    expect(submission.findingSnapshot()).toMatchObject({ version: 1, findings: [{ id: "F-001" }] });
    expect(() =>
      applyReviewSubmissionTurn(submission, {
        index: 2,
        total: 2,
        name: "challenge-and-record",
        text: "",
        status: "completed",
      }),
    ).toThrow("no validated pending state");
    expect(submission.result()).toBeNull();
    expect(submission.findingSnapshot()).toEqual({ version: 1, findings: [] });
  });

  it("enforces deterministic test depth without losing rationale or suggested tests", async () => {
    const submission = controller();
    const draft = receipt();
    draft.testDepth = {
      verdict: "unit_sufficient",
      rationale: "The model recommends focused unit coverage.",
      suggestedTests: ["focused unit test", "model-only test"],
    };
    await execute(submission, RECORD_FINDINGS_TOOL, { findings: [finding()] });
    await execute(submission, RECORD_REVIEW_RECEIPT_TOOL, draft);
    await execute(submission, RECOMMEND_E2E_TOOL, e2e());
    const response = await execute(submission, SUBMIT_REVIEW_TOOL, {});
    expect(JSON.parse((response.content[0] as { text: string }).text)).toEqual({
      validated: true,
      pending: true,
    });
    expect(submission.result()).toBeNull();
    submission.finalize();
    expect((submission.result() as { testDepth: unknown }).testDepth).toEqual({
      verdict: "runtime_validation_recommended",
      rationale: "A runtime boundary changed. The model recommends focused unit coverage.",
      suggestedTests: ["deterministic runtime test", "focused unit test", "model-only test"],
    });
  });

  it("rejects placeholder finding quality before canonical assignment", async () => {
    const submission = controller();
    await execute(submission, RECORD_FINDINGS_TOOL, {
      findings: [{ ...finding(), impact: "No impact provided." }],
    });
    await execute(submission, RECORD_REVIEW_RECEIPT_TOOL, receipt());
    await execute(submission, RECOMMEND_E2E_TOOL, e2e());
    await expect(execute(submission, SUBMIT_REVIEW_TOOL, {})).rejects.toThrow("placeholder impact");
    expect(submission.findingSnapshot()).toEqual({ version: 1, findings: [] });
    expect(submission.result()).toBeNull();
  });

  it("strips acceptance and security finding IDs from the public result", async () => {
    const submission = controller();
    const draft = receipt();
    draft.acceptanceCoverage = [
      {
        clause: "Propagate refusal",
        status: "missing",
        evidence: "tools/pr-review-advisor/review-submission.mts:7",
        findingId: "F-001",
      },
    ];
    draft.securityCategories[0].verdict = "warning";
    draft.securityCategories[0].findingId = "F-002";
    await execute(submission, RECORD_FINDINGS_TOOL, {
      findings: [
        {
          ...finding(),
          severity: "blocker",
          category: "acceptance",
          basis: { ...finding().basis, kind: "unmet_acceptance" },
        },
        {
          ...finding("Security ambiguity"),
          category: "security",
          basis: { ...finding().basis, kind: "semantic_ambiguity" },
        },
      ],
    });
    await execute(submission, RECORD_REVIEW_RECEIPT_TOOL, draft);
    await execute(submission, RECOMMEND_E2E_TOOL, e2e());
    await execute(submission, SUBMIT_REVIEW_TOOL, {});
    submission.finalize();
    const result = submission.result() as {
      acceptanceCoverage: unknown[];
      securityCategories: unknown[];
    };
    expect(result.acceptanceCoverage[0]).not.toHaveProperty("findingId");
    expect(result.securityCategories[0]).not.toHaveProperty("findingId");
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
    expect(submission.findingSnapshot()).toEqual({ version: 1, findings: [] });
    expect(submission.terminologySnapshot()).toMatchObject({ revision: 0 });
    expect(submission.result()).toBeNull();
    const submitted = await execute(submission, SUBMIT_REVIEW_TOOL, {});
    expect(JSON.parse((submitted.content[0] as { text: string }).text)).toEqual({
      validated: true,
      pending: true,
    });
    expect(submitted.terminate).toBe(true);
    expect(normalizeE2e).toHaveBeenCalledOnce();
    expect(submission.result()).toBeNull();
    expect(submission.findingSnapshot()).toEqual({ version: 1, findings: [] });
    expect(submission.terminologySnapshot()).toMatchObject({ revision: 0 });
    submission.finalize();
    const result = submission.result() as Record<string, any>;
    expect(result.e2e.targets.required).toEqual([]);
    expect(result.summary).toMatchObject({
      recommendation: "merge_after_fixes",
      topItem: "The refusal is hidden",
    });
    expect(result.summary).not.toHaveProperty("sinceLastReview");
    expect(result).toMatchObject({
      version: 1,
      headSha: HEAD,
      findings: [
        {
          title: "The refusal is hidden",
          evidence: "tools/pr-review-advisor/review-submission.mts:7 returns success",
        },
      ],
      terminologyReview: { status: "clear", decisions: [] },
    });
    expect(result.findings[0].title).not.toBe("Discarded draft");
    expect(result.findings[0]).not.toHaveProperty("basis");
    expect(submission.findingSnapshot()).toEqual({
      version: 1,
      findings: [expect.objectContaining({ id: "F-001" })],
    });
    expect(submission.terminologySnapshot()).toMatchObject({ revision: 1, headSha: HEAD });
  });

  it("orders the canonical top item by severity and joins evidence with newlines", async () => {
    const submission = controller();
    await execute(submission, RECORD_FINDINGS_TOOL, {
      findings: [
        { ...finding("Suggestion first"), severity: "suggestion" },
        {
          ...finding("Blocker second"),
          severity: "blocker",
          evidence: [
            "tools/pr-review-advisor/review-submission.mts:7 returns success",
            "src/caller.ts:12 trusts success",
          ],
        },
      ],
    });
    await execute(submission, RECORD_REVIEW_RECEIPT_TOOL, receipt());
    await execute(submission, RECOMMEND_E2E_TOOL, e2e());
    await execute(submission, SUBMIT_REVIEW_TOOL, {});
    submission.finalize();
    const result = submission.result() as Record<string, any>;
    expect(result.summary.topItem).toBe("Blocker second");
    expect(result.findings[1].evidence).toBe(
      "tools/pr-review-advisor/review-submission.mts:7 returns success\nsrc/caller.ts:12 trusts success",
    );
  });

  it("fails closed before every section is present without canonical mutation", async () => {
    const submission = controller();
    await execute(submission, RECORD_FINDINGS_TOOL, { findings: [finding()] });
    await expect(execute(submission, SUBMIT_REVIEW_TOOL, {})).rejects.toThrow(
      "submit_review requires: review receipt, E2E recommendations",
    );
    expect(submission.findingSnapshot()).toEqual({ version: 1, findings: [] });
    expect(submission.result()).toBeNull();
  });

  it("repairs a semantically invalid finding only after submit fails", async () => {
    const submission = controller();
    const invalid = {
      ...finding(),
      basis: { kind: "security_violation", observed: "Mismatch.", expected: "Match." },
    };
    await expect(
      execute(submission, RECORD_FINDINGS_TOOL, { findings: [invalid] }),
    ).resolves.toBeDefined();
    await execute(submission, RECORD_REVIEW_RECEIPT_TOOL, receipt());
    await execute(submission, RECOMMEND_E2E_TOOL, e2e());
    await expect(execute(submission, SUBMIT_REVIEW_TOOL, {})).rejects.toThrow(
      "No addition policy admits category=correctness with basis.kind=security_violation; admissible pairs:",
    );
    expect(submission.findingSnapshot()).toEqual({ version: 1, findings: [] });
    expect(submission.result()).toBeNull();

    await execute(submission, RECORD_FINDINGS_TOOL, { findings: [finding()] });
    await expect(execute(submission, SUBMIT_REVIEW_TOOL, {})).rejects.toThrow(
      "review receipt (missing or stale for current findings revision)",
    );
    await execute(submission, RECORD_REVIEW_RECEIPT_TOOL, receipt());
    await expect(execute(submission, SUBMIT_REVIEW_TOOL, {})).resolves.toMatchObject({
      terminate: true,
    });
    expect(submission.findingSnapshot()).toEqual({ version: 1, findings: [] });
    expect(submission.result()).toBeNull();
    submission.finalize();
    expect(submission.findingSnapshot()).toMatchObject({ version: 1, findings: [{ id: "F-001" }] });
  });

  it("enforces the simplification contract while recording findings", async () => {
    const ordinary = controller();
    await expect(
      execute(ordinary, RECORD_FINDINGS_TOOL, {
        findings: [
          {
            ...finding(),
            simplification: {
              tag: "delete",
              cut: "Remove code.",
              replacement: "Use current code.",
              estimatedNetLines: -1,
              safetyBoundary: "Keep validation.",
            },
          },
        ],
      }),
    ).rejects.toThrow("must omit simplification unless basis.kind=unnecessary_complexity");

    const complexity = controller();
    await expect(
      execute(complexity, RECORD_FINDINGS_TOOL, {
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
      }),
    ).rejects.toThrow("requires simplification for basis.kind=unnecessary_complexity");
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
          simplification: {
            tag: "delete",
            cut: "Remove the parallel dispatcher.",
            replacement: "Use the existing dispatcher.",
            estimatedNetLines: -10,
            safetyBoundary: "Keep current dispatcher validation.",
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
    expect(submission.findingSnapshot()).toEqual({ version: 1, findings: [] });
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
      `securityCategories contains duplicate receipt concern security:${SECURITY_CATEGORY_NAMES[0]}`,
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
          evidence: "tools/pr-review-advisor/review-submission.mts:7",
        },
      ],
    });
    await execute(badReference, RECOMMEND_E2E_TOOL, e2e());
    await expect(execute(badReference, SUBMIT_REVIEW_TOOL, {})).rejects.toThrow(
      "sourceOfTruthReview[1] references unknown finding F-999",
    );
  });

  it("explains exact receipt reference repairs", async () => {
    const nonConcern = controller();
    const nonConcernReceipt = receipt();
    nonConcernReceipt.acceptanceCoverage[0].findingId = "F-001";
    await execute(nonConcern, RECORD_FINDINGS_TOOL, { findings: [finding()] });
    await execute(nonConcern, RECORD_REVIEW_RECEIPT_TOOL, nonConcernReceipt);
    await execute(nonConcern, RECOMMEND_E2E_TOOL, e2e());
    await expect(execute(nonConcern, SUBMIT_REVIEW_TOOL, {})).rejects.toThrow(
      "acceptanceCoverage[1] does not report a concern. Set findingId=null; do not reuse an unrelated finding to fill this entry.",
    );

    const concern = controller();
    const concernReceipt = receipt();
    concernReceipt.acceptanceCoverage = [
      { clause: "Clause", status: "missing", evidence: "evidence", findingId: null },
    ];
    await execute(concern, RECORD_FINDINGS_TOOL, { findings: [] });
    await execute(concern, RECORD_REVIEW_RECEIPT_TOOL, concernReceipt);
    await execute(concern, RECOMMEND_E2E_TOOL, e2e());
    await expect(execute(concern, SUBMIT_REVIEW_TOOL, {})).rejects.toThrow(
      "acceptanceCoverage[1] reports a concern and requires a finding ID for this exact concern.",
    );
  });

  it.each([
    [
      "acceptance",
      (value: ReturnType<typeof receipt>) => {
        value.acceptanceCoverage = [
          {
            clause: "Propagate refusal",
            status: "missing",
            evidence: "tools/pr-review-advisor/review-submission.mts:7",
            findingId: "F-001",
          },
        ];
      },
    ],
    [
      "security",
      (value: ReturnType<typeof receipt>) => {
        value.acceptanceCoverage = [];
        value.securityCategories[0].verdict = "warning";
        value.securityCategories[0].findingId = "F-001";
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
            evidence: "tools/pr-review-advisor/review-submission.mts:7",
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
    await expect(execute(submission, SUBMIT_REVIEW_TOOL, {})).rejects.toThrow();
    expect(submission.findingSnapshot()).toEqual({ version: 1, findings: [] });
    expect(submission.result()).toBeNull();
  });

  it.each([
    [
      "acceptance",
      "acceptance",
      "unmet_acceptance",
      (value: ReturnType<typeof receipt>) => {
        value.acceptanceCoverage = [
          {
            clause: "Propagate refusal",
            status: "partial",
            evidence: "tools/pr-review-advisor/review-submission.mts:7",
            findingId: "F-001",
          },
        ];
      },
    ],
    [
      "security",
      "security",
      "security_violation",
      (value: ReturnType<typeof receipt>) => {
        value.securityCategories[0].verdict = "warning";
        value.securityCategories[0].findingId = "F-001";
      },
    ],
    [
      "source of truth",
      "architecture",
      "behavior_mismatch",
      (value: ReturnType<typeof receipt>) => {
        value.sourceOfTruthReview = [
          {
            surface: "config",
            status: "needs_followup",
            findingId: "F-001",
            invalidState: "stale",
            sourceBoundary: "config",
            whyNotSourceFix: "none",
            regressionTest: "test",
            removalCondition: "fixed",
            evidence: "tools/pr-review-advisor/review-submission.mts:7",
          },
        ];
      },
    ],
  ] as const)(
    "requires a matching %s finding category",
    async (_name, category, basisKind, mutate) => {
      const matching = controller();
      const matchingReceipt = receipt();
      matchingReceipt.acceptanceCoverage = [];
      mutate(matchingReceipt);
      await execute(matching, RECORD_FINDINGS_TOOL, {
        findings: [{ ...finding(), category, basis: { ...finding().basis, kind: basisKind } }],
      });
      await execute(matching, RECORD_REVIEW_RECEIPT_TOOL, matchingReceipt);
      await execute(matching, RECOMMEND_E2E_TOOL, e2e());
      await expect(execute(matching, SUBMIT_REVIEW_TOOL, {})).resolves.toBeDefined();

      const unrelated = controller();
      const unrelatedFinding =
        _name === "acceptance"
          ? {
              ...finding(),
              category: "docs",
              basis: { ...finding().basis, kind: "documentation_mismatch" },
            }
          : _name === "source of truth"
            ? {
                ...finding(),
                category: "docs",
                basis: { ...finding().basis, kind: "documentation_mismatch" },
              }
            : finding();
      await execute(unrelated, RECORD_FINDINGS_TOOL, { findings: [unrelatedFinding] });
      await execute(unrelated, RECORD_REVIEW_RECEIPT_TOOL, matchingReceipt);
      await execute(unrelated, RECOMMEND_E2E_TOOL, e2e());
      await expect(execute(unrelated, SUBMIT_REVIEW_TOOL, {})).rejects.toThrow(
        "does not fit this concern",
      );
      expect(unrelated.findingSnapshot()).toEqual({ version: 1, findings: [] });
      expect(unrelated.result()).toBeNull();
    },
  );

  it.each(ACCEPTANCE_FINDING_REFERENCE_PAIRS)(
    "accepts acceptance reference tuple %s/%s",
    async (category, basisKind) => {
      const submission = controller();
      const draft = receipt();
      draft.acceptanceCoverage = [
        {
          clause: "Propagate refusal",
          status: "partial",
          evidence: "tools/pr-review-advisor/review-submission.mts:7",
          findingId: "F-001",
        },
      ];
      await execute(submission, RECORD_FINDINGS_TOOL, {
        findings: [{ ...finding(), category, basis: { ...finding().basis, kind: basisKind } }],
      });
      await execute(submission, RECORD_REVIEW_RECEIPT_TOOL, draft);
      await execute(submission, RECOMMEND_E2E_TOOL, e2e());
      await expect(execute(submission, SUBMIT_REVIEW_TOOL, {})).resolves.toBeDefined();
    },
  );

  it.each([
    ["correctness", "behavior_mismatch"],
    ["security", "semantic_ambiguity"],
    ["architecture", "behavior_mismatch"],
    ["scope", "behavior_mismatch"],
    ["tests", "missing_regression"],
  ] as const)("accepts source-of-truth finding category %s", async (category, basisKind) => {
    const submission = controller();
    const draft = receipt();
    draft.sourceOfTruthReview = [
      {
        surface: "config",
        status: "needs_followup",
        findingId: "F-001",
        invalidState: "stale",
        sourceBoundary: "config",
        whyNotSourceFix: "none",
        regressionTest: "test",
        removalCondition: "fixed",
        evidence: "tools/pr-review-advisor/review-submission.mts:7",
      },
    ];
    await execute(submission, RECORD_FINDINGS_TOOL, {
      findings: [{ ...finding(), category, basis: { ...finding().basis, kind: basisKind } }],
    });
    await execute(submission, RECORD_REVIEW_RECEIPT_TOOL, draft);
    await execute(submission, RECOMMEND_E2E_TOOL, e2e());
    await expect(execute(submission, SUBMIT_REVIEW_TOOL, {})).resolves.toBeDefined();
  });

  it.each([
    [
      "acceptance",
      (draft: ReturnType<typeof receipt>) => {
        draft.acceptanceCoverage = [
          { clause: "Repeated", status: "missing", evidence: "one", findingId: "F-001" },
          { clause: "Repeated", status: "partial", evidence: "two", findingId: "F-001" },
        ];
      },
      "acceptanceCoverage contains duplicate receipt concern acceptance:Repeated",
    ],
    [
      "source of truth",
      (draft: ReturnType<typeof receipt>) => {
        draft.acceptanceCoverage = [];
        draft.sourceOfTruthReview = [
          {
            surface: "config",
            status: "missing",
            findingId: "F-001",
            invalidState: "one",
            sourceBoundary: "source",
            whyNotSourceFix: "none",
            regressionTest: "test",
            removalCondition: "fixed",
            evidence: "one",
          },
          {
            surface: "config",
            status: "needs_followup",
            findingId: "F-001",
            invalidState: "two",
            sourceBoundary: "source",
            whyNotSourceFix: "none",
            regressionTest: "test",
            removalCondition: "fixed",
            evidence: "two",
          },
        ];
      },
      "sourceOfTruthReview contains duplicate receipt concern source-of-truth:config",
    ],
  ] as const)("rejects duplicate %s receipt concern identities", async (_name, mutate, message) => {
    const submission = controller();
    const draft = receipt();
    mutate(draft);
    await execute(submission, RECORD_FINDINGS_TOOL, { findings: [finding()] });
    await execute(submission, RECORD_REVIEW_RECEIPT_TOOL, draft);
    await execute(submission, RECOMMEND_E2E_TOOL, e2e());
    await expect(execute(submission, SUBMIT_REVIEW_TOOL, {})).rejects.toThrow(message);
  });

  it("rejects a compatible finding linked to a different receipt concern", async () => {
    const submission = controller();
    const draft = receipt();
    draft.acceptanceCoverage = [
      { clause: "First", status: "missing", evidence: "line 1", findingId: "F-001" },
      { clause: "Second", status: "partial", evidence: "line 2", findingId: "F-001" },
    ];
    await execute(submission, RECORD_FINDINGS_TOOL, {
      findings: [
        {
          ...finding(),
          severity: "blocker",
          category: "acceptance",
          basis: { ...finding().basis, kind: "unmet_acceptance" },
          receiptConcerns: ["acceptance:First"],
        },
      ],
    });
    await execute(submission, RECORD_REVIEW_RECEIPT_TOOL, draft);
    await execute(submission, RECOMMEND_E2E_TOOL, e2e());
    await expect(execute(submission, SUBMIT_REVIEW_TOOL, {})).rejects.toThrow(
      "acceptanceCoverage[2] references F-001, but that finding does not name receipt concern acceptance:Second",
    );
  });

  it("rejects two concerns that share one wrong finding ID without mutation", async () => {
    const submission = controller();
    const draft = receipt();
    draft.acceptanceCoverage = [
      { clause: "First", status: "missing", evidence: "line 1", findingId: "F-001" },
      { clause: "Second", status: "partial", evidence: "line 2", findingId: "F-001" },
    ];
    await execute(submission, RECORD_FINDINGS_TOOL, {
      findings: [
        {
          ...finding(),
          category: "security",
          basis: { ...finding().basis, kind: "semantic_ambiguity" },
        },
      ],
    });
    await execute(submission, RECORD_REVIEW_RECEIPT_TOOL, draft);
    await execute(submission, RECOMMEND_E2E_TOOL, e2e());
    await expect(execute(submission, SUBMIT_REVIEW_TOOL, {})).rejects.toThrow(
      "acceptanceCoverage[1] references F-001 (security/semantic_ambiguity), which does not fit this concern",
    );
    expect(submission.findingSnapshot()).toEqual({ version: 1, findings: [] });
    expect(submission.result()).toBeNull();
  });

  it("reports draft errors together before one submit repair", async () => {
    let returnInvalidE2e = true;
    const submission = controller(new Map(), (draft) =>
      returnInvalidE2e ? { ...draft, coverage: null } : draft,
    );
    const draft = receipt({
      decisions: [terminologyDecision("missing-trace")],
      noChangesReason: null,
    });
    draft.acceptanceCoverage[0].findingId = "F-001";
    draft.securityCategories[0].findingId = "F-001";
    await execute(submission, RECORD_FINDINGS_TOOL, { findings: [finding()] });
    await execute(submission, RECORD_REVIEW_RECEIPT_TOOL, draft);
    await execute(submission, RECOMMEND_E2E_TOOL, e2e());

    const failure = await execute(submission, SUBMIT_REVIEW_TOOL, {}).then(
      () => null,
      (error: unknown) => error as Error,
    );
    expect(failure).toBeInstanceOf(Error);
    expect(failure?.message).toContain("acceptanceCoverage[1] does not report a concern");
    expect(failure?.message).toContain("securityCategories[1] does not report a concern");
    expect(failure?.message).toContain("normalized E2E failed schema validation");
    expect(failure?.message).toContain("Unknown terminology trace missing-trace");
    expect(submission.findingSnapshot()).toEqual({ version: 1, findings: [] });
    expect(submission.terminologySnapshot()).toMatchObject({ revision: 0 });
    expect(submission.result()).toBeNull();

    returnInvalidE2e = false;
    await execute(submission, RECORD_REVIEW_RECEIPT_TOOL, receipt());
    await expect(execute(submission, SUBMIT_REVIEW_TOOL, {})).resolves.toMatchObject({
      terminate: true,
    });
  });

  it.each([
    ["null", null, 7],
    ["blank", "   ", 7],
    ["absolute", "/tmp/example.ts", 7],
    ["drive absolute", "C:/tmp/example.ts", 7],
    ["traversal", "../tools/pr-review-advisor/review-submission.mts", 7],
    ["missing", "tools/pr-review-advisor/not-present.mts", 7],
    ["null line", "tools/pr-review-advisor/review-submission.mts", null],
    ["zero line", "tools/pr-review-advisor/review-submission.mts", 0],
  ])(
    "rejects a %s finding location at submit without canonical mutation",
    async (_name, file, line) => {
      const submission = controller();
      await execute(submission, RECORD_FINDINGS_TOOL, { findings: [{ ...finding(), file, line }] });
      await execute(submission, RECORD_REVIEW_RECEIPT_TOOL, receipt());
      await execute(submission, RECOMMEND_E2E_TOOL, e2e());
      await expect(execute(submission, SUBMIT_REVIEW_TOOL, {})).rejects.toThrow();
      expect(submission.findingSnapshot()).toEqual({ version: 1, findings: [] });
      expect(submission.result()).toBeNull();
    },
  );

  it("uses the injected security inventory for receipt schema and validation", async () => {
    const injected = ["Injected Security Category"];
    const submission = controller(new Map(), (draft) => draft, injected);
    const draft = receipt();
    draft.securityCategories = [
      {
        category: injected[0]!,
        verdict: "pass",
        justification: "The injected category passed.",
        findingId: null,
      },
    ];
    await execute(submission, RECORD_FINDINGS_TOOL, { findings: [finding()] });
    await expect(execute(submission, RECORD_REVIEW_RECEIPT_TOOL, draft)).resolves.toBeDefined();
    await execute(submission, RECOMMEND_E2E_TOOL, e2e());
    await expect(execute(submission, SUBMIT_REVIEW_TOOL, {})).resolves.toBeDefined();

    const rejected = controller(new Map(), (value) => value, injected);
    await execute(rejected, RECORD_FINDINGS_TOOL, { findings: [finding()] });
    await expect(execute(rejected, RECORD_REVIEW_RECEIPT_TOOL, receipt())).rejects.toThrow(
      "record_review_receipt failed schema validation",
    );
    expect(rejected.findingSnapshot()).toEqual({ version: 1, findings: [] });
  });

  const acceptanceMissing = (draft: ReturnType<typeof receipt>) => {
    draft.acceptanceCoverage = [
      { clause: "Clause", status: "missing", evidence: "evidence", findingId: "F-001" },
    ];
  };
  const acceptancePartial = (draft: ReturnType<typeof receipt>) => {
    draft.acceptanceCoverage = [
      { clause: "Clause", status: "partial", evidence: "evidence", findingId: "F-001" },
    ];
  };
  const securityFail = (draft: ReturnType<typeof receipt>) => {
    draft.acceptanceCoverage = [];
    draft.securityCategories[0] = {
      ...draft.securityCategories[0],
      verdict: "fail",
      findingId: "F-001",
    };
  };
  const securityWarning = (draft: ReturnType<typeof receipt>) => {
    draft.acceptanceCoverage = [];
    draft.securityCategories[0] = {
      ...draft.securityCategories[0],
      verdict: "warning",
      findingId: "F-001",
    };
  };
  const sourceMissing = (draft: ReturnType<typeof receipt>) => {
    draft.acceptanceCoverage = [];
    draft.sourceOfTruthReview = [
      {
        surface: "config",
        status: "missing",
        findingId: "F-001",
        invalidState: "stale",
        sourceBoundary: "source",
        whyNotSourceFix: "none",
        regressionTest: "test",
        removalCondition: "fixed",
        evidence: "evidence",
      },
    ];
  };
  const sourceFollowup = (draft: ReturnType<typeof receipt>) => {
    draft.acceptanceCoverage = [];
    draft.sourceOfTruthReview = [
      {
        surface: "config",
        status: "needs_followup",
        findingId: "F-001",
        invalidState: "stale",
        sourceBoundary: "source",
        whyNotSourceFix: "none",
        regressionTest: "test",
        removalCondition: "fixed",
        evidence: "evidence",
      },
    ];
  };

  it.each([
    ["acceptance missing", "acceptance", "unmet_acceptance", "blocker", acceptanceMissing],
    ["acceptance partial minimum", "acceptance", "unmet_acceptance", "warning", acceptancePartial],
    ["acceptance partial blocker", "acceptance", "unmet_acceptance", "blocker", acceptancePartial],
    ["security fail", "security", "security_violation", "blocker", securityFail],
    ["security warning minimum", "security", "security_violation", "warning", securityWarning],
    ["security warning blocker", "security", "security_violation", "blocker", securityWarning],
    ["source missing suggestion", "architecture", "behavior_mismatch", "suggestion", sourceMissing],
    [
      "source follow-up suggestion",
      "architecture",
      "behavior_mismatch",
      "suggestion",
      sourceFollowup,
    ],
  ] as const)(
    "accepts %s linked finding severity",
    async (_name, category, basisKind, severity, mutateReceipt) => {
      const accepted = controller();
      const draft = receipt();
      mutateReceipt(draft);
      await execute(accepted, RECORD_FINDINGS_TOOL, {
        findings: [
          { ...finding(), severity, category, basis: { ...finding().basis, kind: basisKind } },
        ],
      });
      await execute(accepted, RECORD_REVIEW_RECEIPT_TOOL, draft);
      await execute(accepted, RECOMMEND_E2E_TOOL, e2e());
      await expect(execute(accepted, SUBMIT_REVIEW_TOOL, {})).resolves.toBeDefined();
    },
  );

  it.each([
    ["acceptance missing", "acceptance", "unmet_acceptance", "warning", acceptanceMissing],
    ["acceptance partial", "acceptance", "unmet_acceptance", "suggestion", acceptancePartial],
    ["security fail", "security", "security_violation", "warning", securityFail],
    ["security warning", "security", "security_violation", "suggestion", securityWarning],
  ] as const)(
    "rejects weaker %s linked finding severity atomically",
    async (_name, category, basisKind, severity, mutateReceipt) => {
      const rejected = controller();
      const draft = receipt();
      mutateReceipt(draft);
      await execute(rejected, RECORD_FINDINGS_TOOL, {
        findings: [
          { ...finding(), severity, category, basis: { ...finding().basis, kind: basisKind } },
        ],
      });
      await execute(rejected, RECORD_REVIEW_RECEIPT_TOOL, draft);
      await execute(rejected, RECOMMEND_E2E_TOOL, e2e());
      await expect(execute(rejected, SUBMIT_REVIEW_TOOL, {})).rejects.toThrow("requires");
      expect(rejected.findingSnapshot()).toEqual({ version: 1, findings: [] });
      expect(rejected.result()).toBeNull();
    },
  );

  it("resolves terminology traces lazily at submission time", async () => {
    let traces = new Map<string, TerminologyTrace>();
    const submission = createReviewSubmissionController({
      metadata: {
        baseRef: "origin/main",
        headRef: "HEAD",
        headSha: HEAD,
        changedFiles: ["tools/pr-review-advisor/review-submission.mts"],
        deterministic: {
          testDepth: {
            verdict: "unit_sufficient",
            rationale: "Unit coverage is sufficient.",
            suggestedTests: ["focused unit test"],
          },
          hasOpenPrReplacement: false,
        },
      },
      schema: reviewSchema,
      repositoryRoot: ROOT,
      securityCategoryNames: SECURITY_CATEGORY_NAMES,
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
      changedLocations: [
        { file: "tools/pr-review-advisor/review-submission.mts", line: 9, text: "review receipt" },
      ],
      baseSamples: [],
      headSamples: [],
      firstCommitSha: HEAD,
    };
    traces = new Map([[trace.id, trace]]);
    await execute(submission, RECORD_FINDINGS_TOOL, { findings: [finding()] });
    await execute(
      submission,
      RECORD_REVIEW_RECEIPT_TOOL,
      receipt({
        decisions: [terminologyDecision(trace.id)],
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
      changedLocations: [
        { file: "tools/pr-review-advisor/review-submission.mts", line: 9, text: "review receipt" },
      ],
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
        decisions: [terminologyDecision(trace.id)],
        noChangesReason: null,
      }),
    );
    await execute(submission, RECOMMEND_E2E_TOOL, e2e());
    await execute(submission, SUBMIT_REVIEW_TOOL, {});
    submission.finalize();
    const result = submission.result() as Record<string, any>;
    expect(result.terminologyReview.decisions[0]).toMatchObject({
      id: "T-001",
      traceId: trace.id,
      source: { file: "tools/pr-review-advisor/review-submission.mts", line: 9, headSha: HEAD },
    });
  });

  it.each([
    [
      "SDK execution errors",
      ["provider failed"],
      completedSubmission({ submitted: true }),
      "PR review advisor SDK execution failed: provider failed",
    ],
    [
      "missing atomic submission",
      [],
      completedSubmission(null),
      "PR review advisor did not atomically submit a review result",
    ],
  ] as const)("writes no canonical artifacts for %s", (_name, errors, submission, reason) => {
    const write = vi.fn();
    expect(() => persistSuccessfulReview(errors, submission, ARTIFACTS, write)).toThrow(reason);
    expect(write).not.toHaveBeenCalled();
  });

  it("writes the canonical result to both artifacts", () => {
    const result = { submitted: true };
    const submission = completedSubmission(result);
    const write = vi.fn();

    expect(persistSuccessfulReview([], submission, ARTIFACTS, write)).toBe(result);
    expect(write.mock.calls).toEqual([
      [ARTIFACTS.result, result],
      [ARTIFACTS.finalResult, result],
    ]);
  });
});
