// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { execFileSync, spawn } from "node:child_process";
import { createHash } from "node:crypto";

import { defineTool, type ToolDefinition } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

export const TERMINOLOGY_TRACE_TOOL = "pr_review_trace_term";

export const TERMINOLOGY_CHANGES = ["introduced", "expanded", "redefined"] as const;
export const TERMINOLOGY_DISPOSITIONS = [
  "established",
  "justified",
  "define",
  "replace",
  "conflict",
] as const;
export const TERMINOLOGY_SEMANTIC_IMPACTS = [
  "none",
  "behavior",
  "security",
  "support",
  "evidence",
  "test",
  "release",
] as const;
const TERM_LIMIT = 80;
const DECISION_LIMIT = 20;
const TRACE_LIMIT = 20;
const LOCATION_LIMIT = 40;
const SAMPLE_LIMIT = 20;
const GREP_SAMPLE_BUFFER_BYTES = 256 * 1024;
const DIFF_LINE_PREFIX_LIMIT = 16 * 1024;

type TerminologyChange = (typeof TERMINOLOGY_CHANGES)[number];
type TerminologyDisposition = (typeof TERMINOLOGY_DISPOSITIONS)[number];
type TerminologySemanticImpact = (typeof TERMINOLOGY_SEMANTIC_IMPACTS)[number];

export type TerminologyLocation = Readonly<{
  file: string;
  line: number;
  text: string;
}>;

export type TerminologyTrace = Readonly<{
  id: string;
  term: string;
  variants: readonly string[];
  baseSha: string;
  headSha: string;
  baseOccurrences: number;
  headOccurrences: number;
  baseEvidenceTruncated: boolean;
  headEvidenceTruncated: boolean;
  changedLocations: readonly TerminologyLocation[];
  baseSamples: readonly string[];
  headSamples: readonly string[];
  firstCommitSha: string | null;
}>;

export type TerminologyDecision = Readonly<{
  id: string;
  term: string;
  change: TerminologyChange;
  disposition: TerminologyDisposition;
  meaning: string;
  contrast: string | null;
  existingTerm: string | null;
  semanticImpact: TerminologySemanticImpact;
  recommendation: string;
  traceId: string;
  source: Readonly<{
    file: string;
    line: number;
    headSha: string;
  }>;
}>;

export type TerminologyReview = Readonly<{
  status: "clear" | "candidates" | "limited";
  decisions: readonly TerminologyDecision[];
  noChangesReason: string | null;
}>;

export type TerminologyLedgerSnapshot = Readonly<{
  version: 1;
  revision: number;
  headSha: string;
  review: TerminologyReview;
}>;

export type TerminologyDecisionInput = Omit<TerminologyDecision, "id" | "source"> & {
  source: { file: string; line: number };
};

export type TerminologyCommitInput = Readonly<{
  decisions: readonly TerminologyDecisionInput[];
  noChangesReason: string | null;
}>;

