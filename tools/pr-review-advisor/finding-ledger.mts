// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";

import { defineTool, type ToolDefinition } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

import type { AdvisorInterest } from "./specialist-catalog.mts";

export const RECORD_ADVISOR_FINDINGS_TOOL = "pr_review_record_findings";
export const MAX_FINDINGS_PER_SPECIALIST = 20;
export const MAX_FINDING_LEDGER_BYTES = 512 * 1024;

export const ADVISOR_FINDING_EXCLUSIONS = [
  "ambiguous-intent",
  "author-attestation",
  "commit-verification",
  "credential-access",
  "dco",
  "dependency-change",
  "external-mutation",
  "maintainer-decision",
  "product-scope",
  "security-sensitive",
  "unsupported-path",
] as const;

export const ADVISOR_FINDING_KINDS = [
  "behavior",
  "code-quality",
  "correctness",
  "dependency",
  "design",
  "documentation",
  "migration",
  "operations",
  "product-scope",
  "security",
  "test-design",
] as const;

export const ADVISOR_FINDING_SEVERITIES = ["P0", "P1"] as const;

export type AdvisorFindingExclusion = (typeof ADVISOR_FINDING_EXCLUSIONS)[number];
export type AdvisorFindingKind = (typeof ADVISOR_FINDING_KINDS)[number];
export type AdvisorFindingSeverity = (typeof ADVISOR_FINDING_SEVERITIES)[number];

export type AdvisorFinding = Readonly<{
  id: string;
  interest: AdvisorInterest;
  severity: AdvisorFindingSeverity;
  kind: AdvisorFindingKind;
  summary: string;
  path: string;
  line: number | null;
  impact: string;
  smallestSafeFix: string;
  regressionTest: string;
  exclusions: readonly AdvisorFindingExclusion[];
}>;

export type AdvisorFindingLedger = Readonly<{
  version: 1;
  revision: 1;
  identity: "exact-head";
  headSha: string;
  interest: AdvisorInterest;
  status: "clear" | "findings";
  findings: readonly AdvisorFinding[];
  noFindingsReason: string | null;
}>;

type FindingInput = Omit<AdvisorFinding, "id" | "interest">;

type FindingCommitInput = Readonly<{
  findings: readonly FindingInput[];
  noFindingsReason: string | null;
}>;

export type AdvisorFindingToolController = Readonly<{
  tools: ToolDefinition[];
  snapshot(): AdvisorFindingLedger;
}>;

const findingSchema = Type.Object(
  {
    severity: Type.Union(ADVISOR_FINDING_SEVERITIES.map((value) => Type.Literal(value))),
    kind: Type.Union(ADVISOR_FINDING_KINDS.map((value) => Type.Literal(value))),
    summary: Type.String({ minLength: 1, maxLength: 500 }),
    path: Type.String({ minLength: 1, maxLength: 512 }),
    line: Type.Union([Type.Integer({ minimum: 1 }), Type.Null()]),
    impact: Type.String({ minLength: 1, maxLength: 1000 }),
    smallestSafeFix: Type.String({ minLength: 1, maxLength: 1000 }),
    regressionTest: Type.String({ minLength: 1, maxLength: 1000 }),
    exclusions: Type.Array(
      Type.Union(ADVISOR_FINDING_EXCLUSIONS.map((value) => Type.Literal(value))),
      { maxItems: ADVISOR_FINDING_EXCLUSIONS.length, uniqueItems: true },
    ),
  },
  { additionalProperties: false },
);

const commitSchema = Type.Object(
  {
    findings: Type.Array(findingSchema, { maxItems: MAX_FINDINGS_PER_SPECIALIST }),
    noFindingsReason: Type.Union([Type.String({ minLength: 1, maxLength: 1000 }), Type.Null()]),
  },
  { additionalProperties: false },
);

export function createAdvisorFindingToolController(input: {
  headSha: string;
  interest: AdvisorInterest;
}): AdvisorFindingToolController {
  const headSha = fullSha(input.headSha, "headSha");
  const interest = input.interest;
  let ledger: AdvisorFindingLedger | undefined;
  const recordFindings = defineTool({
    name: RECORD_ADVISOR_FINDINGS_TOOL,
    label: "Record exact-head Advisor blockers",
    description:
      "Commit the complete machine-readable blocker set for this specialist. Record only P0/P1 issues that require a repository change. Use an empty finding list and a concrete reason when no blocker remains.",
    parameters: commitSchema,
    executionMode: "sequential",
    execute: async (_id, rawInput) => {
      if (ledger) throw new Error("Advisor finding ledger already has a committed receipt");
      ledger = buildAdvisorFindingLedger({
        headSha,
        interest,
        input: rawInput as FindingCommitInput,
      });
      return toolResult(ledger, true);
    },
  });
  return {
    tools: [recordFindings],
    snapshot() {
      if (!ledger) throw new Error("Advisor specialist did not commit its finding ledger");
      return ledger;
    },
  };
}

