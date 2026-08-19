// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import Ajv2020 from "ajv/dist/2020.js";
import { defineTool, type ToolDefinition } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

import {
  validateReviewFindingSubmission,
  type ReviewFinding,
  type CandidateFindingInput,
  type ReviewFindingLedgerSnapshot,
} from "./review-ledger.mts";
import {
  createTerminologyLedger,
  TERMINOLOGY_CHANGES,
  TERMINOLOGY_DISPOSITIONS,
  TERMINOLOGY_SEMANTIC_IMPACTS,
  type TerminologyCommitInput,
  type TerminologyLedgerSnapshot,
  type TerminologyTrace,
} from "./terminology.mts";

export const RECORD_FINDINGS_TOOL = "record_findings";
export const RECORD_REVIEW_RECEIPT_TOOL = "record_review_receipt";
export const RECOMMEND_E2E_TOOL = "recommend_e2e";
export const SUBMIT_REVIEW_TOOL = "submit_review";

const text = Type.String({ minLength: 1 });
const nullableText = Type.Union([text, Type.Null()]);
const confidence = Type.Union(["low", "medium", "high"].map((value) => Type.Literal(value)));
const findingSchema = Type.Object(
  {
    severity: Type.Union(["blocker", "warning", "suggestion"].map((value) => Type.Literal(value))),
    category: Type.Union(
      [
        "security",
        "correctness",
        "tests",
        "architecture",
        "workflow",
        "docs",
        "scope",
        "acceptance",
      ].map((value) => Type.Literal(value)),
    ),
    file: Type.Union([text, Type.Null()]),
    line: Type.Union([Type.Integer({ minimum: 1 }), Type.Null()]),
    title: text,
    description: text,
    impact: text,
    recommendation: text,
    verificationHint: text,
    missingRegressionTest: text,
    evidence: Type.Array(text, { minItems: 1 }),
    basis: Type.Object(
      {
        kind: Type.Union(
          [
            "behavior_mismatch",
            "unmet_acceptance",
            "security_violation",
            "missing_regression",
            "unnecessary_complexity",
            "documentation_mismatch",
            "semantic_ambiguity",
          ].map((value) => Type.Literal(value)),
        ),
        observed: text,
        expected: text,
      },
      { additionalProperties: false },
    ),
    simplification: Type.Optional(
      Type.Object(
        {
          tag: Type.Union(
            ["delete", "stdlib", "native", "yagni", "shrink"].map((value) => Type.Literal(value)),
          ),
          cut: text,
          replacement: text,
          estimatedNetLines: Type.Union([Type.Integer(), Type.Null()]),
          safetyBoundary: text,
        },
        { additionalProperties: false },
      ),
    ),
  },
  { additionalProperties: false },
);
const terminologyDecisionSchema = Type.Object(
  {
    term: Type.String({ minLength: 1, maxLength: 80 }),
    change: Type.Union(TERMINOLOGY_CHANGES.map((value) => Type.Literal(value))),
    disposition: Type.Union(TERMINOLOGY_DISPOSITIONS.map((value) => Type.Literal(value))),
    meaning: text,
    contrast: nullableText,
    existingTerm: nullableText,
    semanticImpact: Type.Union(TERMINOLOGY_SEMANTIC_IMPACTS.map((value) => Type.Literal(value))),
    recommendation: text,
    traceId: Type.String({ minLength: 1, maxLength: 80 }),
    source: Type.Object(
      { file: text, line: Type.Integer({ minimum: 1 }) },
      { additionalProperties: false },
    ),
  },
  { additionalProperties: false },
);
const summarySchema = Type.Object(
  {
    recommendation: Type.Union(
      [
        "merge_as_is",
        "merge_after_fixes",
        "needs_rework",
        "blocked",
        "superseded",
        "info_only",
      ].map((value) => Type.Literal(value)),
    ),
    confidence,
    oneLine: text,
    topItem: Type.Optional(text),
    sinceLastReview: Type.Optional(
      Type.Object(
        {
          resolved: Type.Integer({ minimum: 0 }),
          stillApplies: Type.Integer({ minimum: 0 }),
          newItems: Type.Integer({ minimum: 0 }),
        },
        { additionalProperties: false },
      ),
    ),
  },
  { additionalProperties: false },
);
const reviewReceiptSchema = Type.Object(
  {
    summary: summarySchema,
    terminologyReview: Type.Object(
      {
        decisions: Type.Array(terminologyDecisionSchema, { maxItems: 20 }),
        noChangesReason: Type.Union([text, Type.Null()]),
      },
      { additionalProperties: false },
    ),
    acceptanceCoverage: Type.Array(
      Type.Object(
        {
          clause: text,
          status: Type.Union(
            ["met", "partial", "missing", "unknown"].map((value) => Type.Literal(value)),
          ),
          evidence: text,
        },
        { additionalProperties: false },
      ),
    ),
    securityCategories: Type.Array(
      Type.Object(
        {
          category: text,
          verdict: Type.Union(["pass", "warning", "fail"].map((value) => Type.Literal(value))),
          justification: text,
        },
        { additionalProperties: false },
      ),
    ),
    sourceOfTruthReview: Type.Array(
      Type.Object(
        {
          surface: text,
          status: Type.Union(
            ["not_applicable", "satisfied", "needs_followup", "missing"].map((value) =>
              Type.Literal(value),
            ),
          ),
          findingId: Type.Union([text, Type.Null()]),
          invalidState: Type.String(),
          sourceBoundary: Type.String(),
          whyNotSourceFix: Type.String(),
          regressionTest: Type.String(),
          removalCondition: Type.String(),
          evidence: Type.String(),
        },
        { additionalProperties: false },
      ),
    ),
    testDepth: Type.Object(
      {
        verdict: Type.Union(
          ["unit_sufficient", "mocks_recommended", "runtime_validation_recommended", "unknown"].map(
            (value) => Type.Literal(value),
          ),
        ),
        rationale: text,
        suggestedTests: Type.Array(Type.String()),
      },
      { additionalProperties: false },
    ),
    positives: Type.Array(Type.String()),
    reviewCompleteness: Type.Object(
      { limitations: Type.Array(Type.String()), requiresHumanReview: Type.Literal(true) },
      { additionalProperties: false },
    ),
  },
  { additionalProperties: false },
);
const e2eTest = Type.Object({ id: text, reason: text }, { additionalProperties: false });
const targetRecommendation = Type.Object(
  {
    id: text,
    workflow: Type.Literal("e2e.yaml"),
    selectorType: Type.Union(["all", "target", "job"].map((value) => Type.Literal(value))),
    required: Type.Boolean(),
    reason: text,
  },
  { additionalProperties: false },
);
const e2eSchema = Type.Object(
  {
    coverage: Type.Object(
      {
        classifiedDomains: Type.Array(
          Type.Object(
            { domain: text, reason: text, confidence, matchedFiles: Type.Array(Type.String()) },
            { additionalProperties: false },
          ),
        ),
        requiredTests: Type.Array(e2eTest),
        optionalTests: Type.Array(e2eTest),
        newE2eRecommendations: Type.Array(
          Type.Object(
            { domain: text, reason: text, suggestedTest: text, priority: confidence },
            { additionalProperties: false },
          ),
        ),
        noE2eReason: Type.Union([text, Type.Null()]),
        confidence,
      },
      { additionalProperties: false },
    ),
    targets: Type.Object(
      {
        relevantChangedFiles: Type.Array(Type.String()),
        changedCredentialFreeTests: Type.Array(
          Type.Object({ id: text, file: text, headSha: text }, { additionalProperties: false }),
        ),
        required: Type.Array(targetRecommendation),
        optional: Type.Array(targetRecommendation),
        noTargetE2eReason: Type.Union([text, Type.Null()]),
        confidence,
      },
      { additionalProperties: false },
    ),
  },
  { additionalProperties: false },
);