export class TerminologyLedger {
  readonly #headSha: string;
  #revision = 0;
  #review: TerminologyReview = Object.freeze({
    status: "limited",
    decisions: Object.freeze([]),
    noChangesReason: "Terminology review did not complete.",
  });

  constructor(headSha: string) {
    this.#headSha = nonempty(headSha, "headSha");
  }

  commit(input: TerminologyCommitInput, traces: ReadonlyMap<string, TerminologyTrace>): void {
    if (this.#revision !== 0) throw new Error("Terminology review already has a committed receipt");
    if (input.decisions.length > DECISION_LIMIT) {
      throw new Error(`Terminology review accepts at most ${DECISION_LIMIT} decisions`);
    }
    if (input.noChangesReason !== null && input.decisions.length > 0) {
      throw new Error("noChangesReason is mutually exclusive with terminology decisions");
    }
    if (input.decisions.length === 0 && input.noChangesReason === null) {
      throw new Error("An empty terminology receipt requires noChangesReason");
    }
    const seen = new Set<string>();
    const decisions = input.decisions.map((candidate, index): TerminologyDecision => {
      const trace = traces.get(nonempty(candidate.traceId, "traceId"));
      if (!trace) throw new Error(`Unknown terminology trace ${candidate.traceId}`);
      if (trace.headSha !== this.#headSha) {
        throw new Error(`Terminology trace ${trace.id} does not match the reviewed commit`);
      }
      const term = normalizeTerm(candidate.term);
      if (!TERMINOLOGY_CHANGES.includes(candidate.change))
        throw new Error(`Unsupported change ${candidate.change}`);
      if (!TERMINOLOGY_DISPOSITIONS.includes(candidate.disposition)) {
        throw new Error(`Unsupported disposition ${candidate.disposition}`);
      }
      if (!TERMINOLOGY_SEMANTIC_IMPACTS.includes(candidate.semanticImpact)) {
        throw new Error(`Unsupported semanticImpact ${candidate.semanticImpact}`);
      }
      if (term.toLocaleLowerCase() !== trace.term.toLocaleLowerCase()) {
        throw new Error(`Decision term ${term} does not match trace ${trace.id}`);
      }
      const file = nonempty(candidate.source.file, "source.file");
      const line = positiveInteger(candidate.source.line, "source.line");
      if (
        !trace.changedLocations.some((location) => location.file === file && location.line === line)
      ) {
        throw new Error(
          `Decision source ${file}:${line} is not a changed occurrence in ${trace.id}`,
        );
      }
      if (candidate.disposition === "justified" && !candidate.contrast?.trim()) {
        throw new Error("A justified term requires a concrete contrast");
      }
      if (candidate.disposition === "replace" && !candidate.existingTerm?.trim()) {
        throw new Error("A replacement decision requires existingTerm");
      }
      const key = `${term.toLocaleLowerCase()}\0${file}\0${line}`;
      if (seen.has(key)) throw new Error(`Duplicate terminology decision for ${file}:${line}`);
      seen.add(key);
      return Object.freeze({
        id: `T-${String(index + 1).padStart(3, "0")}`,
        term,
        change: candidate.change,
        disposition: candidate.disposition,
        meaning: nonempty(candidate.meaning, "meaning"),
        contrast: nullableText(candidate.contrast),
        existingTerm: nullableText(candidate.existingTerm),
        semanticImpact: candidate.semanticImpact,
        recommendation: nonempty(candidate.recommendation, "recommendation"),
        traceId: trace.id,
        source: Object.freeze({ file, line, headSha: this.#headSha }),
      });
    });
    this.#revision = 1;
    this.#review = Object.freeze({
      status: decisions.length > 0 ? "candidates" : "clear",
      decisions: Object.freeze(decisions),
      noChangesReason:
        decisions.length > 0 ? null : nonempty(input.noChangesReason ?? "", "noChangesReason"),
    });
  }

  snapshot(): TerminologyLedgerSnapshot {
    return Object.freeze({
      version: 1,
      revision: this.#revision,
      headSha: this.#headSha,
      review: this.#review,
    });
  }
}

export function createTerminologyLedger(headSha: string): TerminologyLedger {
  return new TerminologyLedger(headSha);
}

export type TerminologyToolController = {
  tools: ToolDefinition[];
  traces(): ReadonlyMap<string, TerminologyTrace>;
};