export function buildAdvisorFindingLedger(input: {
  headSha: string;
  interest: AdvisorInterest;
  input: FindingCommitInput;
}): AdvisorFindingLedger {
  const headSha = fullSha(input.headSha, "headSha");
  if (!Array.isArray(input.input.findings)) throw new Error("findings must be an array");
  if (input.input.findings.length > MAX_FINDINGS_PER_SPECIALIST) {
    throw new Error(`A specialist may record at most ${MAX_FINDINGS_PER_SPECIALIST} findings`);
  }
  if (input.input.findings.length === 0 && input.input.noFindingsReason === null) {
    throw new Error("An empty finding ledger requires noFindingsReason");
  }
  if (input.input.findings.length > 0 && input.input.noFindingsReason !== null) {
    throw new Error("noFindingsReason is mutually exclusive with findings");
  }

  const findings = input.input.findings.map((candidate): AdvisorFinding => {
    if (!ADVISOR_FINDING_SEVERITIES.includes(candidate.severity)) {
      throw new Error(`Unsupported finding severity ${String(candidate.severity)}`);
    }
    if (!ADVISOR_FINDING_KINDS.includes(candidate.kind)) {
      throw new Error(`Unsupported finding kind ${String(candidate.kind)}`);
    }
    const exclusions = [...candidate.exclusions];
    if (
      exclusions.length > ADVISOR_FINDING_EXCLUSIONS.length ||
      exclusions.some((value) => !ADVISOR_FINDING_EXCLUSIONS.includes(value)) ||
      new Set(exclusions).size !== exclusions.length
    ) {
      throw new Error("Finding exclusions are unsupported or duplicated");
    }
    const normalized = {
      interest: input.interest,
      severity: candidate.severity,
      kind: candidate.kind,
      summary: boundedText(candidate.summary, "summary", 500),
      path: safeEvidencePath(candidate.path),
      line: candidate.line === null ? null : positiveInteger(candidate.line, "line"),
      impact: boundedText(candidate.impact, "impact", 1000),
      smallestSafeFix: boundedText(candidate.smallestSafeFix, "smallestSafeFix", 1000),
      regressionTest: boundedText(candidate.regressionTest, "regressionTest", 1000),
      exclusions: [...exclusions].sort(),
    } as const;
    const id = `F-${input.interest}-${sha256(canonicalJson({ headSha, ...normalized })).slice(0, 20)}`;
    return Object.freeze({ id, ...normalized });
  });
  findings.sort((left, right) => left.id.localeCompare(right.id));
  if (new Set(findings.map(({ id }) => id)).size !== findings.length) {
    throw new Error("Advisor finding ledger contains duplicate canonical findings");
  }
  const noFindingsReason =
    findings.length === 0
      ? boundedText(input.input.noFindingsReason ?? "", "noFindingsReason", 1000)
      : null;
  return Object.freeze({
    version: 1,
    revision: 1,
    identity: "exact-head",
    headSha,
    interest: input.interest,
    status: findings.length > 0 ? "findings" : "clear",
    findings: Object.freeze(findings),
    noFindingsReason,
  });
}