export type ReviewSubmissionMetadata = Readonly<{
  baseRef: string;
  headRef: string;
  headSha: string;
  changedFiles: readonly string[];
}>;
export type NormalizeReviewE2e = (
  draft: Record<string, unknown>,
  metadata: ReviewSubmissionMetadata,
) => Record<string, unknown> | Promise<Record<string, unknown>>;

export const SECURITY_CATEGORY_NAMES = [
  "Secrets and Credentials",
  "Input Validation and Data Sanitization",
  "Authentication and Authorization",
  "Dependencies and Third-Party Libraries",
  "Error Handling and Logging",
  "Cryptography and Data Protection",
  "Configuration and Security Headers",
  "Security Testing",
  "System Security",
] as const;

export type ReviewSubmissionController = Readonly<{
  tools: ToolDefinition[];
  result(): unknown | null;
  findingSnapshot(): ReviewFindingLedgerSnapshot;
  terminologySnapshot(): TerminologyLedgerSnapshot;
}>;

type ModelFindingInput = CandidateFindingInput;
type RecordFindingsInput = Readonly<{ findings: readonly ModelFindingInput[] }>;

type DraftReceipt = {
  summary: Record<string, unknown>;
  terminologyReview: TerminologyCommitInput;
  acceptanceCoverage: unknown[];
  securityCategories: unknown[];
  sourceOfTruthReview: unknown[];
  testDepth: Record<string, unknown>;
  positives: string[];
  reviewCompleteness: Record<string, unknown>;
};