export function createTerminologyToolController({
  baseRef,
  headRef,
  cwd = process.cwd(),
}: {
  baseRef: string;
  headRef: string;
  cwd?: string;
}): TerminologyToolController {
  const traces = new Map<string, TerminologyTrace>();
  const selectedTerms = new Set<string>();
  const trace = defineTool({
    name: TERMINOLOGY_TRACE_TOOL,
    label: "Trace a selected repository term",
    description:
      "Trace one semantically selected term in the base and head commits, including changed lines. This tool verifies evidence; it does not select or classify terms.",
    parameters: Type.Object(
      { term: Type.String({ minLength: 1, maxLength: TERM_LIMIT }) },
      { additionalProperties: false },
    ),
    executionMode: "sequential",
    execute: async (_id, input) => {
      const term = normalizeTerm((input as { term: string }).term);
      const key = term.toLocaleLowerCase();
      if (!selectedTerms.has(key) && selectedTerms.size >= TRACE_LIMIT) {
        throw new Error(`Terminology analysis accepts at most ${TRACE_LIMIT} selected terms`);
      }
      const result = await traceTerminology({ term, baseRef, headRef, cwd });
      selectedTerms.add(key);
      traces.set(result.id, result);
      return toolResult(result);
    },
  });
  return {
    tools: [trace],
    traces() {
      return new Map(traces);
    },
  };
}

export async function traceTerminology({
  term,
  baseRef,
  headRef,
  cwd = process.cwd(),
}: {
  term: string;
  baseRef: string;
  headRef: string;
  cwd?: string;
}): Promise<TerminologyTrace> {
  const normalized = normalizeTerm(term);
  const variants = termVariants(normalized);
  const baseSha = resolveCommit(baseRef, cwd);
  const headSha = resolveCommit(headRef, cwd);
  const baseMatches = grepRef(variants, baseSha, cwd);
  const headMatches = grepRef(variants, headSha, cwd);
  const changedLocations = await changedTermLocations(variants, baseSha, headSha, cwd);
  const firstCommitSha =
    git(
      ["log", "--reverse", "--format=%H", "--regexp-ignore-case", `-S${normalized}`, headSha, "--"],
      true,
      cwd,
    )
      .split(/\r?\n/u)
      .find(Boolean) ?? null;
  const id = `term-${createHash("sha256")
    .update(JSON.stringify({ term: normalized.toLocaleLowerCase(), headSha }))
    .digest("hex")
    .slice(0, 16)}`;
  return Object.freeze({
    id,
    term: normalized,
    variants: Object.freeze(variants),
    baseSha,
    headSha,
    baseOccurrences: baseMatches.occurrences,
    headOccurrences: headMatches.occurrences,
    baseEvidenceTruncated: baseMatches.truncated,
    headEvidenceTruncated: headMatches.truncated,
    changedLocations: Object.freeze(changedLocations.slice(0, LOCATION_LIMIT)),
    baseSamples: Object.freeze(baseMatches.samples),
    headSamples: Object.freeze(headMatches.samples),
    firstCommitSha,
  });
}

function resolveCommit(ref: string, cwd: string): string {
  return git(["rev-parse", "--verify", "--end-of-options", `${ref}^{commit}`], false, cwd).trim();
}

function grepRef(
  variants: readonly string[],
  ref: string,
  cwd: string,
): { occurrences: number; samples: string[]; truncated: boolean } {
  const patterns = variants.flatMap((variant) => ["-e", variant]);
  const counts = boundedGit(["grep", "-c", "-I", "-i", "-F", ...patterns, ref, "--"], cwd);
  const sampleOutput = boundedGit(
    ["grep", "-n", "-I", "-i", "-F", ...patterns, ref, "--"],
    cwd,
    GREP_SAMPLE_BUFFER_BYTES,
  );
  const occurrences = completeLines(counts)
    .map((line) => line.match(/:(\d+)$/u))
    .reduce((total, match) => total + (match ? Number(match[1]) : 0), 0);
  const samples = [...new Set(completeLines(sampleOutput).filter(Boolean))]
    .sort()
    .slice(0, SAMPLE_LIMIT);
  return {
    occurrences,
    samples,
    truncated: counts.truncated || sampleOutput.truncated,
  };
}

type BoundedGitResult = { output: string; truncated: boolean };

