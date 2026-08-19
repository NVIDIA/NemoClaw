// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import Ajv2020 from "ajv/dist/2020.js";
import { defineTool, type ToolDefinition } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

import {
  enforceDeterministicTestDepthFloor,
  reviewQualityIssues,
  type ReviewTestDepth,
} from "./review-quality.mts";
import {
  REVIEW_FINDING_BASIS_KINDS,
  REVIEW_FINDING_CATEGORIES,
  REVIEW_FINDING_LIMIT,
  REVIEW_FINDING_SEVERITIES,
  REVIEW_FINDING_SIMPLIFICATION_TAGS,
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
    severity: Type.Union(REVIEW_FINDING_SEVERITIES.map((value) => Type.Literal(value))),
    category: Type.Union(REVIEW_FINDING_CATEGORIES.map((value) => Type.Literal(value))),
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
        kind: Type.Union(REVIEW_FINDING_BASIS_KINDS.map((value) => Type.Literal(value))),
        observed: text,
        expected: text,
      },
      { additionalProperties: false },
    ),
    simplification: Type.Optional(
      Type.Object(
        {
          tag: Type.Union(REVIEW_FINDING_SIMPLIFICATION_TAGS.map((value) => Type.Literal(value))),
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
function createReviewReceiptSchema(securityCategoryNames: readonly string[]) {
  if (securityCategoryNames.length === 0) {
    throw new Error("securityCategoryNames must not be empty");
  }
  return Type.Object(
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
            findingId: Type.Union([text, Type.Null()]),
          },
          { additionalProperties: false },
        ),
      ),
      securityCategories: Type.Array(
        Type.Object(
          {
            category: Type.Union(securityCategoryNames.map((value) => Type.Literal(value))),
            verdict: Type.Union(["pass", "warning", "fail"].map((value) => Type.Literal(value))),
            justification: text,
            findingId: Type.Union([text, Type.Null()]),
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
            [
              "unit_sufficient",
              "mocks_recommended",
              "runtime_validation_recommended",
              "unknown",
            ].map((value) => Type.Literal(value)),
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
}
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
  deterministic: Readonly<{ testDepth: ReviewTestDepth }>;
}>;
export type NormalizeReviewE2e = (
  draft: Record<string, unknown>,
  metadata: ReviewSubmissionMetadata,
) => Record<string, unknown> | Promise<Record<string, unknown>>;

export type ReviewSubmissionController = Readonly<{
  tools: ToolDefinition[];
  result(): unknown | null;
  findingSnapshot(): ReviewFindingLedgerSnapshot;
  terminologySnapshot(): TerminologyLedgerSnapshot;
  finalize(): void;
  discard(): void;
}>;

type ModelFindingInput = CandidateFindingInput;
type RecordFindingsInput = Readonly<{ findings: readonly ModelFindingInput[] }>;

type DraftReceipt = {
  summary: Record<string, unknown>;
  terminologyReview: TerminologyCommitInput;
  acceptanceCoverage: Array<Record<string, unknown> & { findingId: string | null }>;
  securityCategories: Array<{
    category: string;
    verdict: "pass" | "warning" | "fail";
    justification: string;
    findingId: string | null;
  }>;
  sourceOfTruthReview: Array<Record<string, unknown> & { findingId: string | null }>;
  testDepth: ReviewTestDepth;
  positives: string[];
  reviewCompleteness: Record<string, unknown>;
};

export function createReviewSubmissionController({
  metadata,
  schema,
  terminologyTraces = new Map(),
  normalizeE2e,
  repositoryRoot,
  securityCategoryNames,
}: {
  metadata: ReviewSubmissionMetadata;
  schema: Record<string, unknown>;
  terminologyTraces?:
    | ReadonlyMap<string, TerminologyTrace>
    | (() => ReadonlyMap<string, TerminologyTrace>);
  normalizeE2e: NormalizeReviewE2e;
  repositoryRoot: string;
  securityCategoryNames: readonly string[];
}): ReviewSubmissionController {
  let findingsDraft: ModelFindingInput[] | null = null;
  let findingsRevision = 0;
  let receiptDraft: DraftReceipt | null = null;
  let receiptFindingsRevision: number | null = null;
  let e2eDraft: Record<string, unknown> | null = null;
  let pending: Readonly<{
    result: unknown;
    findingSnapshot: ReviewFindingLedgerSnapshot;
    terminologySnapshot: TerminologyLedgerSnapshot;
  }> | null = null;
  let submitted: unknown | null = null;
  let findingSnapshot = validateReviewFindingSubmission([], repositoryRoot);
  let terminologySnapshot = createTerminologyLedger(metadata.headSha).snapshot();
  const reviewReceiptSchema = createReviewReceiptSchema(securityCategoryNames);
  const validate = new Ajv2020({ allErrors: true, strict: false }).compile(schema);

  const recordFindings = defineTool({
    name: RECORD_FINDINGS_TOOL,
    label: "Record review findings draft",
    description:
      "Replace the complete in-memory findings draft, advance its revision, and return that revision with the ordered stable draft IDs. This invalidates any earlier review receipt. Use the returned IDs in a subsequent review receipt. Canonical state changes only after the session runner accepts the successful terminal submission.",
    parameters: Type.Object(
      { findings: Type.Array(findingSchema, { maxItems: REVIEW_FINDING_LIMIT }) },
      { additionalProperties: false },
    ),
    executionMode: "sequential",
    execute: async (_id, input) => {
      ensureOpen(pending ?? submitted);
      const draft = input as RecordFindingsInput;
      findingsDraft = draft.findings.map((finding) => structuredClone(finding));
      findingsRevision += 1;
      return toolResult({
        findingsRevision,
        findings: findingsDraft.map((finding, index) => ({
          id: draftFindingId(index),
          title: finding.title,
          category: finding.category,
          basisKind: finding.basis.kind,
        })),
      });
    },
  });
  const recordReceipt = defineTool({
    name: RECORD_REVIEW_RECEIPT_TOOL,
    label: "Record review receipt draft",
    description:
      "After record_findings, replace the complete in-memory review receipt draft and bind it to the current findings revision without changing canonical state. Recording findings again makes this receipt stale until it is rerecorded.",
    parameters: reviewReceiptSchema,
    executionMode: "sequential",
    execute: async (_id, input) => {
      ensureOpen(pending ?? submitted);
      if (findingsDraft === null) {
        throw new Error("record_review_receipt requires record_findings first");
      }
      receiptDraft = structuredClone(input as DraftReceipt);
      receiptFindingsRevision = findingsRevision;
      return toolResult({ recorded: "review_receipt", findingsRevision });
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
      ensureOpen(pending ?? submitted);
      e2eDraft = structuredClone(input as Record<string, unknown>);
      return toolResult({ recorded: "e2e" });
    },
  });
  const submitReview = defineTool({
    name: SUBMIT_REVIEW_TOOL,
    label: "Submit complete PR review",
    description:
      "Validate every draft section, assemble pending canonical state, and end the turn. The session runner commits that state only after accepting the complete terminal flow.",
    parameters: Type.Object({}, { additionalProperties: false }),
    executionMode: "sequential",
    execute: async () => {
      ensureOpen(pending ?? submitted);
      const missing = [
        findingsDraft === null ? "findings" : null,
        receiptDraft === null
          ? "review receipt"
          : receiptFindingsRevision !== findingsRevision
            ? "review receipt (missing or stale for current findings revision)"
            : null,
        e2eDraft === null ? "E2E recommendations" : null,
      ].filter(Boolean);
      if (missing.length > 0) throw new Error(`submit_review requires: ${missing.join(", ")}`);

      validateReceiptFindingReferences(receiptDraft!, findingsDraft!);
      const candidateFindingSnapshot = validateReviewFindingSubmission(
        findingsDraft!,
        repositoryRoot,
      );
      const openFindings = candidateFindingSnapshot.findings.filter(
        (finding) => finding.status === "open",
      );
      validateSecurityCategories(receiptDraft!.securityCategories, securityCategoryNames);
      const summary = canonicalSummary(receiptDraft!.summary, openFindings);
      const normalizedE2e = await normalizeE2e(structuredClone(e2eDraft!), metadata);
      const candidateTerminology = createTerminologyLedger(metadata.headSha);
      const traces =
        typeof terminologyTraces === "function" ? terminologyTraces() : terminologyTraces;
      candidateTerminology.commit(receiptDraft!.terminologyReview, traces);
      const publicReceipt = publicReceiptDraft(receiptDraft!, metadata.deterministic.testDepth);
      const result = {
        version: 1,
        baseRef: metadata.baseRef,
        headRef: metadata.headRef,
        headSha: metadata.headSha,
        changedFiles: [...metadata.changedFiles],
        ...publicReceipt,
        summary,
        findings: openFindings.map(publicFinding),
        terminologyReview: candidateTerminology.snapshot().review,
        e2e: normalizedE2e,
      };
      const qualityIssues = reviewQualityIssues({
        findings: openFindings,
        securityCategories: receiptDraft!.securityCategories,
      });
      if (qualityIssues.length > 0) {
        throw new Error(
          `submit_review result failed review quality validation: ${qualityIssues.join("; ")}`,
        );
      }
      if (!validate(result)) {
        const reason = (validate.errors ?? [])
          .map((error) => `${error.instancePath || "/"} ${error.message}`)
          .join("; ");
        throw new Error(`submit_review result does not match the public schema: ${reason}`);
      }
      pending = Object.freeze({
        result: structuredClone(result),
        findingSnapshot: candidateFindingSnapshot,
        terminologySnapshot: candidateTerminology.snapshot(),
      });
      return toolResult({ validated: true, pending: true }, true);
    },
  });

  return {
    tools: [recordFindings, recordReceipt, recommendE2e, submitReview],
    result: () => structuredClone(submitted),
    findingSnapshot: () => findingSnapshot,
    terminologySnapshot: () => terminologySnapshot,
    finalize: () => {
      if (!pending) throw new Error("submit_review has no validated pending state to finalize");
      if (submitted !== null) throw new Error("submit_review pending state was already finalized");
      submitted = structuredClone(pending.result);
      findingSnapshot = pending.findingSnapshot;
      terminologySnapshot = pending.terminologySnapshot;
      pending = null;
    },
    discard: () => {
      pending = null;
      submitted = null;
      findingSnapshot = validateReviewFindingSubmission([], repositoryRoot);
      terminologySnapshot = createTerminologyLedger(metadata.headSha).snapshot();
    },
  };
}

function validateSecurityCategories(
  categories: unknown[],
  securityCategoryNames: readonly string[],
): void {
  const names = categories.map((value) => (value as { category?: unknown }).category);
  const missing = securityCategoryNames.filter((name) => !names.includes(name));
  const seen = new Set<unknown>();
  const extras = names.filter((name) => {
    const duplicate = seen.has(name);
    seen.add(name);
    return !securityCategoryNames.includes(String(name)) || duplicate;
  });
  if (missing.length > 0 || extras.length > 0) {
    throw new Error(
      `securityCategories must contain each named category exactly once; missing: ${missing.join(", ") || "none"}; unsupported or duplicate: ${extras.join(", ") || "none"}`,
    );
  }
}

export const ACCEPTANCE_FINDING_REFERENCE_PAIRS = [
  ["acceptance", "unmet_acceptance"],
  ["correctness", "behavior_mismatch"],
  ["tests", "missing_regression"],
  ["architecture", "behavior_mismatch"],
  ["scope", "unmet_acceptance"],
] as const;

export const SECURITY_FINDING_REFERENCE_PAIRS = [
  ["security", "security_violation"],
  ["security", "semantic_ambiguity"],
] as const;

const ACCEPTANCE_FINDING_PAIRS: ReadonlySet<string> = new Set(
  ACCEPTANCE_FINDING_REFERENCE_PAIRS.map(([category, basisKind]) => `${category}:${basisKind}`),
);
const SECURITY_FINDING_PAIRS: ReadonlySet<string> = new Set(
  SECURITY_FINDING_REFERENCE_PAIRS.map(([category, basisKind]) => `${category}:${basisKind}`),
);

const SOURCE_OF_TRUTH_FINDING_CATEGORIES = new Set([
  "correctness",
  "security",
  "architecture",
  "scope",
  "tests",
]);

function findingPair(finding: CandidateFindingInput): string {
  return `${finding.category}:${finding.basis.kind}`;
}

function validateReceiptFindingReferences(
  receipt: DraftReceipt,
  findings: readonly CandidateFindingInput[],
): void {
  const findingsById = new Map(findings.map((finding, index) => [draftFindingId(index), finding]));
  validateConcernEntries(
    "acceptanceCoverage",
    receipt.acceptanceCoverage,
    findingsById,
    (entry) => entry.status === "partial" || entry.status === "missing",
    (finding) => ACCEPTANCE_FINDING_PAIRS.has(findingPair(finding)),
    (entry) => (entry.status === "missing" ? "blocker" : "warning"),
  );
  validateConcernEntries(
    "securityCategories",
    receipt.securityCategories,
    findingsById,
    (entry) => entry.verdict === "warning" || entry.verdict === "fail",
    (finding) => SECURITY_FINDING_PAIRS.has(findingPair(finding)),
    (entry) => (entry.verdict === "fail" ? "blocker" : "warning"),
  );
  validateConcernEntries(
    "sourceOfTruthReview",
    receipt.sourceOfTruthReview,
    findingsById,
    (entry) => entry.status === "needs_followup" || entry.status === "missing",
    (finding) => SOURCE_OF_TRUTH_FINDING_CATEGORIES.has(finding.category),
  );
}

function validateConcernEntries(
  section: string,
  entries: readonly unknown[],
  findingsById: ReadonlyMap<string, CandidateFindingInput>,
  requiresFinding: (entry: Record<string, unknown>) => boolean,
  fitsConcern: (finding: CandidateFindingInput) => boolean,
  minimumSeverity?: (entry: Record<string, unknown>) => (typeof REVIEW_FINDING_SEVERITIES)[number],
): void {
  for (const [index, rawEntry] of entries.entries()) {
    const entry = rawEntry as Record<string, unknown>;
    const required = requiresFinding(entry);
    const findingId = entry.findingId;
    if (!required && findingId !== null)
      throw new Error(`${section}[${index + 1}] must use findingId=null`);
    if (required && typeof findingId !== "string")
      throw new Error(`${section}[${index + 1}] must reference a fitting finding ID`);
    if (typeof findingId !== "string") continue;
    const finding = findingsById.get(findingId);
    if (!finding)
      throw new Error(`${section}[${index + 1}] references unknown finding ${findingId}`);
    if (!fitsConcern(finding))
      throw new Error(
        `${section}[${index + 1}] references finding ${findingId}, which does not fit this concern`,
      );
    if (!minimumSeverity) continue;
    const requiredSeverity = minimumSeverity(entry);
    const actualRank = REVIEW_FINDING_SEVERITIES.indexOf(finding.severity);
    const requiredRank = REVIEW_FINDING_SEVERITIES.indexOf(requiredSeverity);
    if (actualRank > requiredRank) {
      throw new Error(
        `${section}[${index + 1}] references ${findingId} with severity ${finding.severity}; ${String(entry.status ?? entry.verdict)} requires ${requiredSeverity}${requiredSeverity === "warning" ? " or blocker" : ""}`,
      );
    }
  }
}

function draftFindingId(index: number): string {
  return `F-${String(index + 1).padStart(3, "0")}`;
}

function publicReceiptDraft(receipt: DraftReceipt, deterministicTestDepth: ReviewTestDepth) {
  return {
    ...receipt,
    acceptanceCoverage: receipt.acceptanceCoverage.map(stripDraftFindingId),
    securityCategories: receipt.securityCategories.map(stripDraftFindingId),
    testDepth: enforceDeterministicTestDepthFloor(receipt.testDepth, deterministicTestDepth),
  };
}

function stripDraftFindingId(value: unknown): Record<string, unknown> {
  const { findingId: _findingId, ...publicValue } = value as Record<string, unknown>;
  return publicValue;
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
  const orderedFindings = REVIEW_FINDING_SEVERITIES.flatMap((severity) =>
    findings.filter((finding) => finding.severity === severity),
  );
  const counts = REVIEW_FINDING_SEVERITIES.map(
    (severity) => findings.filter((finding) => finding.severity === severity).length,
  );
  const topItem = orderedFindings[0]?.title;
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
  return {
    ...rest,
    evidence: evidence.join("\n"),
  };
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
