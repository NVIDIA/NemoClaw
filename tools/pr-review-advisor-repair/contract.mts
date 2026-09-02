// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";

export const CANONICAL_REPOSITORY = "NVIDIA/NemoClaw";
export const MAX_PATCH_BYTES = 2 * 1024 * 1024;
export const MAX_CHANGED_FILES = 20;
export const MAX_CHANGED_FILE_BYTES = 1024 * 1024;

export const FINDING_EXCLUSIONS = [
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

export type FindingExclusion = (typeof FINDING_EXCLUSIONS)[number];
export type RepairClass = "source" | "test" | "documentation" | "unsupported";

export type FindingInput = {
  id: string;
  repairClass: RepairClass;
  summary: string;
  path: string | null;
  exclusions: FindingExclusion[];
};

export type SelectionInput = {
  version: 1;
  repository: typeof CANONICAL_REPOSITORY;
  prNumber: number;
  pullRequest: {
    state: "open";
    draft: false;
    baseRef: "main";
    headRepository: typeof CANONICAL_REPOSITORY;
    headRef: string;
    maintainerCanModify: true;
  };
  sourceHeadSha: string;
  baseSha: string;
  advisor: {
    workflowSha: string;
    runId: number;
    runAttempt: number;
    artifactIds: number[];
  };
  optIn: {
    kind: "phase1-maintainer-dispatch";
    actor: string;
    triggeringActor: string;
    headSha: string;
  };
  productScope: {
    kind: "accepted-issue" | "maintainer-decision";
    identity: string;
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
  identityStatus: "exact-head-dispatcher-supplied";
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
  headRef: string;
  sourceHeadSha: string;
  baseSha: string;
  advisor: SelectionInput["advisor"];
  findingIds: string[];
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

function record(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new RepairContractError(`${label} must be an object`);
  }
  return value as Record<string, unknown>;
}

function exactKeys(value: Record<string, unknown>, keys: readonly string[], label: string): void {
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  if (actual.length !== expected.length || actual.some((key, index) => key !== expected[index])) {
    throw new RepairContractError(`${label} has unsupported fields`);
  }
}

function integer(value: unknown, label: string): number {
  if (!Number.isSafeInteger(value) || (value as number) < 1) {
    throw new RepairContractError(`${label} must be a positive integer`);
  }
  return value as number;
}

function boundedString(value: unknown, label: string, maximum: number): string {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    Buffer.byteLength(value, "utf8") > maximum ||
    /[\u0000-\u001f\u007f]/u.test(value)
  ) {
    throw new RepairContractError(`${label} must be a bounded printable string`);
  }
  return value;
}

function sha(value: unknown, label: string): string {
  const result = boundedString(value, label, 40);
  if (!/^[0-9a-f]{40}$/u.test(result)) throw new RepairContractError(`${label} must be a full SHA`);
  return result;
}

function digest(value: unknown, label: string): string {
  const result = boundedString(value, label, 71);
  if (!/^sha256:[0-9a-f]{64}$/u.test(result)) {
    throw new RepairContractError(`${label} must be a sha256 digest`);
  }
  return result;
}

function sortedUniqueStrings(values: unknown, label: string, maximumItems = 20): string[] {
  if (!Array.isArray(values) || values.length > maximumItems) {
    throw new RepairContractError(`${label} must be a bounded array`);
  }
  const parsed = values.map((value, index) => boundedString(value, `${label}[${index}]`, 512));
  const sorted = [...parsed].sort();
  if (
    new Set(parsed).size !== parsed.length ||
    parsed.some((value, index) => value !== sorted[index])
  ) {
    throw new RepairContractError(`${label} must be sorted and unique`);
  }
  return parsed;
}

function findingId(value: unknown, label: string): string {
  const result = boundedString(value, label, 128);
  if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u.test(result)) {
    throw new RepairContractError(`${label} is not a supported finding identifier`);
  }
  return result;
}

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value && typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>).sort(([left], [right]) =>
      left.localeCompare(right),
    );
    return `{${entries.map(([key, item]) => `${JSON.stringify(key)}:${canonicalJson(item)}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