function boundedGit(args: string[], cwd: string, maxBuffer = 4 * 1024 * 1024): BoundedGitResult {
  try {
    return {
      output: execFileSync("git", args, { cwd, encoding: "utf8", maxBuffer }),
      truncated: false,
    };
  } catch (error: unknown) {
    const status = errorProperty(error, "status");
    const code = errorProperty(error, "code");
    if (code === "ENOBUFS") {
      return { output: errorOutput(error), truncated: true };
    }
    if (typeof status === "number") return { output: "", truncated: false };
    const reason = error instanceof Error ? error.message : String(error);
    throw new Error(`Terminology evidence command failed: git ${args[0]}: ${reason}`);
  }
}

function completeLines(result: BoundedGitResult): string[] {
  const lines = result.output.split(/\r?\n/u);
  if (result.truncated && !/\r?\n$/u.test(result.output)) lines.pop();
  return lines;
}

function errorProperty(error: unknown, property: "status" | "code" | "stdout"): unknown {
  return typeof error === "object" && error !== null && property in error
    ? (error as Record<string, unknown>)[property]
    : undefined;
}

function errorOutput(error: unknown): string {
  const output = errorProperty(error, "stdout");
  if (typeof output === "string") return output;
  return output instanceof Uint8Array ? Buffer.from(output).toString("utf8") : "";
}

async function changedTermLocations(
  variants: readonly string[],
  baseRef: string,
  headRef: string,
  cwd: string,
): Promise<TerminologyLocation[]> {
  const mergeBaseDiff = await streamChangedTermLocations(
    variants,
    [
      "-c",
      "core.quotePath=false",
      "diff",
      "--find-renames",
      "--unified=0",
      "--default-prefix",
      `${baseRef}...${headRef}`,
    ],
    cwd,
  );
  if (mergeBaseDiff.succeeded && mergeBaseDiff.hadOutput) return mergeBaseDiff.locations;
  const directDiff = await streamChangedTermLocations(
    variants,
    [
      "-c",
      "core.quotePath=false",
      "diff",
      "--find-renames",
      "--unified=0",
      "--default-prefix",
      `${baseRef}..${headRef}`,
    ],
    cwd,
  );
  if (directDiff.succeeded) return directDiff.locations;
  const reason =
    directDiff.exitCode === null
      ? "terminated before reporting an exit status"
      : `exited with status ${directDiff.exitCode}`;
  throw new Error(`Terminology evidence command failed: git diff: ${reason}`);
}

async function streamChangedTermLocations(
  variants: readonly string[],
  args: string[],
  cwd: string,
): Promise<{
  succeeded: boolean;
  hadOutput: boolean;
  exitCode: number | null;
  locations: TerminologyLocation[];
}> {
  const parser = createChangedLocationParser(variants);
  const child = spawn("git", args, { cwd, stdio: ["ignore", "pipe", "pipe"] });
  child.stdout.setEncoding("utf8");
  child.stderr.resume();
  const exit = new Promise<number | null>((resolve, reject) => {
    child.once("error", (error) => {
      reject(new Error(`Terminology evidence command failed: git diff: ${error.message}`));
    });
    child.once("close", resolve);
  });
  const read = async () => {
    for await (const chunk of child.stdout) parser.write(String(chunk));
  };
  const [code] = await Promise.all([exit, read()]);
  const locations = parser.finish();
  if (code === 0) {
    return { succeeded: true, hadOutput: parser.hadOutput(), exitCode: code, locations };
  }
  return { succeeded: false, hadOutput: parser.hadOutput(), exitCode: code, locations: [] };
}

