// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import reviewSchema from "../tools/pr-review-advisor/schema.json" with { type: "json" };
import { persistReviewSubmissionTurn } from "../tools/pr-review-advisor/analyze.mts";
import {
  ACCEPTANCE_FINDING_REFERENCE_PAIRS,
  createReviewSubmissionController,
  RECORD_FINDINGS_TOOL,
  RECORD_REVIEW_RECEIPT_TOOL,
  RECOMMEND_E2E_TOOL,
  SUBMIT_REVIEW_TOOL,
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

  it.each(["post-success prose", "duplicate submit"])(
    "discards pending canonical state after rejected %s flow",
    async () => {
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
      const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "pr-advisor-rejected-flow-"));
      const paths = {
        result: path.join(tmp, "result.json"),
        findingLedger: path.join(tmp, "findings.json"),
        terminologyLedger: path.join(tmp, "terminology.json"),
      };
      try {
        persistReviewSubmissionTurn(
          submission,
          {
            index: 2,
            total: 2,
            name: "challenge-and-record",
            text: responseText,
            status: "failed",
            error: "terminal flow rejected",
          },
          paths,
        );
        expect(submission.result()).toBeNull();
        expect(submission.findingSnapshot()).toMatchObject({ revision: 0, findings: [] });
        expect(submission.terminologySnapshot()).toMatchObject({ revision: 0 });
        expect(JSON.parse(fs.readFileSync(paths.result, "utf8"))).toBeNull();
        expect(JSON.parse(fs.readFileSync(paths.findingLedger, "utf8"))).toMatchObject({
          revision: 0,
          findings: [],
        });
      } finally {
        fs.rmSync(tmp, { recursive: true, force: true });
      }
    },
  );

  it("finalizes a repaired pending submission exactly once", async () => {
    const submission = controller();
    await execute(submission, RECORD_FINDINGS_TOOL, { findings: [finding()] });
    await execute(submission, RECORD_REVIEW_RECEIPT_TOOL, receipt());
    await execute(submission, RECOMMEND_E2E_TOOL, e2e());
    await execute(submission, SUBMIT_REVIEW_TOOL, {});
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "pr-advisor-accepted-flow-"));
    const paths = {
      result: path.join(tmp, "result.json"),
      findingLedger: path.join(tmp, "findings.json"),
      terminologyLedger: path.join(tmp, "terminology.json"),
    };
    try {
      persistReviewSubmissionTurn(
        submission,
        { index: 2, total: 2, name: "challenge-and-record", text: "", status: "completed" },
        paths,
      );
      expect(submission.result()).not.toBeNull();
      expect(submission.findingSnapshot()).toMatchObject({ revision: 1 });
      expect(() =>
        persistReviewSubmissionTurn(
          submission,
          { index: 2, total: 2, name: "challenge-and-record", text: "", status: "completed" },
          paths,
        ),
      ).toThrow("no validated pending state");
      expect(submission.result()).toBeNull();
      expect(submission.findingSnapshot()).toMatchObject({ revision: 0, findings: [] });
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
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
    expect(submission.findingSnapshot()).toMatchObject({ revision: 0, findings: [] });
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
    expect(submission.findingSnapshot()).toMatchObject({ revision: 0, findings: [] });
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
    expect(submission.findingSnapshot()).toMatchObject({ revision: 0, findings: [] });
    expect(submission.terminologySnapshot()).toMatchObject({ revision: 0 });
    submission.finalize();
    const result = submission.result() as Record<string, any>;
    expect(result.e2e.targets.required).toEqual([]);
    expect(result.summary).toMatchObject({
      recommendation: "merge_after_fixes",
      topItem: "The refusal is hidden",
    });
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
    expect(submission.findingSnapshot()).toMatchObject({
      revision: 1,
      findings: [{ id: "F-001", status: "open" }],
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
    expect(submission.findingSnapshot()).toMatchObject({ revision: 0, findings: [] });
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
    expect(submission.findingSnapshot()).toMatchObject({ revision: 0, findings: [] });
    expect(submission.result()).toBeNull();

    await execute(submission, RECORD_FINDINGS_TOOL, { findings: [finding()] });
    await expect(execute(submission, SUBMIT_REVIEW_TOOL, {})).rejects.toThrow(
      "review receipt (missing or stale for current findings revision)",
    );
    await execute(submission, RECORD_REVIEW_RECEIPT_TOOL, receipt());
    await expect(execute(submission, SUBMIT_REVIEW_TOOL, {})).resolves.toMatchObject({
      terminate: true,
    });
    expect(submission.findingSnapshot()).toMatchObject({ revision: 0 });
    expect(submission.result()).toBeNull();
    submission.finalize();
    expect(submission.findingSnapshot()).toMatchObject({ revision: 1 });
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
          evidence: "tools/pr-review-advisor/review-submission.mts:7",
        },
      ],
    });
    await execute(badReference, RECOMMEND_E2E_TOOL, e2e());
    await expect(execute(badReference, SUBMIT_REVIEW_TOOL, {})).rejects.toThrow(
      "sourceOfTruthReview[1] references unknown finding F-999",
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
    expect(submission.findingSnapshot()).toMatchObject({ revision: 0, findings: [] });
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
      expect(unrelated.findingSnapshot()).toMatchObject({ revision: 0, findings: [] });
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
      "acceptanceCoverage[1] references finding F-001, which does not fit this concern",
    );
    expect(submission.findingSnapshot()).toMatchObject({ revision: 0, findings: [] });
    expect(submission.result()).toBeNull();
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
      expect(submission.findingSnapshot()).toMatchObject({ revision: 0, findings: [] });
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
    await execute(rejected, RECORD_REVIEW_RECEIPT_TOOL, receipt());
    await execute(rejected, RECOMMEND_E2E_TOOL, e2e());
    await expect(execute(rejected, SUBMIT_REVIEW_TOOL, {})).rejects.toThrow(
      "securityCategories must contain each named category exactly once",
    );
    expect(rejected.findingSnapshot()).toMatchObject({ revision: 0, findings: [] });
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
      expect(rejected.findingSnapshot()).toMatchObject({ revision: 0, findings: [] });
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
            source: { file: "tools/pr-review-advisor/review-submission.mts", line: 9 },
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
            source: { file: "tools/pr-review-advisor/review-submission.mts", line: 9 },
          },
        ],
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
});
