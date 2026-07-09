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

  apply(operation: LedgerOperation, stage: string): ReviewFindingLedgerSnapshot {
    const activeStage = nonempty(stage, "stage");
    if (operation.operation === "none") {
      this.#record(operation, activeStage, null, []);
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
      this.#record(operation, activeStage, id, finding.evidence);
      return this.snapshot();
    }

    const current = this.#open(operation.id);
    const addedEvidence = newEvidence(current.evidence, operation.evidence);
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
    }
    this.#record(operation, activeStage, current.id, addedEvidence);
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

  #record(
    operation: LedgerOperation,
    stage: string,
    id: string | null,
    addedEvidence: readonly string[],
  ): void {
    this.#history.push(
      Object.freeze({
        revision: this.#history.length + 1,
        operation: operation.operation,
        id,
        stage,
        reason: "reason" in operation ? operation.reason?.trim() || null : null,
        addedEvidence: Object.freeze([...addedEvidence]),
        change: structuredClone(ledgerChange(operation)),
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
const operationSchema = Type.Union([
  Type.Object({ operation: Type.Literal("none"), reason: string }),
  Type.Object({
    operation: Type.Literal("add"),
    reason: Type.Optional(string),
    finding: Type.Object({ ...findingFields, evidence }),
  }),
  Type.Object({
    operation: Type.Literal("update"),
    id: string,
    patch: Type.Partial(Type.Object(findingFields)),
    reason: Type.Optional(string),
    evidence: Type.Optional(evidence),
  }),
  Type.Object({ operation: Type.Literal("resolve"), id: string, reason: string, evidence }),
  Type.Object({
    operation: Type.Literal("supersede"),
    id: string,
    supersededBy: string,
    reason: string,
    evidence,
  }),
]);

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
      "Add, update, resolve, or supersede an evidence-backed finding. Use operation=none when this stage found no changes.",
    parameters: operationSchema,
    executionMode: "sequential",
    execute: async (_id, operation) =>
      ledgerResult(ledger.apply(operation as LedgerOperation, stage), true),
  });
  const read = defineTool({
    name: REVIEW_LEDGER_READ_TOOL,
    label: "Read review finding ledger",
    description: "Read the canonical finding ledger for final synthesis.",
    parameters: Type.Object({}),
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

function ledgerResult(snapshot: ReviewFindingLedgerSnapshot, terminate = false) {
  return {
    content: [
      {
        type: "text" as const,
        text: JSON.stringify({
          version: snapshot.version,
          revision: snapshot.revision,
          findings: snapshot.findings,
        }),
      },
    ],
    details: { revision: snapshot.revision },
    terminate,
  };
}

function ledgerChange(operation: LedgerOperation): unknown {
  if (operation.operation === "none") return null;
  if (operation.operation === "add") return operation.finding;
  if (operation.operation === "update") return operation.patch;
  return {
    status: operation.operation === "resolve" ? "resolved" : "superseded",
    ...(operation.operation === "supersede" ? { supersededBy: operation.supersededBy } : {}),
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
  const result = { ...patch };
  for (const key of [
    "title",
    "description",
    "impact",
    "recommendation",
    "verificationHint",
    "missingRegressionTest",
  ] as const) {
    if (result[key] !== undefined) result[key] = nonempty(result[key], key);
  }
  if (result.file !== undefined && result.file !== null)
    result.file = nonempty(result.file, "file");
  return result;
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
