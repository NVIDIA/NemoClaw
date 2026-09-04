// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import fs from "node:fs";
import path from "node:path";

import { canonicalJson, replaceControlCharacters, sha256 } from "../advisors/canonical-json.mts";
import type { AdvisorFindingExclusion } from "../pr-review-advisor/finding-ledger.mts";
import { type RepairContractSchemaName, repairContractSchemaErrors } from "./schemas.mts";

export type { RepairContractSchemaName } from "./schemas.mts";

export const CANONICAL_REPOSITORY = "NVIDIA/NemoClaw";
export const PHASE1_PILOT_AUTHOR = "cjagwani";
export const PHASE1_PRODUCT_SCOPE = {
  kind: "accepted-issue",
  identity: "#10791",
} as const;
export const MAX_PATCH_BYTES = 2 * 1024 * 1024;
export const MAX_CHANGED_FILES = 20;
export const MAX_CHANGED_FILE_BYTES = 1024 * 1024;

export type RepairClass = "source" | "test" | "documentation" | "unsupported";

export type FindingInput = {
  id: string;
  repairClass: RepairClass;
  summary: string;
  path: string | null;
  exclusions: AdvisorFindingExclusion[];
};

export type SelectionInput = {
  version: 1;
  repository: typeof CANONICAL_REPOSITORY;
  prNumber: number;
  pullRequest: {
    state: "open";
    draft: false;
    maintainerCanModify: true;
    author: typeof PHASE1_PILOT_AUTHOR;
    baseRef: "main";
    headRepository: typeof CANONICAL_REPOSITORY;
    headRef: string;
  };
  sourceHeadSha: string;
  baseSha: string;
  advisor: {
    workflowSha: string;
    runId: number;
    runAttempt: number;
    artifactIds: number[];
    artifactDigests: string[];
    findingLedgerDigest: string;
    reviewStateDigest: string;
  };
  optIn: {
    kind: "phase1-maintainer-dispatch";
    actor: string;
    triggeringActor: string;
    headSha: string;
    findingIds: string[];
  };
  productScope: {
    kind: typeof PHASE1_PRODUCT_SCOPE.kind;
    identity: typeof PHASE1_PRODUCT_SCOPE.identity;
  };
  findings: FindingInput[];
};

export type SelectionDecision = {
  id: string;
  repairClass: RepairClass;
  path: string | null;
  state: "selected" | "skipped";
  reason: string | null;
};

export type SelectionBundle = {
  version: 1;
  phase: "phase1-manual-publication";
  identityStatus: "exact-head-advisor-ledger";
  attemptKey: string;
  input: SelectionInput;
  decisions: SelectionDecision[];
  selectedFindingIds: string[];
  selectedPaths: string[];
  outcome: "selected" | "skipped";
};

export type ProposalReceipt = {
  version: 1;
  attemptKey: string;
  sourceHeadSha: string;
  findingIds: string[];
  unresolvedFindingIds: string[];
  changedPaths: string[];
  summary: string;
  outcome: "proposed" | "no-change" | "blocked";
};

export type ProposalDraft = Omit<ProposalReceipt, "attemptKey" | "sourceHeadSha">;

export type ChangedPath = {
  path: string;
  status: "A" | "D" | "M";
  mode: "100644";
  type: "blob";
  bytes: number;
};

export type ValidationCommand = {
  argv: string[];
  exitCode: number;
};

export type ValidationReceipt = {
  version: 1;
  attemptKey: string;
  repository: typeof CANONICAL_REPOSITORY;
  prNumber: number;
  author: typeof PHASE1_PILOT_AUTHOR;
  headRef: string;
  sourceHeadSha: string;
  baseSha: string;
  advisor: SelectionInput["advisor"];
  findingIds: string[];
  selectedPaths: string[];
  patchSha256: string;
  candidateTreeSha: string;
  changedPaths: ChangedPath[];
  validation: {
    candidateDigestBefore: string;
    candidateDigestAfter: string;
    commands: ValidationCommand[];
  };
  productScope: SelectionInput["productScope"];
  optIn: SelectionInput["optIn"];
  outcome: "validated" | "rejected" | "skipped";
  reason: string | null;
};

export class RepairContractError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RepairContractError";
  }
}

export function requiredEnvironment(env: NodeJS.ProcessEnv, name: string): string {
  const value = env[name];
  if (!value) throw new RepairContractError(`${name} is required`);
  return value;
}