export function createReviewSubmissionController({
  metadata,
  schema,
  terminologyTraces = new Map(),
  normalizeE2e,
}: {
  metadata: ReviewSubmissionMetadata;
  schema: Record<string, unknown>;
  terminologyTraces?:
    | ReadonlyMap<string, TerminologyTrace>
    | (() => ReadonlyMap<string, TerminologyTrace>);
  normalizeE2e: NormalizeReviewE2e;
}): ReviewSubmissionController {
  let findingsDraft: ModelFindingInput[] | null = null;
  let receiptDraft: DraftReceipt | null = null;
  let e2eDraft: Record<string, unknown> | null = null;
  let submitted: unknown | null = null;
  let findingSnapshot = validateReviewFindingSubmission([]);
  let terminologySnapshot = createTerminologyLedger(metadata.headSha).snapshot();
  const validate = new Ajv2020({ allErrors: true, strict: false }).compile(schema);

  const recordFindings = defineTool({
    name: RECORD_FINDINGS_TOOL,
    label: "Record review findings draft",
    description:
      "Replace the complete in-memory findings draft. Canonical state changes only after submit_review succeeds.",
    parameters: Type.Object(
      { findings: Type.Array(findingSchema) },
      { additionalProperties: false },
    ),
    executionMode: "sequential",
    execute: async (_id, input) => {
      ensureOpen(submitted);
      const draft = input as RecordFindingsInput;
      findingsDraft = draft.findings.map((finding) => structuredClone(finding));
      return toolResult({ recorded: "findings", count: findingsDraft.length });
    },
  });
  const recordReceipt = defineTool({
    name: RECORD_REVIEW_RECEIPT_TOOL,
    label: "Record review receipt draft",
    description:
      "Replace the complete in-memory review receipt draft without changing canonical state.",
    parameters: reviewReceiptSchema,
    executionMode: "sequential",
    execute: async (_id, input) => {
      ensureOpen(submitted);
      receiptDraft = structuredClone(input as DraftReceipt);
      return toolResult({ recorded: "review_receipt" });
    },
  });
  const recommendE2e = defineTool({
    name: RECOMMEND_E2E_TOOL,
    label: "Record E2E recommendations draft",
    description:
      "Replace the complete in-memory E2E recommendation draft without changing canonical state.",
    parameters: e2eSchema,
    executionMode: "sequential",
    execute: async (_id, input) => {
      ensureOpen(submitted);
      e2eDraft = structuredClone(input as Record<string, unknown>);
      return toolResult({ recorded: "e2e" });
    },
  });
  const submitReview = defineTool({
    name: SUBMIT_REVIEW_TOOL,
    label: "Submit complete PR review",
    description:
      "Validate every draft section, atomically create canonical snapshots and the public review result, and end the turn.",
    parameters: Type.Object({}, { additionalProperties: false }),
    executionMode: "sequential",
    execute: async () => {
      ensureOpen(submitted);
      const missing = [
        findingsDraft === null ? "findings" : null,
        receiptDraft === null ? "review receipt" : null,
        e2eDraft === null ? "E2E recommendations" : null,
      ].filter(Boolean);
      if (missing.length > 0) throw new Error(`submit_review requires: ${missing.join(", ")}`);

      const candidateFindingSnapshot = validateReviewFindingSubmission(findingsDraft!);
      const openFindings = candidateFindingSnapshot.findings.filter(
        (finding) => finding.status === "open",
      );
      validateSecurityCategories(receiptDraft!.securityCategories);
      validateReceiptFindingCoverage(receiptDraft!, openFindings);
      validateSourceOfTruthReferences(receiptDraft!.sourceOfTruthReview, openFindings);
      const summary = canonicalSummary(receiptDraft!.summary, openFindings);
      const normalizedE2e = await normalizeE2e(structuredClone(e2eDraft!), metadata);
      const candidateTerminology = createTerminologyLedger(metadata.headSha);
      const traces =
        typeof terminologyTraces === "function" ? terminologyTraces() : terminologyTraces;
      candidateTerminology.commit(receiptDraft!.terminologyReview, traces);
      const result = {
        version: 1,
        baseRef: metadata.baseRef,
        headRef: metadata.headRef,
        headSha: metadata.headSha,
        changedFiles: [...metadata.changedFiles],
        ...receiptDraft,
        summary,
        findings: openFindings.map(publicFinding),
        terminologyReview: candidateTerminology.snapshot().review,
        e2e: normalizedE2e,
      };
      if (!validate(result)) {
        const reason = (validate.errors ?? [])
          .map((error) => `${error.instancePath || "/"} ${error.message}`)
          .join("; ");
        throw new Error(`submit_review result does not match the public schema: ${reason}`);
      }
      findingSnapshot = candidateFindingSnapshot;
      terminologySnapshot = candidateTerminology.snapshot();
      submitted = structuredClone(result);
      return toolResult(
        {
          result: submitted,
          findingLedger: findingSnapshot,
          terminologyLedger: terminologySnapshot,
        },
        true,
      );
    },
  });

  return {
    tools: [recordFindings, recordReceipt, recommendE2e, submitReview],
    result: () => structuredClone(submitted),
    findingSnapshot: () => findingSnapshot,
    terminologySnapshot: () => terminologySnapshot,
  };
}

