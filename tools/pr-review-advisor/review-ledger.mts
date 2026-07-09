// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { defineTool, type ToolDefinition } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

export const REVIEW_LEDGER_UPDATE_TOOL = "pr_review_update_ledger";
export const REVIEW_LEDGER_READ_TOOL = "pr_review_read_ledger";

const SEVERITIES = ["blocker", "warning", "suggestion"] as const;
const CATEGORIES = [
  "security",
  "correctness",
  "tests",
  "architecture",
  "workflow",
  "docs",
  "scope",
  "acceptance",
] as const;
const SIMPLIFICATION_TAGS = ["delete", "stdlib", "native", "yagni", "shrink"] as const;

type Severity = (typeof SEVERITIES)[number];
type Category = (typeof CATEGORIES)[number];
type SimplificationTag = (typeof SIMPLIFICATION_TAGS)[number];

export type ReviewFinding = Readonly<{
  id: string;
  status: "open" | "resolved" | "superseded";
  supersededBy: string | null;
  severity: Severity;
  category: Category;
  file: string | null;
  line: number | null;
  title: string;
  description: string;
  impact: string;
  recommendation: string;
  verificationHint: string;
  missingRegressionTest: string;
  evidence: readonly string[];
  simplification?: Readonly<{
    tag: SimplificationTag;
    cut: string;
    replacement: string;
    estimatedNetLines: number | null;
    safetyBoundary: string;
  }>;
}>;

type FindingInput = Omit<ReviewFinding, "id" | "status" | "supersededBy">;
type FindingPatch = Partial<Omit<FindingInput, "evidence">>;
type LedgerOperation =
  | { operation: "none"; reason: string }
  | { operation: "add"; reason?: string; finding: FindingInput }
  | { operation: "update"; id: string; patch: FindingPatch; reason?: string; evidence?: string[] }
  | { operation: "resolve"; id: string; reason: string; evidence: string[] }
  | {
      operation: "supersede";
      id: string;
      supersededBy: string;
      reason: string;
      evidence: string[];
    };

type LedgerBatchInput = Readonly<{
  operations: readonly LedgerOperation[];
}>;

type LedgerHistory = Readonly<{
  revision: number;
  operation: LedgerOperation["operation"];
  id: string | null;
  stage: string;
  reason: string | null;
  addedEvidence: readonly string[];
  change: unknown;
}>;

export type ReviewFindingLedgerSnapshot = Readonly<{
  version: 1;
  revision: number;
  findings: readonly ReviewFinding[];
  history: readonly LedgerHistory[];
}>;

export class ReviewFindingLedger {
  readonly #findings = new Map<string, ReviewFinding>();
  readonly #history: LedgerHistory[] = [];
  #nextId = 1;