export function parseFullSha(value: unknown, label: string): string {
  if (typeof value !== "string" || !/^[0-9a-f]{40}$/u.test(value)) {
    throw new RepairContractError(`${label} must be a full SHA`);
  }
  return value;
}

export function parsePositiveInteger(value: unknown, label: string): number {
  if (typeof value === "string" && !/^[1-9]\d*$/u.test(value)) {
    throw new RepairContractError(`${label} must be a positive integer`);
  }
  const parsed = typeof value === "string" ? Number(value) : value;
  if (!Number.isSafeInteger(parsed) || Number(parsed) < 1) {
    throw new RepairContractError(`${label} must be a positive integer`);
  }
  return Number(parsed);
}

export function assertRepairContractSchema(name: RepairContractSchemaName, value: unknown): void {
  const [error] = repairContractSchemaErrors(name, value) ?? [];
  if (!error) return;
  const location = error.instancePath || "/";
  throw new RepairContractError(
    `${name} does not match the committed schema at ${location}: ${error.message ?? "invalid value"}`,
  );
}

function compareCodeUnits(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function assertBranchRef(value: string): void {
  if (
    value === "@" ||
    value.startsWith("-") ||
    value.startsWith("/") ||
    value.endsWith("/") ||
    value.endsWith(".") ||
    value.endsWith(".lock") ||
    value.includes("..") ||
    value.includes("@{") ||
    value.includes("//") ||
    /[ ~^:?*[\\]/u.test(value)
  ) {
    throw new RepairContractError("headRef is not a supported branch ref");
  }
}

function assertSortedUnique(values: readonly string[], label: string): void {
  if (
    values.some(
      (value, index) => index > 0 && compareCodeUnits(values[index - 1] ?? "", value) >= 0,
    )
  ) {
    throw new RepairContractError(`${label} must be sorted and unique`);
  }
}

function sameStrings(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

export { sha256 } from "../advisors/canonical-json.mts";

function repairAttemptKey(input: {
  repository: typeof CANONICAL_REPOSITORY;
  prNumber: number;
  sourceHeadSha: string;
  baseSha: string;
  advisor: Pick<SelectionInput["advisor"], "workflowSha" | "runId" | "runAttempt">;
  findingIds: readonly string[];
}): string {
  return `sha256:${sha256(
    canonicalJson({
      repository: input.repository,
      prNumber: input.prNumber,
      sourceHeadSha: input.sourceHeadSha,
      baseSha: input.baseSha,
      advisor: {
        workflowSha: input.advisor.workflowSha,
        runId: input.advisor.runId,
        runAttempt: input.advisor.runAttempt,
      },
      findingIds: [...input.findingIds].sort(compareCodeUnits),
    }),
  )}`;
}

export function readBoundedRegularFile(file: string, maximum: number, allowEmpty = false): Buffer {
  const descriptor = fs.openSync(
    file,
    fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK,
  );
  try {
    const before = fs.fstatSync(descriptor);
    if (
      !before.isFile() ||
      before.nlink !== 1 ||
      before.size > maximum ||
      (!allowEmpty && before.size === 0)
    ) {
      throw new RepairContractError(`${file} must be a bounded regular file`);
    }
    const content = fs.readFileSync(descriptor);
    const after = fs.fstatSync(descriptor);
    if (
      content.length !== before.size ||
      before.size !== after.size ||
      before.mtimeMs !== after.mtimeMs ||
      before.ino !== after.ino
    ) {
      throw new RepairContractError(`${file} changed while read`);
    }
    return content;
  } finally {
    fs.closeSync(descriptor);
  }
}

export function readBoundedJson(file: string, maximum: number): unknown {
  const content = readBoundedRegularFile(file, maximum);
  try {
    return JSON.parse(content.toString("utf8"));
  } catch {
    throw new RepairContractError(`${file} must contain valid JSON`);
  }
}

const DENIED_BASENAMES = new Set([
  ".gitattributes",
  ".gitmodules",
  ".npmrc",
  "AGENTS.md",
  "biome.json",
  "CODEOWNERS",
  "SECURITY.md",
  "package.json",
  "package-lock.json",
  "npm-shrinkwrap.json",
  "pnpm-lock.yaml",
  "tsconfig.json",
  "vitest.config.ts",
  "yarn.lock",
]);

const DENIED_PREFIXES = [
  ".agents/",
  ".claude/",
  ".github/",
  "ci/",
  "scripts/",
  "test/e2e/",
  "tools/",
] as const;

export function isDeniedRepairControlPath(value: string): boolean {
  return (
    value.split("/").some((segment) => DENIED_BASENAMES.has(segment)) ||
    DENIED_PREFIXES.some((prefix) => value.startsWith(prefix))
  );
}

export function safeRelativePath(value: string): boolean {
  if (
    value.length === 0 ||
    Buffer.byteLength(value, "utf8") > 512 ||
    !/^[A-Za-z0-9._/-]+$/u.test(value) ||
    value.startsWith("/") ||
    value.endsWith("/") ||
    value.includes("//") ||
    path.posix.normalize(value) !== value
  ) {
    return false;
  }
  const segments = value.split("/");
  if (
    segments.some((segment) => segment === "." || segment === ".." || segment.startsWith(".git"))
  ) {
    return false;
  }
  return !isDeniedRepairControlPath(value);
}

export function repairClassForPath(value: string): Exclude<RepairClass, "unsupported"> | null {
  if (!safeRelativePath(value)) return null;
  if (/^docs\/.+[.]mdx?$/u.test(value)) return "documentation";
  if (
    (/^test\/(?!e2e\/).+[.](?:[cm]?[jt]s)$/u.test(value) ||
      /^(?:src|nemoclaw\/src)\/.+[.]test[.](?:[cm]?[jt]s)$/u.test(value)) &&
    !value.includes("/fixtures/secrets/")
  ) {
    return "test";
  }
  if (/^(?:src|nemoclaw\/src)\/.+[.](?:[cm]?[jt]s)$/u.test(value)) return "source";
  return null;
}

export function parseSelectionInput(value: unknown): SelectionInput {
  assertRepairContractSchema("selection-input", value);
  const input = value as SelectionInput;
  assertBranchRef(input.pullRequest.headRef);

  const ids = input.findings.map(({ id }) => id);
  if (new Set(ids).size !== ids.length) {
    throw new RepairContractError("finding identifiers must be unique");
  }
  const optedIn = input.optIn.findingIds;
  assertSortedUnique(optedIn, "optIn.findingIds");
  if (optedIn.some((id) => !ids.includes(id))) {
    throw new RepairContractError("manual opt-in references an unknown Advisor finding");
  }
  if (input.sourceHeadSha !== input.optIn.headSha) {
    throw new RepairContractError("manual opt-in is not bound to the source head SHA");
  }
  return input;
}

function skipReason(finding: FindingInput, optInFindingIds: readonly string[]): string | null {
  if (!optInFindingIds.includes(finding.id)) return "not-opted-in";
  if (finding.exclusions.length > 0) return `excluded:${[...finding.exclusions].sort()[0]}`;
  if (finding.repairClass === "unsupported") return "unsupported:repair-class";
  if (!finding.path) return "unsupported:path-required";
  const actualClass = repairClassForPath(finding.path);
  if (!actualClass) return "unsupported:path";
  if (actualClass !== finding.repairClass) return "unsupported:path-class-mismatch";
  return null;
}

export function selectRepairAttempt(input: SelectionInput): SelectionBundle {
  const decisions = [...input.findings]
    .sort((left, right) => compareCodeUnits(left.id, right.id))
    .map((finding): SelectionDecision => {
      const reason = skipReason(finding, input.optIn.findingIds);
      return {
        id: finding.id,
        repairClass: finding.repairClass,
        path: finding.path,
        state: reason ? "skipped" : "selected",
        reason,
      };
    });
  const selected = decisions.filter(({ state }) => state === "selected");
  const selectedFindingIds = selected.map(({ id }) => id);
  const selectedPaths = [
    ...new Set(selected.flatMap(({ path: selectedPath }) => (selectedPath ? [selectedPath] : []))),
  ].sort(compareCodeUnits);
  return {
    version: 1,
    phase: "phase1-manual-publication",
    identityStatus: "exact-head-advisor-ledger",
    attemptKey: repairAttemptKey({
      repository: input.repository,
      prNumber: input.prNumber,
      sourceHeadSha: input.sourceHeadSha,
      baseSha: input.baseSha,
      advisor: input.advisor,
      findingIds: selectedFindingIds,
    }),
    input,
    decisions,
    selectedFindingIds,
    selectedPaths,
    outcome: selected.length > 0 ? "selected" : "skipped",
  };
}

export function parseSelectionBundle(value: unknown): SelectionBundle {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new RepairContractError("selection bundle must be an object");
  }
  const recomputed = selectRepairAttempt(parseSelectionInput((value as { input?: unknown }).input));
  if (canonicalJson(value) !== canonicalJson(recomputed)) {
    throw new RepairContractError("selection bundle does not match its trusted recomputation");
  }
  return recomputed;
}

function parseProposalFields(
  input: ProposalDraft | ProposalReceipt,
  selection: SelectionBundle,
): Omit<ProposalReceipt, "version" | "attemptKey" | "sourceHeadSha"> {
  const { findingIds, unresolvedFindingIds, changedPaths, outcome } = input;
  assertSortedUnique(findingIds, "proposal receipt findingIds");
  if (!sameStrings(findingIds, selection.selectedFindingIds)) {
    throw new RepairContractError("proposal receipt must account for every selected finding");
  }
  assertSortedUnique(unresolvedFindingIds, "proposal receipt unresolvedFindingIds");
  if (unresolvedFindingIds.some((item) => !findingIds.includes(item))) {
    throw new RepairContractError("proposal receipt has an unknown unresolved finding");
  }
  if (outcome === "proposed" && unresolvedFindingIds.length > 0) {
    throw new RepairContractError("a proposed repair cannot leave selected findings unresolved");
  }
  assertSortedUnique(changedPaths, "proposal receipt changedPaths");
  if (changedPaths.some((item) => !selection.selectedPaths.includes(item))) {
    throw new RepairContractError("proposal receipt changed a path outside the selected allowlist");
  }
  if (outcome === "proposed" && changedPaths.length === 0) {
    throw new RepairContractError("a proposed repair must identify a changed path");
  }
  if (outcome !== "proposed" && changedPaths.length !== 0) {
    throw new RepairContractError("a non-proposal cannot identify changed paths");
  }
  const summary = sanitizeDiagnostic(input.summary);
  if (!summary)
    throw new RepairContractError("proposal receipt summary is empty after sanitization");
  return { findingIds, unresolvedFindingIds, changedPaths, summary, outcome };
}

export function parseProposalDraft(value: unknown, selection: SelectionBundle): ProposalReceipt {
  assertRepairContractSchema("proposal-draft", value);
  return {
    version: 1,
    attemptKey: selection.attemptKey,
    sourceHeadSha: selection.input.sourceHeadSha,
    ...parseProposalFields(value as ProposalDraft, selection),
  };
}

export function parseProposalReceipt(value: unknown, selection: SelectionBundle): ProposalReceipt {
  assertRepairContractSchema("proposal-receipt", value);
  const input = value as ProposalReceipt;
  if (input.attemptKey !== selection.attemptKey) {
    throw new RepairContractError("proposal receipt is bound to a different attempt");
  }
  if (input.sourceHeadSha !== selection.input.sourceHeadSha) {
    throw new RepairContractError("proposal receipt is bound to a different source head");
  }
  return {
    version: 1,
    attemptKey: selection.attemptKey,
    sourceHeadSha: selection.input.sourceHeadSha,
    ...parseProposalFields(input, selection),
  };
}

export function parseValidatedReceiptForPublication(
  value: unknown,
  patch: Buffer,
): ValidationReceipt {
  assertRepairContractSchema("validation-receipt", value);
  const receipt = value as ValidationReceipt;
  if (receipt.outcome !== "validated" || receipt.reason !== null) {
    throw new RepairContractError("validation receipt is not an accepted candidate");
  }

  assertBranchRef(receipt.headRef);
  assertSortedUnique(receipt.findingIds, "validation receipt finding IDs");
  assertSortedUnique(receipt.optIn.findingIds, "validation receipt opt-in finding IDs");
  if (receipt.selectedPaths.some((selectedPath) => !repairClassForPath(selectedPath))) {
    throw new RepairContractError("validation receipt selected paths are unsupported");
  }
  assertSortedUnique(receipt.selectedPaths, "validation receipt selected paths");
  if (
    receipt.changedPaths.length === 0 ||
    receipt.changedPaths.some(
      ({ path: changedPath }) =>
        !receipt.selectedPaths.includes(changedPath) || !repairClassForPath(changedPath),
    )
  ) {
    throw new RepairContractError("validation receipt changed a path outside selection");
  }
  assertSortedUnique(
    receipt.changedPaths.map(({ path: changedPath }) => changedPath),
    "validation receipt changed paths",
  );
  if (receipt.validation.commands.length === 0) {
    throw new RepairContractError("validation receipt commands must be non-empty");
  }
  if (receipt.validation.commands.some(({ exitCode }) => exitCode !== 0)) {
    throw new RepairContractError("validation receipt contains a failed command");
  }
  if (receipt.validation.candidateDigestBefore !== receipt.validation.candidateDigestAfter) {
    throw new RepairContractError("validation receipt reports candidate mutation");
  }
  if (receipt.patchSha256 !== sha256(patch)) {
    throw new RepairContractError("validation receipt patch digest is invalid");
  }
  if (
    receipt.optIn.headSha !== receipt.sourceHeadSha ||
    receipt.findingIds.some((finding) => !receipt.optIn.findingIds.includes(finding))
  ) {
    throw new RepairContractError("validation receipt differs from the exact Advisor opt-in");
  }
  if (
    receipt.attemptKey !==
    repairAttemptKey({
      repository: receipt.repository,
      prNumber: receipt.prNumber,
      sourceHeadSha: receipt.sourceHeadSha,
      baseSha: receipt.baseSha,
      advisor: receipt.advisor,
      findingIds: receipt.findingIds,
    })
  ) {
    throw new RepairContractError("validation receipt attempt digest is invalid");
  }
  return receipt;
}

export function parseValidationReceipt(
  value: unknown,
  selection: SelectionBundle,
  patch: Buffer,
): ValidationReceipt {
  const receipt = parseValidatedReceiptForPublication(value, patch);
  if (
    receipt.attemptKey !== selection.attemptKey ||
    receipt.repository !== selection.input.repository ||
    receipt.prNumber !== selection.input.prNumber ||
    receipt.author !== selection.input.pullRequest.author ||
    receipt.headRef !== selection.input.pullRequest.headRef ||
    receipt.sourceHeadSha !== selection.input.sourceHeadSha ||
    receipt.baseSha !== selection.input.baseSha ||
    canonicalJson(receipt.advisor) !== canonicalJson(selection.input.advisor) ||
    canonicalJson(receipt.productScope) !== canonicalJson(selection.input.productScope) ||
    canonicalJson(receipt.optIn) !== canonicalJson(selection.input.optIn)
  ) {
    throw new RepairContractError("validation receipt identity differs from selection");
  }
  if (!sameStrings(receipt.findingIds, selection.selectedFindingIds)) {
    throw new RepairContractError("validation receipt finding set differs from selection");
  }
  if (!sameStrings(receipt.selectedPaths, selection.selectedPaths)) {
    throw new RepairContractError("validation receipt selected paths differ from selection");
  }
  return receipt;
}

const DIAGNOSTIC_URL_PATTERN = /[a-z][a-z0-9+.-]*:\/\/[^\s'"]+/giu;
const SENSITIVE_URL_KEY =
  /(?:^|[-_])(?:access|api|auth|bearer|client|credential|key|password|passwd|refresh|secret|session|sig|signature|token)(?:$|[-_])/iu;

function redactDiagnosticUrl(value: string): string {
  try {
    const url = new URL(value);
    url.username = "";
    url.password = "";
    for (const key of [...url.searchParams.keys()]) {
      if (SENSITIVE_URL_KEY.test(key)) url.searchParams.set(key, "[REDACTED]");
    }
    url.hash = "";
    return url.toString();
  } catch {
    return "[REDACTED_URL]";
  }
}

export function sanitizeDiagnostic(value: unknown): string {
  const raw = value instanceof Error ? value.message : String(value);
  return replaceControlCharacters(raw)
    .replace(DIAGNOSTIC_URL_PATTERN, redactDiagnosticUrl)
    .replace(
      /\b(?:ghp_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,}|nvapi-[A-Za-z0-9_-]{20,}|sk-[A-Za-z0-9_-]{20,})\b/gu,
      "[REDACTED]",
    )
    .replace(/\b(token|secret|password|api[_-]?key)\s*[:=]\s*\S+/giu, "$1=[REDACTED]")
    .trim()
    .slice(0, 1000);
}