function validateSecurityCategories(categories: unknown[]): void {
  const names = categories.map((value) => (value as { category?: unknown }).category);
  const missing = SECURITY_CATEGORY_NAMES.filter((name) => !names.includes(name));
  const extras = names.filter((name) => !SECURITY_CATEGORY_NAMES.includes(name as never));
  if (missing.length > 0 || extras.length > 0 || new Set(names).size !== names.length) {
    throw new Error(
      `securityCategories must contain each named category exactly once; missing: ${missing.join(", ") || "none"}; unsupported or duplicate: ${extras.join(", ") || "none"}`,
    );
  }
}

function validateReceiptFindingCoverage(
  receipt: DraftReceipt,
  findings: readonly ReviewFinding[],
): void {
  const hasFinding = findings.length > 0;
  const unmetAcceptance = receipt.acceptanceCoverage.some((value) => {
    const status = (value as { status?: unknown }).status;
    return status === "partial" || status === "missing";
  });
  const securityConcern = receipt.securityCategories.some((value) => {
    const verdict = (value as { verdict?: unknown }).verdict;
    return verdict === "warning" || verdict === "fail";
  });
  const unresolvedSource = receipt.sourceOfTruthReview.some((value) => {
    const status = (value as { status?: unknown }).status;
    return status === "needs_followup" || status === "missing";
  });
  if (!hasFinding && (unmetAcceptance || securityConcern || unresolvedSource)) {
    throw new Error(
      "review receipt reports an unresolved acceptance, security, or source-of-truth concern without a canonical finding",
    );
  }
}

function validateSourceOfTruthReferences(
  entries: unknown[],
  findings: readonly ReviewFinding[],
): void {
  const ids = new Set(findings.map((finding) => finding.id));
  for (const entry of entries as { status: string; findingId: string | null }[]) {
    const unresolved = entry.status === "needs_followup" || entry.status === "missing";
    if (unresolved && entry.findingId === null) {
      throw new Error("unresolved sourceOfTruthReview entry must reference a canonical finding");
    }
    if (!unresolved && entry.findingId !== null) {
      throw new Error("resolved sourceOfTruthReview entry must use findingId=null");
    }
    if (entry.findingId !== null && !ids.has(entry.findingId)) {
      throw new Error(
        `sourceOfTruthReview references unknown canonical finding ${entry.findingId}`,
      );
    }
  }
}

function canonicalSummary(
  input: Record<string, unknown>,
  findings: readonly ReviewFinding[],
): Record<string, unknown> {
  const confidence = input.confidence;
  const recommendation =
    input.recommendation === "superseded"
      ? "superseded"
      : findings.length > 0
        ? "merge_after_fixes"
        : confidence === "low"
          ? "info_only"
          : "merge_as_is";
  const counts = ["blocker", "warning", "suggestion"].map(
    (severity) => findings.filter((finding) => finding.severity === severity).length,
  );
  const topItem = findings[0]?.title;
  return {
    ...input,
    recommendation,
    oneLine:
      findings.length > 0
        ? `Canonical ledger: ${counts[0]} blocker(s), ${counts[1]} warning(s), ${counts[2]} suggestion(s).`
        : "No actionable findings remain in the canonical review ledger.",
    ...(topItem ? { topItem } : { topItem: undefined }),
  };
}

function publicFinding(finding: ReviewFinding): Record<string, unknown> {
  const { id: _id, status: _status, supersededBy: _supersededBy, evidence, ...rest } = finding;
  return { ...rest, evidence: evidence.join("; ") };
}

function ensureOpen(submitted: unknown | null): void {
  if (submitted !== null) throw new Error("Review already submitted");
}

function toolResult(value: unknown, terminate = false) {
  return {
    content: [{ type: "text" as const, text: JSON.stringify(value) }],
    details: {},
    ...(terminate ? { terminate } : {}),
  };
}