export function parseAdvisorFindingLedger(
  value: unknown,
  expected: { headSha: string; interest: AdvisorInterest },
): AdvisorFindingLedger {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Advisor finding ledger must be an object");
  }
  const raw = value as Record<string, unknown>;
  exactKeys(
    raw,
    [
      "version",
      "revision",
      "identity",
      "headSha",
      "interest",
      "status",
      "findings",
      "noFindingsReason",
    ],
    "Advisor finding ledger",
  );
  if (
    raw.version !== 1 ||
    raw.revision !== 1 ||
    raw.identity !== "exact-head" ||
    raw.headSha !== expected.headSha ||
    raw.interest !== expected.interest
  ) {
    throw new Error("Advisor finding ledger identity does not match the exact specialist head");
  }
  if (!Array.isArray(raw.findings)) throw new Error("Advisor finding ledger findings are invalid");
  const rebuilt = buildAdvisorFindingLedger({
    headSha: expected.headSha,
    interest: expected.interest,
    input: {
      findings: raw.findings.map((value, index): FindingInput => {
        if (!value || typeof value !== "object" || Array.isArray(value)) {
          throw new Error(`Advisor finding ${index} must be an object`);
        }
        const finding = value as Record<string, unknown>;
        exactKeys(
          finding,
          [
            "id",
            "interest",
            "severity",
            "kind",
            "summary",
            "path",
            "line",
            "impact",
            "smallestSafeFix",
            "regressionTest",
            "exclusions",
          ],
          `Advisor finding ${index}`,
        );
        if (finding.interest !== expected.interest) {
          throw new Error(`Advisor finding ${index} interest does not match its ledger`);
        }
        return {
          severity: finding.severity as AdvisorFindingSeverity,
          kind: finding.kind as AdvisorFindingKind,
          summary: finding.summary as string,
          path: finding.path as string,
          line: finding.line as number | null,
          impact: finding.impact as string,
          smallestSafeFix: finding.smallestSafeFix as string,
          regressionTest: finding.regressionTest as string,
          exclusions: finding.exclusions as AdvisorFindingExclusion[],
        };
      }),
      noFindingsReason: raw.noFindingsReason as string | null,
    },
  });
  if (canonicalJson(raw) !== canonicalJson(rebuilt)) {
    throw new Error("Advisor finding ledger is not canonical");
  }
  return rebuilt;
}

export function writeAdvisorFindingLedger(
  outputDirectory: string,
  interest: AdvisorInterest,
  ledger: AdvisorFindingLedger,
): string {
  const file = path.join(outputDirectory, `pr-review-${interest}-findings.json`);
  const content = `${JSON.stringify(ledger, null, 2)}\n`;
  if (Buffer.byteLength(content, "utf8") > MAX_FINDING_LEDGER_BYTES) {
    throw new Error("Advisor finding ledger exceeds its size limit");
  }
  fs.writeFileSync(file, content, { flag: "wx", mode: 0o600 });
  return file;
}

export function advisorFindingLedgerDigest(ledgers: readonly AdvisorFindingLedger[]): string {
  const canonical = [...ledgers].sort((left, right) => left.interest.localeCompare(right.interest));
  return `sha256:${sha256(canonicalJson(canonical))}`;
}

function exactKeys(
  value: Record<string, unknown>,
  expected: readonly string[],
  label: string,
): void {
  const actual = Object.keys(value).sort();
  const sortedExpected = [...expected].sort();
  if (
    actual.length !== sortedExpected.length ||
    actual.some((key, index) => key !== sortedExpected[index])
  ) {
    throw new Error(`${label} has unsupported fields`);
  }
}

function safeEvidencePath(value: string): string {
  const result = boundedText(value, "path", 512);
  if (
    !/^[A-Za-z0-9._/-]+$/u.test(result) ||
    result.startsWith("/") ||
    result.endsWith("/") ||
    result.includes("//") ||
    path.posix.normalize(result) !== result ||
    result.split("/").some((segment) => segment === "." || segment === "..")
  ) {
    throw new Error("Finding path must be a normalized repository-relative path");
  }
  return result;
}

function boundedText(value: string, label: string, maximum: number): string {
  if (typeof value !== "string") throw new Error(`${label} must be a string`);
  const result = value.trim().replace(/\s+/gu, " ");
  if (
    !result ||
    Buffer.byteLength(result, "utf8") > maximum ||
    /[\u0000-\u001f\u007f]/u.test(result)
  ) {
    throw new Error(`${label} must be bounded printable text`);
  }
  return result;
}

function fullSha(value: string, label: string): string {
  if (!/^[0-9a-f]{40}$/u.test(value)) throw new Error(`${label} must be a full SHA`);
  return value;
}

function positiveInteger(value: number, label: string): number {
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new Error(`${label} must be a positive integer`);
  }
  return value;
}

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, item]) => `${JSON.stringify(key)}:${canonicalJson(item)}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function toolResult(value: unknown, terminate = false) {
  return {
    content: [{ type: "text" as const, text: JSON.stringify(value) }],
    details: {},
    ...(terminate ? { terminate } : {}),
  };
}