export function sha256(content: string | Buffer): string {
  return createHash("sha256").update(content).digest("hex");
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
  if (segments.some((segment) => DENIED_BASENAMES.has(segment))) return false;
  return ![".agents/", ".claude/", ".github/", "ci/", "scripts/", "test/e2e/", "tools/"].some(
    (prefix) => value.startsWith(prefix),
  );
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

function parseFinding(value: unknown, index: number): FindingInput {
  const input = record(value, `findings[${index}]`);
  exactKeys(input, ["id", "repairClass", "summary", "path", "exclusions"], `findings[${index}]`);
  const id = findingId(input.id, `findings[${index}].id`);
  if (!["source", "test", "documentation", "unsupported"].includes(String(input.repairClass))) {
    throw new RepairContractError(`findings[${index}].repairClass is unsupported`);
  }
  const repairClass = input.repairClass as RepairClass;
  const summary = boundedString(input.summary, `findings[${index}].summary`, 2000);
  const findingPath =
    input.path === null ? null : boundedString(input.path, `findings[${index}].path`, 512);
  if (!Array.isArray(input.exclusions) || input.exclusions.length > FINDING_EXCLUSIONS.length) {
    throw new RepairContractError(`findings[${index}].exclusions must be a bounded array`);
  }
  const exclusions = input.exclusions.map((item) => {
    if (!FINDING_EXCLUSIONS.includes(item as FindingExclusion)) {
      throw new RepairContractError(`findings[${index}] has an unsupported exclusion`);
    }
    return item as FindingExclusion;
  });
  if (new Set(exclusions).size !== exclusions.length) {
    throw new RepairContractError(`findings[${index}].exclusions must be unique`);
  }
  return { id, repairClass, summary, path: findingPath, exclusions };
}

export function parseSelectionInput(value: unknown): SelectionInput {
  const input = record(value, "selection input");
  exactKeys(
    input,
    [
      "version",
      "repository",
      "prNumber",
      "pullRequest",
      "sourceHeadSha",
      "baseSha",
      "advisor",
      "optIn",
      "productScope",
      "findings",
    ],
    "selection input",
  );
  if (input.version !== 1) throw new RepairContractError("selection input version must be 1");
  if (input.repository !== CANONICAL_REPOSITORY) {
    throw new RepairContractError("selection input repository must be canonical");
  }

  const pullRequest = record(input.pullRequest, "pullRequest");
  exactKeys(
    pullRequest,
    ["state", "draft", "baseRef", "headRepository", "headRef", "maintainerCanModify"],
    "pullRequest",
  );
  if (
    pullRequest.state !== "open" ||
    pullRequest.draft !== false ||
    pullRequest.baseRef !== "main" ||
    pullRequest.headRepository !== CANONICAL_REPOSITORY ||
    pullRequest.maintainerCanModify !== true
  ) {
    throw new RepairContractError("pull request is not an eligible canonical open PR into main");
  }

  const advisor = record(input.advisor, "advisor");
  exactKeys(advisor, ["workflowSha", "runId", "runAttempt", "artifactIds"], "advisor");
  if (!Array.isArray(advisor.artifactIds) || advisor.artifactIds.length !== 10) {
    throw new RepairContractError("advisor.artifactIds must contain exactly ten artifacts");
  }
  const artifactIds = advisor.artifactIds.map((item, index) =>
    integer(item, `advisor.artifactIds[${index}]`),
  );
  if (new Set(artifactIds).size !== artifactIds.length) {
    throw new RepairContractError("advisor.artifactIds must be unique");
  }

  const optIn = record(input.optIn, "optIn");
  exactKeys(optIn, ["kind", "actor", "triggeringActor", "headSha"], "optIn");
  if (optIn.kind !== "phase1-maintainer-dispatch") {
    throw new RepairContractError("Phase 1 requires an explicit maintainer dispatch opt-in");
  }

  const productScope = record(input.productScope, "productScope");
  exactKeys(productScope, ["kind", "identity"], "productScope");
  if (!["accepted-issue", "maintainer-decision"].includes(String(productScope.kind))) {
    throw new RepairContractError("productScope.kind is unsupported");
  }

  if (!Array.isArray(input.findings) || input.findings.length < 1 || input.findings.length > 20) {
    throw new RepairContractError("findings must contain between one and twenty entries");
  }
  const findings = input.findings.map(parseFinding);
  if (new Set(findings.map(({ id }) => id)).size !== findings.length) {
    throw new RepairContractError("finding identifiers must be unique");
  }

  const sourceHeadSha = sha(input.sourceHeadSha, "sourceHeadSha");
  const optInHeadSha = sha(optIn.headSha, "optIn.headSha");
  if (sourceHeadSha !== optInHeadSha) {
    throw new RepairContractError("manual opt-in is not bound to the source head SHA");
  }

  return {
    version: 1,
    repository: CANONICAL_REPOSITORY,
    prNumber: integer(input.prNumber, "prNumber"),
    pullRequest: {
      state: "open",
      draft: false,
      baseRef: "main",
      headRepository: CANONICAL_REPOSITORY,
      headRef: boundedString(pullRequest.headRef, "pullRequest.headRef", 255),
      maintainerCanModify: true,
    },
    sourceHeadSha,
    baseSha: sha(input.baseSha, "baseSha"),
    advisor: {
      workflowSha: sha(advisor.workflowSha, "advisor.workflowSha"),
      runId: integer(advisor.runId, "advisor.runId"),
      runAttempt: integer(advisor.runAttempt, "advisor.runAttempt"),
      artifactIds,
    },
    optIn: {
      kind: "phase1-maintainer-dispatch",
      actor: boundedString(optIn.actor, "optIn.actor", 256),
      triggeringActor: boundedString(optIn.triggeringActor, "optIn.triggeringActor", 256),
      headSha: optInHeadSha,
    },
    productScope: {
      kind: productScope.kind as SelectionInput["productScope"]["kind"],
      identity: boundedString(productScope.identity, "productScope.identity", 256),
    },
    findings,
  };
}

function skipReason(finding: FindingInput): string | null {
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
    .sort((left, right) => left.id.localeCompare(right.id))
    .map((finding): SelectionDecision => {
      const reason = skipReason(finding);
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
    ...new Set(selected.map(({ path: selectedPath }) => selectedPath!)),
  ].sort();
  const identity = {
    repository: input.repository,
    prNumber: input.prNumber,
    sourceHeadSha: input.sourceHeadSha,
    baseSha: input.baseSha,
    advisor: {
      workflowSha: input.advisor.workflowSha,
      runId: input.advisor.runId,
      runAttempt: input.advisor.runAttempt,
      artifactIds: [...input.advisor.artifactIds].sort((left, right) => left - right),
    },
    optIn: input.optIn,
    productScope: input.productScope,
    findingIds: selectedFindingIds,
    paths: selectedPaths,
  };
  return {
    version: 1,
    phase: "phase1-manual-publication",
    identityStatus: "exact-head-dispatcher-supplied",
    attemptKey: `sha256:${sha256(canonicalJson(identity))}`,
    input,
    decisions,
    selectedFindingIds,
    selectedPaths,
    outcome: selected.length > 0 ? "selected" : "skipped",
  };
}

export function parseSelectionBundle(value: unknown): SelectionBundle {
  const input = record(value, "selection bundle");
  exactKeys(
    input,
    [
      "version",
      "phase",
      "identityStatus",
      "attemptKey",
      "input",
      "decisions",
      "selectedFindingIds",
      "selectedPaths",
      "outcome",
    ],
    "selection bundle",
  );
  const recomputed = selectRepairAttempt(parseSelectionInput(input.input));
  if (canonicalJson(input) !== canonicalJson(recomputed)) {
    throw new RepairContractError("selection bundle does not match its trusted recomputation");
  }
  return recomputed;
}

export function parseProposalReceipt(value: unknown, selection: SelectionBundle): ProposalReceipt {
  const input = record(value, "proposal receipt");
  exactKeys(
    input,
    [
      "version",
      "attemptKey",
      "sourceHeadSha",
      "findingIds",
      "unresolvedFindingIds",
      "changedPaths",
      "summary",
      "outcome",
    ],
    "proposal receipt",
  );
  if (input.version !== 1) throw new RepairContractError("proposal receipt version must be 1");
  if (digest(input.attemptKey, "proposal receipt attemptKey") !== selection.attemptKey) {
    throw new RepairContractError("proposal receipt is bound to a different attempt");
  }
  if (
    sha(input.sourceHeadSha, "proposal receipt sourceHeadSha") !== selection.input.sourceHeadSha
  ) {
    throw new RepairContractError("proposal receipt is bound to a different source head");
  }
  const findingIds = sortedUniqueStrings(input.findingIds, "proposal receipt findingIds").map(
    (item, index) => findingId(item, `proposal receipt findingIds[${index}]`),
  );
  if (
    findingIds.length !== selection.selectedFindingIds.length ||
    findingIds.some((item, index) => item !== selection.selectedFindingIds[index])
  ) {
    throw new RepairContractError("proposal receipt must account for every selected finding");
  }
  const unresolvedFindingIds = sortedUniqueStrings(
    input.unresolvedFindingIds,
    "proposal receipt unresolvedFindingIds",
  ).map((item, index) => findingId(item, `proposal receipt unresolvedFindingIds[${index}]`));
  if (unresolvedFindingIds.some((item) => !findingIds.includes(item))) {
    throw new RepairContractError("proposal receipt has an unknown unresolved finding");
  }
  const changedPaths = sortedUniqueStrings(input.changedPaths, "proposal receipt changedPaths");
  if (changedPaths.some((item) => !selection.selectedPaths.includes(item))) {
    throw new RepairContractError("proposal receipt changed a path outside the selected allowlist");
  }
  if (!["proposed", "no-change", "blocked"].includes(String(input.outcome))) {
    throw new RepairContractError("proposal receipt outcome is unsupported");
  }
  const outcome = input.outcome as ProposalReceipt["outcome"];
  if (outcome === "proposed" && changedPaths.length === 0) {
    throw new RepairContractError("a proposed repair must identify a changed path");
  }
  if (outcome !== "proposed" && changedPaths.length !== 0) {
    throw new RepairContractError("a non-proposal cannot identify changed paths");
  }
  const summary = sanitizeDiagnostic(
    boundedString(input.summary, "proposal receipt summary", 2000),
  );
  if (!summary)
    throw new RepairContractError("proposal receipt summary is empty after sanitization");
  return {
    version: 1,
    attemptKey: selection.attemptKey,
    sourceHeadSha: selection.input.sourceHeadSha,
    findingIds,
    unresolvedFindingIds,
    changedPaths,
    summary,
    outcome,
  };
}

export function parseValidationReceipt(
  value: unknown,
  selection: SelectionBundle,
  patch: Buffer,
): ValidationReceipt {
  const input = record(value, "validation receipt");
  exactKeys(
    input,
    [
      "version",
      "attemptKey",
      "repository",
      "prNumber",
      "headRef",
      "sourceHeadSha",
      "baseSha",
      "advisor",
      "findingIds",
      "patchSha256",
      "candidateTreeSha",
      "changedPaths",
      "validation",
      "productScope",
      "optIn",
      "outcome",
      "reason",
    ],
    "validation receipt",
  );
  if (input.version !== 1 || input.outcome !== "validated" || input.reason !== null) {
    throw new RepairContractError("validation receipt is not an accepted candidate");
  }
  if (
    digest(input.attemptKey, "validation receipt attemptKey") !== selection.attemptKey ||
    input.repository !== selection.input.repository ||
    integer(input.prNumber, "validation receipt prNumber") !== selection.input.prNumber ||
    boundedString(input.headRef, "validation receipt headRef", 255) !==
      selection.input.pullRequest.headRef ||
    sha(input.sourceHeadSha, "validation receipt sourceHeadSha") !==
      selection.input.sourceHeadSha ||
    sha(input.baseSha, "validation receipt baseSha") !== selection.input.baseSha ||
    canonicalJson(input.advisor) !== canonicalJson(selection.input.advisor) ||
    canonicalJson(input.productScope) !== canonicalJson(selection.input.productScope) ||
    canonicalJson(input.optIn) !== canonicalJson(selection.input.optIn)
  ) {
    throw new RepairContractError("validation receipt identity differs from selection");
  }
  const findingIds = sortedUniqueStrings(input.findingIds, "validation receipt findingIds").map(
    (item, index) => findingId(item, `validation receipt findingIds[${index}]`),
  );
  if (
    findingIds.length !== selection.selectedFindingIds.length ||
    findingIds.some((item, index) => item !== selection.selectedFindingIds[index])
  ) {
    throw new RepairContractError("validation receipt finding set differs from selection");
  }
  const patchSha256 = boundedString(input.patchSha256, "validation receipt patchSha256", 64);
  if (!/^[0-9a-f]{64}$/u.test(patchSha256) || patchSha256 !== sha256(patch)) {
    throw new RepairContractError("validation receipt patch digest is invalid");
  }
  const candidateTreeSha = sha(input.candidateTreeSha, "validation receipt candidateTreeSha");
  if (
    !Array.isArray(input.changedPaths) ||
    input.changedPaths.length < 1 ||
    input.changedPaths.length > MAX_CHANGED_FILES
  ) {
    throw new RepairContractError(
      "validation receipt changed paths must be a bounded non-empty array",
    );
  }
  const changedPaths = input.changedPaths.map((value, index): ChangedPath => {
    const changed = record(value, `validation receipt changedPaths[${index}]`);
    exactKeys(
      changed,
      ["path", "status", "mode", "type", "bytes"],
      `validation receipt changedPaths[${index}]`,
    );
    const changedPath = boundedString(
      changed.path,
      `validation receipt changedPaths[${index}].path`,
      512,
    );
    if (!selection.selectedPaths.includes(changedPath)) {
      throw new RepairContractError("validation receipt changed a path outside selection");
    }
    if (
      !/^[ADM]$/u.test(String(changed.status)) ||
      changed.mode !== "100644" ||
      changed.type !== "blob"
    ) {
      throw new RepairContractError("validation receipt contains an unsupported Git object");
    }
    if (
      !Number.isSafeInteger(changed.bytes) ||
      Number(changed.bytes) < 0 ||
      Number(changed.bytes) > MAX_CHANGED_FILE_BYTES
    ) {
      throw new RepairContractError("validation receipt changed-file size is invalid");
    }
    return {
      path: changedPath,
      status: changed.status as ChangedPath["status"],
      mode: "100644",
      type: "blob",
      bytes: Number(changed.bytes),
    };
  });
  const paths = changedPaths.map(({ path: changedPath }) => changedPath);
  if (
    new Set(paths).size !== paths.length ||
    paths.some((item, index) => item !== [...paths].sort()[index])
  ) {
    throw new RepairContractError("validation receipt changed paths must be sorted and unique");
  }
  const validation = record(input.validation, "validation receipt validation");
  exactKeys(
    validation,
    ["candidateDigestBefore", "candidateDigestAfter", "commands"],
    "validation receipt validation",
  );
  const candidateDigestBefore = digest(
    validation.candidateDigestBefore,
    "validation receipt candidateDigestBefore",
  );
  const candidateDigestAfter = digest(
    validation.candidateDigestAfter,
    "validation receipt candidateDigestAfter",
  );
  if (candidateDigestBefore !== candidateDigestAfter) {
    throw new RepairContractError("validation receipt reports candidate mutation");
  }
  if (
    !Array.isArray(validation.commands) ||
    validation.commands.length < 1 ||
    validation.commands.length > 12
  ) {
    throw new RepairContractError("validation receipt commands must be a bounded non-empty array");
  }
  const commands = validation.commands.map((value, index): ValidationCommand => {
    const command = record(value, `validation receipt commands[${index}]`);
    exactKeys(command, ["argv", "exitCode"], `validation receipt commands[${index}]`);
    if (!Array.isArray(command.argv) || command.argv.length < 1 || command.argv.length > 16) {
      throw new RepairContractError("validation receipt command argv is invalid");
    }
    const argv = command.argv.map((argument, argumentIndex) =>
      boundedString(argument, `validation receipt commands[${index}].argv[${argumentIndex}]`, 256),
    );
    if (!Number.isSafeInteger(command.exitCode) || Number(command.exitCode) !== 0) {
      throw new RepairContractError("validation receipt contains a failed command");
    }
    return { argv, exitCode: 0 };
  });
  return {
    version: 1,
    attemptKey: selection.attemptKey,
    repository: CANONICAL_REPOSITORY,
    prNumber: selection.input.prNumber,
    headRef: selection.input.pullRequest.headRef,
    sourceHeadSha: selection.input.sourceHeadSha,
    baseSha: selection.input.baseSha,
    advisor: selection.input.advisor,
    findingIds,
    patchSha256,
    candidateTreeSha,
    changedPaths,
    validation: { candidateDigestBefore, candidateDigestAfter, commands },
    productScope: selection.input.productScope,
    optIn: selection.input.optIn,
    outcome: "validated",
    reason: null,
  };
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
  return raw
    .replace(DIAGNOSTIC_URL_PATTERN, redactDiagnosticUrl)
    .replace(/[\u0000-\u001f\u007f]+/gu, " ")
    .replace(
      /\b(?:ghp_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,}|nvapi-[A-Za-z0-9_-]{20,}|sk-[A-Za-z0-9_-]{20,})\b/gu,
      "[REDACTED]",
    )
    .replace(/\b(token|secret|password|api[_-]?key)\s*[:=]\s*\S+/giu, "$1=[REDACTED]")
    .trim()
    .slice(0, 1000);
}