  #applyOperation(operation: LedgerOperation, stage: string): ReviewFindingLedgerSnapshot {
    const activeStage = nonempty(stage, "stage");
    if (operation.operation === "none") {
      this.#record(operation, activeStage, null, [], null);
      return this.snapshot();
    }
    if (operation.operation === "add") {
      const finding = normalizeFinding(operation.finding);
      const id = `F-${String(this.#nextId).padStart(3, "0")}`;
      this.#nextId += 1;
      this.#findings.set(
        id,
        freezeFinding({
          ...finding,
          id,
          status: "open",
          supersededBy: null,
        }),
      );
      this.#record(operation, activeStage, id, finding.evidence, finding);
      return this.snapshot();
    }

    const current = this.#open(operation.id);
    const addedEvidence = newEvidence(current.evidence, operation.evidence);
    let change: unknown;
    if (operation.operation === "update") {
      const patch = normalizePatch(operation.patch);
      const reclassifies =
        (patch.severity !== undefined && patch.severity !== current.severity) ||
        (patch.category !== undefined && patch.category !== current.category);
      const changesConclusion = Object.entries(patch).some(
        ([key, value]) =>
          JSON.stringify(current[key as keyof ReviewFinding]) !== JSON.stringify(value),
      );
      if (reclassifies && activeStage !== "reconcile-findings") {
        throw new Error(`Only reconcile-findings may reclassify ${current.id}`);
      }
      if (changesConclusion) requireSupport(operation.reason, addedEvidence, current.id);
      const next = freezeFinding({
        ...current,
        ...patch,
        evidence: [...current.evidence, ...addedEvidence],
      });
      if (JSON.stringify(next) === JSON.stringify(current)) {
        throw new Error(`Update for ${current.id} changes nothing`);
      }
      this.#findings.set(current.id, next);
      change = patch;
    } else {
      if (activeStage !== "reconcile-findings") {
        throw new Error(`Only reconcile-findings may ${operation.operation} ${current.id}`);
      }
      requireSupport(operation.reason, addedEvidence, current.id);
      const supersededBy = operation.operation === "supersede" ? operation.supersededBy : null;
      if (supersededBy === current.id) throw new Error(`${current.id} cannot supersede itself`);
      if (supersededBy) this.#open(supersededBy);
      this.#findings.set(
        current.id,
        freezeFinding({
          ...current,
          evidence: [...current.evidence, ...addedEvidence],
          status: operation.operation === "resolve" ? "resolved" : "superseded",
          supersededBy,
        }),
      );
      change = {
        status: operation.operation === "resolve" ? "resolved" : "superseded",
        ...(operation.operation === "supersede" ? { supersededBy: operation.supersededBy } : {}),
      };
    }
    this.#record(operation, activeStage, current.id, addedEvidence, change);
    return this.snapshot();
  }

  applyBatch(operations: readonly LedgerOperation[], stage: string): ReviewFindingLedgerSnapshot {
    const activeStage = nonempty(stage, "stage");
    if (operations.length === 0) throw new Error("Ledger update requires at least one operation");
    const noChangeOperations = operations.filter((operation) => operation.operation === "none");
    if (noChangeOperations.length > 0 && operations.length !== 1) {
      throw new Error("operation=none must be the only ledger operation in a batch");
    }

    const candidate = this.#clone();
    for (const operation of operations) candidate.#applyOperation(operation, activeStage);
    this.#findings.clear();
    for (const [id, finding] of candidate.#findings) this.#findings.set(id, finding);
    this.#history.splice(0, this.#history.length, ...candidate.#history);
    this.#nextId = candidate.#nextId;
    return this.snapshot();
  }

  snapshot(): ReviewFindingLedgerSnapshot {
    return Object.freeze({
      version: 1,
      revision: this.#history.length,
      findings: Object.freeze([...this.#findings.values()]),
      history: Object.freeze([...this.#history]),
    });
  }

  #open(id: string): ReviewFinding {
    const finding = this.#findings.get(id);
    if (!finding) throw new Error(`Finding ${id} does not exist`);
    if (finding.status !== "open") throw new Error(`Finding ${id} is already ${finding.status}`);
    return finding;
  }

  #clone(): ReviewFindingLedger {
    const clone = new ReviewFindingLedger();
    for (const [id, finding] of this.#findings) clone.#findings.set(id, finding);
    clone.#history.push(...this.#history);
    clone.#nextId = this.#nextId;
    return clone;
  }

  #record(
    operation: LedgerOperation,
    stage: string,
    id: string | null,
    addedEvidence: readonly string[],
    change: unknown,
  ): void {
    this.#history.push(
      Object.freeze({
        revision: this.#history.length + 1,
        operation: operation.operation,
        id,
        stage,
        reason: "reason" in operation ? operation.reason?.trim() || null : null,
        addedEvidence: Object.freeze([...addedEvidence]),
        change: structuredClone(change),
      }),
    );
  }
}

export function createReviewFindingLedger(): ReviewFindingLedger {
  return new ReviewFindingLedger();
}

const string = Type.String({ minLength: 1 });
const severity = Type.Union(SEVERITIES.map((value) => Type.Literal(value)));
const category = Type.Union(CATEGORIES.map((value) => Type.Literal(value)));
const evidence = Type.Array(string, { minItems: 1 });
const simplification = Type.Object(
  {
    tag: Type.Union(SIMPLIFICATION_TAGS.map((value) => Type.Literal(value))),
    cut: string,
    replacement: string,
    estimatedNetLines: Type.Union([Type.Integer(), Type.Null()]),
    safetyBoundary: string,
  },
  { additionalProperties: false },
);
const findingFields = {
  severity,
  category,
  file: Type.Union([string, Type.Null()]),
  line: Type.Union([Type.Integer({ minimum: 1 }), Type.Null()]),
  title: string,
  description: string,
  impact: string,
  recommendation: string,
  verificationHint: string,
  missingRegressionTest: string,
  simplification: Type.Optional(simplification),
};
const findingSchema = Type.Object({ ...findingFields, evidence }, { additionalProperties: false });
const patchSchema = Type.Partial(Type.Object(findingFields), { additionalProperties: false });
const operationSchema = Type.Union([
  Type.Object({ operation: Type.Literal("none"), reason: string }, { additionalProperties: false }),
  Type.Object(
    {
      operation: Type.Literal("add"),
      reason: Type.Optional(string),
      finding: findingSchema,
    },
    { additionalProperties: false },
  ),
  Type.Object(
    {
      operation: Type.Literal("update"),
      id: string,
      patch: patchSchema,
      reason: Type.Optional(string),
      evidence: Type.Optional(evidence),
    },
    { additionalProperties: false },
  ),
  Type.Object(
    { operation: Type.Literal("resolve"), id: string, reason: string, evidence },
    { additionalProperties: false },
  ),
  Type.Object(
    {
      operation: Type.Literal("supersede"),
      id: string,
      supersededBy: string,
      reason: string,
      evidence,
    },
    { additionalProperties: false },
  ),
]);
const operationBatchSchema = Type.Object(
  {
    operations: Type.Array(operationSchema, { minItems: 1 }),
  },
  { additionalProperties: false },
);

export type ReviewLedgerToolController = {
  tools: ToolDefinition[];
  setStage(stage: string): void;
};

export function createReviewLedgerToolController(
  ledger: ReviewFindingLedger,
): ReviewLedgerToolController {
  let stage = "";
  const update = defineTool({
    name: REVIEW_LEDGER_UPDATE_TOOL,
    label: "Update review finding ledger",
    description:
      "Submit every add, update, resolve, or supersede operation discovered by this stage in one atomic batch. Use one operation=none entry when this stage found no changes.",
    parameters: operationBatchSchema,
    executionMode: "sequential",
    execute: async (_id, input) =>
      ledgerResult(ledger.applyBatch((input as LedgerBatchInput).operations, stage), true),
  });
  const read = defineTool({
    name: REVIEW_LEDGER_READ_TOOL,
    label: "Read review finding ledger",
    description: "Read the canonical finding ledger for final synthesis.",
    parameters: Type.Object({}, { additionalProperties: false }),
    executionMode: "sequential",
    execute: async () => ledgerResult(ledger.snapshot()),
  });
  return {
    tools: [update, read],
    setStage(value: string) {
      stage = nonempty(value, "stage");
    },
  };
}

function ledgerResult(
  snapshot: ReviewFindingLedgerSnapshot,
  terminate = false,
  findings: readonly ReviewFinding[] = snapshot.findings.filter(
    (finding) => finding.status === "open",
  ),
) {
  return {
    content: [
      {
        type: "text" as const,
        text: JSON.stringify({
          version: snapshot.version,
          revision: snapshot.revision,
          findings,
        }),
      },
    ],
    details: { revision: snapshot.revision },
    terminate,
  };
}

function normalizeFinding(finding: FindingInput): FindingInput {
  return {
    ...normalizePatch(finding),
    severity: finding.severity,
    category: finding.category,
    file: finding.file === null ? null : nonempty(finding.file, "file"),
    line: finding.line,
    title: nonempty(finding.title, "title"),
    description: nonempty(finding.description, "description"),
    impact: nonempty(finding.impact, "impact"),
    recommendation: nonempty(finding.recommendation, "recommendation"),
    verificationHint: nonempty(finding.verificationHint, "verificationHint"),
    missingRegressionTest: nonempty(finding.missingRegressionTest, "missingRegressionTest"),
    evidence: normalizeEvidence(finding.evidence),
  };
}

function normalizePatch(patch: FindingPatch): FindingPatch {
  return {
    ...(patch.severity === undefined ? {} : { severity: patch.severity }),
    ...(patch.category === undefined ? {} : { category: patch.category }),
    ...(patch.file === undefined
      ? {}
      : { file: patch.file === null ? null : nonempty(patch.file, "file") }),
    ...(patch.line === undefined ? {} : { line: patch.line }),
    ...(patch.title === undefined ? {} : { title: nonempty(patch.title, "title") }),
    ...(patch.description === undefined
      ? {}
      : { description: nonempty(patch.description, "description") }),
    ...(patch.impact === undefined ? {} : { impact: nonempty(patch.impact, "impact") }),
    ...(patch.recommendation === undefined
      ? {}
      : { recommendation: nonempty(patch.recommendation, "recommendation") }),
    ...(patch.verificationHint === undefined
      ? {}
      : { verificationHint: nonempty(patch.verificationHint, "verificationHint") }),
    ...(patch.missingRegressionTest === undefined
      ? {}
      : {
          missingRegressionTest: nonempty(patch.missingRegressionTest, "missingRegressionTest"),
        }),
    ...(patch.simplification === undefined
      ? {}
      : { simplification: normalizeSimplification(patch.simplification) }),
  };
}

function normalizeSimplification(
  value: NonNullable<FindingPatch["simplification"]>,
): NonNullable<FindingPatch["simplification"]> {
  return {
    tag: value.tag,
    cut: nonempty(value.cut, "simplification.cut"),
    replacement: nonempty(value.replacement, "simplification.replacement"),
    estimatedNetLines: value.estimatedNetLines,
    safetyBoundary: nonempty(value.safetyBoundary, "simplification.safetyBoundary"),
  };
}

function normalizeEvidence(values: readonly string[]): string[] {
  return [...new Set(values.map((value) => nonempty(value, "evidence")))];
}

function newEvidence(existing: readonly string[], values: readonly string[] | undefined): string[] {
  const known = new Set(existing);
  return normalizeEvidence(values ?? []).filter((value) => !known.has(value));
}

function requireSupport(reason: string | undefined, evidence: readonly string[], id: string): void {
  if (!reason?.trim()) throw new Error(`Conclusion change for ${id} requires a reason`);
  if (evidence.length === 0) throw new Error(`Conclusion change for ${id} requires new evidence`);
}

function freezeFinding(finding: ReviewFinding): ReviewFinding {
  return Object.freeze({ ...finding, evidence: Object.freeze([...finding.evidence]) });
}

function nonempty(value: string, name: string): string {
  if (!value?.trim()) throw new Error(`${name} must be nonempty`);
  return value.trim();
}