function createChangedLocationParser(variants: readonly string[]): {
  write(chunk: string): void;
  finish(): TerminologyLocation[];
  hadOutput(): boolean;
} {
  const needles = variants.map((variant) => variant.toLocaleLowerCase());
  const overlap = Math.max(...needles.map((needle) => needle.length - 1), 0);
  const locations: TerminologyLocation[] = [];
  let file = "";
  let line = 0;
  let linePrefix = "";
  let matchTail = "";
  let lineMatched = false;
  let sawOutput = false;

  const appendFragment = (fragment: string) => {
    sawOutput ||= fragment.length > 0;
    if (linePrefix.length < DIFF_LINE_PREFIX_LIMIT) {
      linePrefix += fragment.slice(0, DIFF_LINE_PREFIX_LIMIT - linePrefix.length);
    }
    const searchable = `${matchTail}${fragment.toLocaleLowerCase()}`;
    lineMatched ||= needles.some((needle) => searchable.includes(needle));
    matchTail = overlap === 0 ? "" : searchable.slice(-overlap);
  };

  const finishLine = () => {
    const raw = linePrefix.endsWith("\r") ? linePrefix.slice(0, -1) : linePrefix;
    const hunk = raw.match(/^@@ -\d+(?:,\d+)? \+(\d+)(?:,\d+)? @@/u);
    if (raw.startsWith("+++ b/")) {
      file = raw.slice(6);
    } else if (hunk) {
      line = Number(hunk[1]);
    } else if (raw.startsWith("+") && !raw.startsWith("+++")) {
      const added = raw.slice(1);
      if (file && lineMatched && locations.length < LOCATION_LIMIT) {
        locations.push(Object.freeze({ file, line, text: added.slice(0, 500) }));
      }
      line += 1;
    } else if (!raw.startsWith("-")) {
      line += 1;
    }
    linePrefix = "";
    matchTail = "";
    lineMatched = false;
  };

  return {
    write(chunk: string) {
      sawOutput ||= chunk.length > 0;
      let offset = 0;
      for (let newline = chunk.indexOf("\n", offset); newline !== -1;) {
        appendFragment(chunk.slice(offset, newline));
        finishLine();
        offset = newline + 1;
        newline = chunk.indexOf("\n", offset);
      }
      appendFragment(chunk.slice(offset));
    },
    finish() {
      if (linePrefix || matchTail) finishLine();
      return locations;
    },
    hadOutput() {
      return sawOutput;
    },
  };
}

function termVariants(term: string): string[] {
  const variants = new Set([term]);
  if (term.includes("-")) variants.add(term.replace(/-/gu, " "));
  if (term.includes(" ")) variants.add(term.replace(/\s+/gu, "-"));
  return [...variants];
}

function git(args: string[], allowFailure = false, cwd = process.cwd()): string {
  try {
    return execFileSync("git", args, { cwd, encoding: "utf8", maxBuffer: 4 * 1024 * 1024 });
  } catch (error: unknown) {
    const status =
      typeof error === "object" && error !== null && "status" in error
        ? (error as { status?: unknown }).status
        : undefined;
    if (allowFailure && typeof status === "number") return "";
    const reason = error instanceof Error ? error.message : String(error);
    throw new Error(`Terminology evidence command failed: git ${args[0]}: ${reason}`);
  }
}

function normalizeTerm(value: string): string {
  const term = nonempty(value, "term").replace(/\s+/gu, " ");
  if (term.length > TERM_LIMIT || /[\u0000-\u001f\u007f]/u.test(term)) {
    throw new Error(`term must be printable and at most ${TERM_LIMIT} characters`);
  }
  return term;
}

function nullableText(value: string | null): string | null {
  return value === null ? null : nonempty(value, "text");
}

function nonempty(value: string, name: string): string {
  const normalized = value.trim();
  if (!normalized) throw new Error(`${name} must be nonempty`);
  return normalized;
}

function positiveInteger(value: number, name: string): number {
  if (!Number.isInteger(value) || value < 1) throw new Error(`${name} must be a positive integer`);
  return value;
}

function toolResult(value: unknown, terminate = false) {
  return {
    content: [{ type: "text" as const, text: JSON.stringify(value) }],
    details: {},
    ...(terminate ? { terminate } : {}),
  };
}
